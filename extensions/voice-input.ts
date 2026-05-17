import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "..");
const PRIVATE_CONFIG_PATH = path.join(homedir(), ".pi", "agent", "voice-input.env");
const VOLC_API_KEY_URL = "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default";
const DEFAULT_SHORTCUT = Key.ctrlShift("r");
const DEFAULT_POSTPROCESS_MODEL = "deepseek/deepseek-v4-flash";
const POSTPROCESS_SYSTEM_PROMPT = `你是 pi 语音输入插件的语音识别后处理器。你的唯一任务是把原始 ASR 文本改写为可直接提交给编码智能体的用户指令。

规则：
- 只输出优化后的用户指令正文，不要输出解释、标题、前后缀、引号、代码围栏或寒暄。
- 结合上下文理解省略指代、当前任务、文件/项目名称和用户意图；上下文仅用于理解，不要重复上下文内容，除非原始语音明确要求引用或修改它。
- 修正明显的语音识别错误、同音/近音错误、断句和标点错误；保留代码标识符、命令、路径、URL、模型名、包名和专有名词。
- 如果用户口误后自我更正（例如“不是……是……”“不对……”“算了改成……”），只保留更正后的正确指令，删除错误说法和更正过程。
- 让结果完整、符合逻辑、指令明确、有指导性；必要时拆成条目或步骤。
- 不要凭空添加原始语音没有表达的新需求；不确定时保留原意并用更清晰的措辞表达。
- 输出语言通常与原始语音一致。`;

const MSG_TYPE_CLIENT_FULL_REQUEST = 0b0001;
const MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_TYPE_SERVER_FULL_RESPONSE = 0b1001;
const MSG_TYPE_SERVER_ERROR_RESPONSE = 0b1111;
const FLAG_POS_SEQUENCE = 0b0001;
const FLAG_NEG_WITH_SEQUENCE = 0b0011;
const SERIALIZATION_NONE = 0b0000;
const SERIALIZATION_JSON = 0b0001;
const COMPRESSION_GZIP = 0b0001;

type EnvMap = Record<string, string>;

type VoiceConfig = {
  apiKey: string;
  wsUrl: string;
  resourceId: string;
  language: string;
  uid: string;
  prompt: string;
  segmentMs: number;
  requestTimeoutMs: number;
  finalizeDelayMs: number;
  recorderTarget: string;
  recordingsDir: string;
  statePath: string;
  logDir: string;
  shortcut: string;
  enableItn: boolean;
  enablePunc: boolean;
  enableDdc: boolean;
  showUtterances: boolean;
  postprocessEnabled: boolean;
  postprocessModel: string;
  postprocessTimeoutMs: number;
  postprocessMaxTokens: number;
  postprocessContextChars: number;
};

type RecordingState = {
  pid: number;
  path: string;
  logPath: string;
  startedAt: string;
  recorderTarget?: string;
};

type DecodedFrame = {
  messageType: number;
  sequence: number | null;
  isLast: boolean;
  payload: unknown;
};

type TranscriptionResult = {
  text: string;
  durationMs: number;
  packets: number;
  timings: {
    wsOpenMs: number;
    sendMs: number;
    waitMs: number;
    totalMs: number;
  };
};

function parseEnvText(text: string): EnvMap {
  const env: EnvMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadEnvFiles(): EnvMap {
  const candidates = [
    PRIVATE_CONFIG_PATH,
    path.join(PACKAGE_ROOT, ".env"),
    path.join(process.cwd(), ".env"),
  ];
  const merged: EnvMap = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    Object.assign(merged, parseEnvText(readFileSync(file, "utf8")));
  }
  return merged;
}

function setting(env: EnvMap, name: string, fallback = ""): string {
  const value = process.env[name] ?? env[name];
  return value == null ? fallback : value;
}

function settingAny(env: EnvMap, names: string[], fallback = ""): string {
  for (const name of names) {
    const value = process.env[name] ?? env[name];
    if (value != null && value !== "") return value;
  }
  return fallback;
}

function boolSetting(env: EnvMap, name: string, fallback: boolean): boolean {
  const raw = setting(env, name, fallback ? "true" : "false").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function numberSetting(env: EnvMap, name: string, fallback: number): number {
  const raw = setting(env, name, String(fallback)).trim();
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function resolvePath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function getConfig(): VoiceConfig {
  const env = loadEnvFiles();
  const defaultHome = path.join(homedir(), ".pi", "agent", "voice-input");
  const voiceHome = resolvePath(setting(env, "VOICE_INPUT_HOME", defaultHome), process.cwd());

  return {
    apiKey: settingAny(env, ["VOLC_API_KEY", "VOLCENGINE_API_KEY", "DOUBAO_ASR_API_KEY"]).trim(),
    wsUrl: setting(env, "VOLC_WS_URL", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream").trim(),
    resourceId: setting(env, "VOLC_STREAM_RESOURCE_ID", "volc.seedasr.sauc.duration").trim(),
    language: settingAny(env, ["ASR_LANGUAGE", "VOLC_ASR_LANGUAGE"], "").trim(),
    uid: setting(env, "ASR_UID", "pi-voice-input").trim(),
    prompt: setting(env, "ASR_PROMPT", "").trim(),
    segmentMs: clamp(Math.round(numberSetting(env, "STREAM_SEGMENT_MS", 5000)), 100, 20000),
    requestTimeoutMs: clamp(Math.round(numberSetting(env, "ASR_REQUEST_TIMEOUT_MS", 90000)), 1000, 10 * 60 * 1000),
    finalizeDelayMs: clamp(numberSetting(env, "RECORDING_FINALIZE_DELAY", 0.1) * 1000, 0, 5000),
    recorderTarget: setting(env, "RECORDER_TARGET", "").trim(),
    recordingsDir: resolvePath(setting(env, "RECORDINGS_DIR", "recordings"), voiceHome),
    statePath: resolvePath(setting(env, "RECORDER_STATE", "recording.json"), voiceHome),
    logDir: resolvePath(setting(env, "RECORDER_LOG_DIR", "logs"), voiceHome),
    shortcut: setting(env, "VOICE_INPUT_SHORTCUT", DEFAULT_SHORTCUT).trim() || DEFAULT_SHORTCUT,
    enableItn: boolSetting(env, "ENABLE_ITN", true),
    enablePunc: boolSetting(env, "ENABLE_PUNC", true),
    enableDdc: boolSetting(env, "ENABLE_DDC", false),
    showUtterances: boolSetting(env, "SHOW_UTTERANCES", false),
    postprocessEnabled: boolSetting(env, "VOICE_POSTPROCESS_ENABLED", true),
    postprocessModel: setting(env, "VOICE_POSTPROCESS_MODEL", DEFAULT_POSTPROCESS_MODEL).trim() || DEFAULT_POSTPROCESS_MODEL,
    postprocessTimeoutMs: clamp(
      Math.round(numberSetting(env, "VOICE_POSTPROCESS_TIMEOUT_MS", 30000)),
      1000,
      10 * 60 * 1000,
    ),
    postprocessMaxTokens: clamp(Math.round(numberSetting(env, "VOICE_POSTPROCESS_MAX_TOKENS", 2048)), 128, 32768),
    postprocessContextChars: clamp(Math.round(numberSetting(env, "VOICE_POSTPROCESS_CONTEXT_CHARS", 6000)), 0, 50000),
  };
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function writePrivateEnvValue(name: string, value: string) {
  if (/\r|\n/.test(value)) throw new Error(`${name} must be a single-line value`);
  ensureDir(path.dirname(PRIVATE_CONFIG_PATH));

  const original = existsSync(PRIVATE_CONFIG_PATH) ? readFileSync(PRIVATE_CONFIG_PATH, "utf8") : "";
  const lines = original ? original.split(/\r?\n/) : [];
  const replacement = `${name}=${envValue(value)}`;
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (new RegExp(`^\\s*${name}\\s*=`).test(line)) {
      replaced = true;
      return replacement;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push("# Managed by pi-voice-input. You can also update this with /voice key.");
    nextLines.push(replacement);
  }

  writeFileSync(PRIVATE_CONFIG_PATH, nextLines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(PRIVATE_CONFIG_PATH, 0o600);
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function recorderCommand(config: VoiceConfig, outputPath: string): string[] {
  if (commandExists("pw-record")) {
    const cmd = ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16"];
    if (config.recorderTarget) cmd.push("--target", config.recorderTarget);
    cmd.push(outputPath);
    return cmd;
  }
  if (commandExists("arecord")) {
    return ["arecord", "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", outputPath];
  }
  throw new Error("No recorder found. Install PipeWire tools (pw-record) or alsa-utils (arecord).");
}

function readState(config: VoiceConfig): RecordingState | null {
  if (!existsSync(config.statePath)) return null;
  return JSON.parse(readFileSync(config.statePath, "utf8")) as RecordingState;
}

function writeState(config: VoiceConfig, state: RecordingState) {
  ensureDir(path.dirname(config.statePath));
  writeFileSync(config.statePath, JSON.stringify(state, null, 2));
}

function clearState(config: VoiceConfig) {
  try {
    unlinkSync(config.statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcessGroup(pid: number, waitMs = 1500) {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGKILL"];
  for (const signal of signals) {
    if (!pidAlive(pid)) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // ignore
      }
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await sleep(50);
    }
  }
}

function bufferFromWsData(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBufferLike);
}

function wsHeader(messageType: number, flags: number, serialization: number, compression: number): Buffer {
  return Buffer.from([
    (0b0001 << 4) | 0b0001,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0,
  ]);
}

function wsFullClientRequest(sequence: number, payload: unknown): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const meta = Buffer.alloc(8);
  meta.writeInt32BE(sequence, 0);
  meta.writeUInt32BE(body.length, 4);
  return Buffer.concat([
    wsHeader(MSG_TYPE_CLIENT_FULL_REQUEST, FLAG_POS_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP),
    meta,
    body,
  ]);
}

function wsAudioRequest(sequence: number, audio: Buffer, isLast: boolean): Buffer {
  const body = gzipSync(audio);
  const meta = Buffer.alloc(8);
  meta.writeInt32BE(isLast ? -sequence : sequence, 0);
  meta.writeUInt32BE(body.length, 4);
  return Buffer.concat([
    wsHeader(
      MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST,
      isLast ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE,
      SERIALIZATION_NONE,
      COMPRESSION_GZIP,
    ),
    meta,
    body,
  ]);
}

function wsDecodePayload(serialization: number, compression: number, payload: Buffer): unknown {
  const decoded = compression === COMPRESSION_GZIP && payload.length > 0 ? gunzipSync(payload) : payload;
  if (serialization === SERIALIZATION_JSON && decoded.length > 0) {
    return JSON.parse(decoded.toString("utf8"));
  }
  return decoded;
}

function parseServerFrame(data: WebSocket.RawData): DecodedFrame {
  const msg = bufferFromWsData(data);
  if (msg.length < 4) throw new Error("Invalid ASR frame: header too short");

  const headerSize = msg[0] & 0x0f;
  const messageType = msg[1] >> 4;
  const flags = msg[1] & 0x0f;
  const serialization = msg[2] >> 4;
  const compression = msg[2] & 0x0f;
  let offset = headerSize * 4;

  let sequence: number | null = null;
  const isLast = Boolean(flags & 0b0010);
  if (flags & 0b0001) {
    sequence = msg.readInt32BE(offset);
    offset += 4;
  }

  if (messageType === MSG_TYPE_SERVER_FULL_RESPONSE) {
    const payloadSize = msg.readUInt32BE(offset);
    offset += 4;
    const payload = msg.subarray(offset, offset + payloadSize);
    return {
      messageType,
      sequence,
      isLast,
      payload: wsDecodePayload(serialization, compression, payload),
    };
  }

  if (messageType === MSG_TYPE_SERVER_ERROR_RESPONSE) {
    const errorCode = msg.readInt32BE(offset);
    offset += 4;
    const payloadSize = msg.readUInt32BE(offset);
    offset += 4;
    const payload = msg.subarray(offset, offset + payloadSize);
    let detail: unknown;
    try {
      detail = wsDecodePayload(serialization, compression, payload);
    } catch {
      detail = payload.toString("utf8");
    }
    throw new Error(`Volcengine ASR protocol error ${errorCode}: ${JSON.stringify(detail)}`);
  }

  return { messageType, sequence, isLast, payload: null };
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as { result?: { text?: unknown; utterances?: Array<{ text?: unknown }> } };
  if (typeof root.result?.text === "string" && root.result.text) return root.result.text;
  if (Array.isArray(root.result?.utterances)) {
    return root.result.utterances.map((u) => (typeof u.text === "string" ? u.text : "")).join("").trim();
  }
  return "";
}

function sendWs(ws: WebSocket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(frame, { binary: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function parseRecordedWav(filePath: string): { pcm: Buffer; durationMs: number } {
  const wav = readFileSync(filePath);
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Recording is not a WAV file: ${filePath}`);
  }

  let offset = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, wav.length);

    if (id === "fmt ") {
      fmt = {
        format: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(start, end);
    }

    offset = start + size + (size % 2);
  }

  if (!fmt || !data) throw new Error(`Incomplete WAV recording: ${filePath}`);
  const isPcm = fmt.format === 1 || fmt.format === 0xfffe;
  if (!isPcm || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) {
    throw new Error(
      `Expected 16kHz mono 16-bit PCM WAV, got format=${fmt.format} channels=${fmt.channels} rate=${fmt.rate} bits=${fmt.bits}`,
    );
  }

  return { pcm: data, durationMs: Math.round((data.length / (16000 * 2)) * 1000) };
}

function missingCredentialsMessage(): string {
  return [
    "Missing VOLC_API_KEY for the current VolcEngine ASR provider.",
    "Run /voice key and paste your VolcEngine Speech API key.",
    `Get/create the key here: ${VOLC_API_KEY_URL}`,
    "Run /voice config to verify whether the key is detected.",
  ].join("\n");
}

async function transcribePcm(pcm: Buffer, durationMs: number, config: VoiceConfig): Promise<TranscriptionResult> {
  if (!config.apiKey) {
    throw new Error(missingCredentialsMessage());
  }

  const connectId = randomUUID();
  const startedAt = Date.now();
  const ws = new WebSocket(config.wsUrl, {
    headers: {
      "X-Api-Key": config.apiKey,
      "X-Api-Resource-Id": config.resourceId,
      "X-Api-Connect-Id": connectId,
      "X-Api-Request-Id": connectId,
    },
    handshakeTimeout: 15_000,
  });

  const openStart = Date.now();
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const wsOpenMs = Date.now() - openStart;

  let finalText = "";
  let seenLast = false;
  let waitStart = 0;

  const completion = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ASR timeout after ${config.requestTimeoutMs}ms`));
      try {
        ws.close();
      } catch {
        // ignore
      }
    }, config.requestTimeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    const resolveOnce = () => {
      cleanup();
      resolve();
    };

    const rejectOnce = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const frame = parseServerFrame(data);
        const text = extractText(frame.payload);
        if (text) finalText = text;
        if (frame.isLast) {
          seenLast = true;
          resolveOnce();
        }
      } catch (error) {
        rejectOnce(error as Error);
      }
    };

    const onError = (error: Error) => rejectOnce(error);
    const onClose = (code: number, reason: Buffer) => {
      if (!seenLast) rejectOnce(new Error(`ASR WebSocket closed before final response: ${code} ${reason.toString()}`));
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });

  const audioPayload: Record<string, unknown> = {
    format: "pcm",
    codec: "raw",
    rate: 16000,
    bits: 16,
    channel: 1,
  };
  if (config.language && config.wsUrl.includes("bigmodel_nostream")) {
    audioPayload.language = config.language;
  }

  const requestPayload: Record<string, unknown> = {
    user: { uid: config.uid || "pi-voice-input" },
    audio: audioPayload,
    request: {
      model_name: "bigmodel",
      enable_itn: config.enableItn,
      enable_punc: config.enablePunc,
      enable_ddc: config.enableDdc,
      show_utterances: config.showUtterances,
      result_type: "full",
      ...(config.prompt ? { corpus: { context: config.prompt } } : {}),
    },
  };

  const sendStart = Date.now();
  let sequence = 1;
  let packets = 0;
  await sendWs(ws, wsFullClientRequest(sequence, requestPayload));
  sequence += 1;

  const segmentSize = Math.max(1, Math.floor((16000 * 2 * config.segmentMs) / 1000));
  if (pcm.length === 0) {
    await sendWs(ws, wsAudioRequest(sequence, Buffer.alloc(0), true));
    packets = 1;
  } else {
    for (let offset = 0; offset < pcm.length; offset += segmentSize) {
      const isLast = offset + segmentSize >= pcm.length;
      await sendWs(ws, wsAudioRequest(sequence, pcm.subarray(offset, offset + segmentSize), isLast));
      packets += 1;
      if (!isLast) sequence += 1;
    }
  }
  const sendMs = Date.now() - sendStart;

  waitStart = Date.now();
  await completion;
  const waitMs = Date.now() - waitStart;

  try {
    ws.close();
  } catch {
    // ignore
  }

  return {
    text: finalText,
    durationMs,
    packets,
    timings: {
      wsOpenMs,
      sendMs,
      waitMs,
      totalMs: Date.now() - startedAt,
    },
  };
}

function tailText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getEditorContext(ctx: ExtensionContext, maxChars: number): string {
  if (maxChars <= 0) return "";
  try {
    return tailText(ctx.ui.getEditorText().trim(), maxChars);
  } catch {
    return "";
  }
}

function getRecentSessionContext(ctx: ExtensionContext, maxChars: number): string {
  if (maxChars <= 0) return "";
  const lines: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textFromContent(message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`${message.role}: ${truncateText(text, 1200)}`);
  }
  return tailText(lines.slice(-8).join("\n"), maxChars);
}

function simplifyModelReference(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripThinkingSuffix(value: string): string {
  return value.replace(/:(?:off|minimal|low|medium|high|xhigh)$/i, "");
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function resolvePostprocessModel(ctx: ExtensionContext, reference: string): Model<Api> {
  const requested = stripThinkingSuffix(reference.trim());
  if (!requested) throw new Error("VOICE_POSTPROCESS_MODEL is empty");

  const models = ctx.modelRegistry.getAll();
  const lower = requested.toLowerCase();
  const simple = simplifyModelReference(requested);

  const exactCanonical = models.filter((model) => modelLabel(model).toLowerCase() === lower);
  if (exactCanonical.length === 1) return exactCanonical[0];

  const exactBare = models.filter((model) => model.id.toLowerCase() === lower || model.name.toLowerCase() === lower);
  if (exactBare.length === 1) return exactBare[0];
  if (exactBare.length > 1) {
    throw new Error(
      `Ambiguous postprocess model "${reference}". Use provider/model, e.g. ${exactBare.map(modelLabel).slice(0, 5).join(", ")}`,
    );
  }

  const exactSimple = models.filter(
    (model) =>
      simplifyModelReference(modelLabel(model)) === simple ||
      simplifyModelReference(model.id) === simple ||
      simplifyModelReference(model.name) === simple,
  );
  if (exactSimple.length === 1) return exactSimple[0];
  if (exactSimple.length > 1) {
    throw new Error(
      `Ambiguous postprocess model "${reference}". Use provider/model, e.g. ${exactSimple.map(modelLabel).slice(0, 5).join(", ")}`,
    );
  }

  const fuzzy = models.filter(
    (model) =>
      modelLabel(model).toLowerCase().includes(lower) ||
      model.id.toLowerCase().includes(lower) ||
      model.name.toLowerCase().includes(lower) ||
      simplifyModelReference(modelLabel(model)).includes(simple) ||
      simplifyModelReference(model.id).includes(simple) ||
      simplifyModelReference(model.name).includes(simple),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(
      `Ambiguous postprocess model "${reference}". Use provider/model, e.g. ${fuzzy.map(modelLabel).slice(0, 5).join(", ")}`,
    );
  }

  throw new Error(`Postprocess model "${reference}" not found. Run pi --list-models to see available models.`);
}

function extractAssistantText(message: { content: unknown }): string {
  return textFromContent(message.content).trim();
}

function cleanPostprocessOutput(output: string): string {
  let text = output.trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:优化后的(?:用户)?指令|整理后的(?:用户)?指令|改写后的(?:用户)?指令)\s*[：:]\s*/u, "").trim();
  return text;
}

function buildPostprocessPrompt(ctx: ExtensionContext, rawText: string, config: VoiceConfig): string {
  const contextBudget = config.postprocessContextChars;
  const editorContext = getEditorContext(ctx, Math.floor(contextBudget / 2));
  const sessionContext = getRecentSessionContext(ctx, Math.ceil(contextBudget / 2));

  return [
    "请根据上下文优化下面的原始语音识别结果。",
    "如果上下文为空，直接依据原始文本优化。",
    "不要重复上下文本身；只输出原始语音对应的最终用户指令。",
    "",
    "--- 上下文：当前编辑器已有内容 ---",
    editorContext || "（空）",
    "",
    "--- 上下文：最近会话 ---",
    sessionContext || "（空）",
    "",
    "--- 原始语音识别结果 ---",
    rawText.trim(),
  ].join("\n");
}

async function postprocessTranscript(ctx: ExtensionContext, rawText: string, config: VoiceConfig): Promise<string> {
  if (!config.postprocessEnabled) return rawText;

  const raw = rawText.trim();
  if (!raw) return rawText;

  const model = resolvePostprocessModel(ctx, config.postprocessModel);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Postprocess model ${modelLabel(model)} is not ready: ${auth.error}`);
  }

  const response = await completeSimple(
    model,
    {
      systemPrompt: POSTPROCESS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildPostprocessPrompt(ctx, raw, config),
          timestamp: Date.now(),
        },
      ],
      tools: [],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      temperature: 0,
      maxTokens: config.postprocessMaxTokens,
      timeoutMs: config.postprocessTimeoutMs,
      maxRetries: 0,
      cacheRetention: "none",
      signal: ctx.signal,
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Postprocess model stopped with ${response.stopReason}`);
  }

  const polished = cleanPostprocessOutput(extractAssistantText(response));
  return polished || rawText;
}

function appendToEditor(ctx: ExtensionContext, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const current = ctx.ui.getEditorText();
  const separator = current.trim().length > 0 && !current.endsWith("\n") ? "\n" : "";
  ctx.ui.setEditorText(`${current}${separator}${trimmed}`);
}

async function isRecording(config: VoiceConfig): Promise<boolean> {
  const state = readState(config);
  return Boolean(state && pidAlive(state.pid));
}

async function startRecording(ctx: ExtensionContext) {
  const config = getConfig();
  const existing = readState(config);
  if (existing && pidAlive(existing.pid)) {
    ctx.ui.notify(`Already recording: pid=${existing.pid}`, "warning");
    ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("error", "● recording"));
    return;
  }
  if (existing) clearState(config);

  ensureDir(config.recordingsDir);
  ensureDir(config.logDir);
  const outputPath = path.join(config.recordingsDir, `recording-${timestampForFilename()}.wav`);
  const logPath = path.join(config.logDir, `recording-${timestampForFilename()}.log`);
  const cmd = recorderCommand(config, outputPath);

  ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("warning", "● starting mic"));
  const logFd = openSync(logPath, "a");
  const child = spawn(cmd[0], cmd.slice(1), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  if (!child.pid) throw new Error("Recorder failed to start: no pid returned");
  writeState(config, {
    pid: child.pid,
    path: outputPath,
    logPath,
    startedAt: new Date().toISOString(),
    recorderTarget: config.recorderTarget || undefined,
  });

  ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("error", "● recording"));
  ctx.ui.notify("Voice recording started. Press Ctrl+Shift+R again to stop/transcribe.", "info");
}

async function stopRecording(ctx: ExtensionContext, transcribe = true) {
  const config = getConfig();
  const state = readState(config);
  if (!state) {
    ctx.ui.setStatus("voice-input", undefined);
    ctx.ui.notify("Not recording.", "warning");
    return;
  }

  ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("warning", transcribe ? "● transcribing" : "● stopping"));
  if (pidAlive(state.pid)) await stopProcessGroup(state.pid);
  clearState(config);
  if (config.finalizeDelayMs > 0) await sleep(config.finalizeDelayMs);

  if (!existsSync(state.path) || statSync(state.path).size === 0) {
    const log = existsSync(state.logPath) ? readFileSync(state.logPath, "utf8") : "";
    throw new Error(`Recording file missing/empty: ${state.path}\nRecorder log:\n${log}`);
  }

  if (!transcribe) {
    ctx.ui.setStatus("voice-input", undefined);
    ctx.ui.notify(`Voice recording stopped: ${state.path}`, "info");
    return;
  }

  const decodeStart = Date.now();
  const { pcm, durationMs } = parseRecordedWav(state.path);
  const decodeMs = Date.now() - decodeStart;
  const result = await transcribePcm(pcm, durationMs, config);

  if (!result.text.trim()) {
    ctx.ui.setStatus("voice-input", undefined);
    ctx.ui.notify(
      `Transcription finished but no text was returned. audio=${(durationMs / 1000).toFixed(2)}s total=${result.timings.totalMs}ms`,
      "warning",
    );
    return;
  }

  let finalText = result.text;
  let postprocessMs = 0;
  let postprocessUsed = false;
  if (config.postprocessEnabled) {
    ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("warning", "● polishing"));
    const postprocessStart = Date.now();
    try {
      finalText = await postprocessTranscript(ctx, result.text, config);
      postprocessMs = Date.now() - postprocessStart;
      postprocessUsed = finalText.trim() !== result.text.trim();
    } catch (error) {
      postprocessMs = Date.now() - postprocessStart;
      ctx.ui.notify(
        `Voice postprocess failed; inserting raw transcript. ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  ctx.ui.setStatus("voice-input", undefined);
  appendToEditor(ctx, finalText);
  ctx.ui.notify(
    `Voice text inserted. audio=${(durationMs / 1000).toFixed(2)}s decode=${decodeMs}ms asr=${result.timings.totalMs}ms${
      config.postprocessEnabled ? ` postprocess=${postprocessMs}ms${postprocessUsed ? " polished" : ""}` : ""
    } packets=${result.packets}`,
    "info",
  );
}

async function toggleRecording(ctx: ExtensionContext) {
  if (!ctx.hasUI) {
    ctx.ui.notify("voice input requires interactive pi UI", "error");
    return;
  }
  const config = getConfig();
  if (await isRecording(config)) await stopRecording(ctx, true);
  else await startRecording(ctx);
}

function setupHelp(config = getConfig()): string {
  return [
    "pi Voice Input setup:",
    "- Current provider: VolcEngine WebSocket ASR",
    `- API key: ${config.apiKey ? "set" : "missing"}`,
    "- To save/update the key, run: /voice key",
    `- Postprocess: ${config.postprocessEnabled ? "enabled" : "disabled"} (${config.postprocessModel})`,
    `- Get/create a VolcEngine Speech API key here: ${VOLC_API_KEY_URL}`,
    "- After saving the key, run: /voice config",
  ].join("\n");
}

async function configureApiKey(ctx: ExtensionContext, providedKey = "") {
  let apiKey = providedKey.trim();

  if (!apiKey) {
    if (!ctx.hasUI) {
      ctx.ui.notify(`Run /voice key in interactive pi, or get a key from ${VOLC_API_KEY_URL} and set VOLC_API_KEY.`, "error");
      return;
    }
    ctx.ui.notify(`Get/create a VolcEngine Speech API key here:\n${VOLC_API_KEY_URL}`, "info");
    const current = getConfig().apiKey;
    const placeholder = current ? "Paste a new VolcEngine API key (current key is already set)" : "Paste VOLC_API_KEY";
    apiKey = (await ctx.ui.input("VolcEngine API key", placeholder))?.trim() ?? "";
  }

  if (!apiKey) {
    ctx.ui.notify("API key unchanged.", "warning");
    return;
  }

  writePrivateEnvValue("VOLC_API_KEY", apiKey);
  ctx.ui.notify("VolcEngine API key saved for pi voice input. Run /voice config to verify it is detected.", "info");
}

function configSummary(config: VoiceConfig): string {
  return [
    "Voice input config:",
    `- api key: ${config.apiKey ? "set" : "missing"} (update with /voice key)`,
    `- ws url: ${config.wsUrl}`,
    `- resource id: ${config.resourceId}`,
    `- language: ${config.language || "auto"}`,
    `- recorder target: ${config.recorderTarget || "PipeWire/default"}`,
    `- segment: ${config.segmentMs}ms`,
    `- recordings: ${config.recordingsDir}`,
    `- state: ${config.statePath}`,
    `- shortcut: ${config.shortcut}`,
    `- postprocess: ${config.postprocessEnabled ? "enabled" : "disabled"}`,
    `- postprocess model: ${config.postprocessModel}`,
    "- postprocess thinking: off",
    `- postprocess timeout: ${config.postprocessTimeoutMs}ms`,
    "Run /voice key to save/update the current provider API key.",
    `VolcEngine API key URL: ${VOLC_API_KEY_URL}`,
    "Config files checked: ~/.pi/agent/voice-input.env, package .env, current .env; shell env overrides them.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const startupConfig = getConfig();

  pi.registerShortcut(startupConfig.shortcut as ReturnType<typeof Key.ctrlShift>, {
    description: "Toggle voice recording and insert transcription into editor",
    handler: async (ctx) => {
      try {
        await toggleRecording(ctx);
      } catch (error) {
        ctx.ui.setStatus("voice-input", undefined);
        ctx.ui.notify(`Voice input error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("voice", {
    description: "Voice input: start | stop | status | toggle | cancel | config | key | help",
    handler: async (args, ctx) => {
      const input = (args || "toggle").trim();
      const action = (input.split(/\s+/, 1)[0] || "toggle").toLowerCase();
      const rest = input.slice(action.length).trim();
      try {
        if (action === "start") {
          await startRecording(ctx);
          return;
        }
        if (action === "stop") {
          await stopRecording(ctx, true);
          return;
        }
        if (action === "cancel") {
          await stopRecording(ctx, false);
          return;
        }
        if (action === "status") {
          const config = getConfig();
          const state = readState(config);
          ctx.ui.notify(JSON.stringify({ recording: Boolean(state && pidAlive(state.pid)), state }, null, 2), "info");
          return;
        }
        if (action === "config") {
          ctx.ui.notify(configSummary(getConfig()), "info");
          return;
        }
        if (["key", "api-key", "apikey", "setup", "configure"].includes(action)) {
          await configureApiKey(ctx, rest);
          return;
        }
        if (["help", "doctor"].includes(action)) {
          ctx.ui.notify(setupHelp(getConfig()), "info");
          return;
        }
        if (action === "toggle" || action === "") {
          await toggleRecording(ctx);
          return;
        }
        ctx.ui.notify("Usage: /voice start | stop | status | toggle | cancel | config | key | help", "error");
      } catch (error) {
        ctx.ui.setStatus("voice-input", undefined);
        ctx.ui.notify(`Voice command error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (getConfig().apiKey) {
      ctx.ui.notify(`Voice input loaded: ${startupConfig.shortcut} toggles recording.`, "info");
      return;
    }
    ctx.ui.notify(
      [
        `Voice input loaded: ${startupConfig.shortcut} toggles recording.`,
        "API key is missing. Run /voice key to set it up.",
        `Get/create a VolcEngine Speech API key here: ${VOLC_API_KEY_URL}`,
      ].join("\n"),
      "warning",
    );
  });
}
