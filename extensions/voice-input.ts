import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "voice-input.config.json");
const VOLC_API_KEY_URL = "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default";
const DEFAULT_SHORTCUT = Key.ctrlShift("r");
const DEFAULT_POSTPROCESS_MODEL = "";
const POSTPROCESS_SYSTEM_PROMPT = `You are the speech-recognition postprocessor for the pi voice input extension. Your only job is to polish the raw ASR text into text that the plugin can paste verbatim at the current cursor position in the pi editor.

Interaction contract:
- The plugin does not replace editor content with your output. It only pastes/inserts your output at the user's current cursor position.
- The current editor draft and recent conversation are context only. Use them to understand omitted references, the current task, file/project names, and intent. They are not text for you to rewrite and output as a whole.
- Do not output the draft, a context sentence, or a full sentence/paragraph that represents the draft after insertion. Doing so would duplicate existing editor content.
- You may not know the real cursor position. Do not guess the cursor location and synthesize a full surrounding sentence; the editor owns the real insertion point.
- If the raw speech is adding a few words, half a sentence, a phrase, a condition, or a modifier, output only those newly spoken words. Let the paste operation merge them with the existing draft.
- Only when the raw speech itself explicitly dictates a complete passage to insert may you output that complete passage. Even then, do not add draft text that the user did not speak.

Rules:
- Output only the polished insertion text. Do not output explanations, headings, prefixes, suffixes, quotes, code fences, or greetings.
- Never answer, execute, or solve anything asked in the user's speech. If the raw speech is a question, only clean up the question text itself; do not provide an answer, plan, code, or conclusion.
- Preserve the user's information faithfully. Do not over-summarize or compress. Do not delete constraints, examples, numbers, filenames, errors, multiple requests, ordering, or emphasis.
- Correct obvious ASR mistakes, homophones, segmentation, and punctuation. Preserve code identifiers, commands, paths, URLs, model names, package names, and proper nouns.
- If the user self-corrects, keep only the corrected intent and remove the false start, correction process, filler, and chatter. Do not lose any other substantive information.
- Make the output complete relative to the raw speech, logically clear, and actionable. Split into items or steps when helpful, but do not drop raw-speech information or repeat existing draft text.
- Do not invent requirements that the raw speech did not express. If uncertain, keep the original meaning and express it more clearly.
- The output language must match the primary language of the raw speech, not the context language and not this English prompt. Do not translate just because the instructions are in English.`;

const MSG_TYPE_CLIENT_FULL_REQUEST = 0b0001;
const MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_TYPE_SERVER_FULL_RESPONSE = 0b1001;
const MSG_TYPE_SERVER_ERROR_RESPONSE = 0b1111;
const FLAG_POS_SEQUENCE = 0b0001;
const FLAG_NEG_WITH_SEQUENCE = 0b0011;
const SERIALIZATION_NONE = 0b0000;
const SERIALIZATION_JSON = 0b0001;
const COMPRESSION_GZIP = 0b0001;

type JsonObject = Record<string, unknown>;

type VoiceInputConfigFile = {
  volcApiKey: string;
  polishModel: string;
};

type VoiceConfig = {
  configPath: string;
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
  statePath: string;
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
  logPath?: string;
  startedAt: string;
  recorderTarget?: string;
  deviceName?: string;
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

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function defaultConfigFile(): VoiceInputConfigFile {
  return {
    volcApiKey: "",
    polishModel: DEFAULT_POSTPROCESS_MODEL,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(source: JsonObject, name: string, fallback: string): string {
  const value = source[name];
  return typeof value === "string" ? value : fallback;
}

function normalizeConfigFile(input: unknown): VoiceInputConfigFile {
  const defaults = defaultConfigFile();
  const root = isObject(input) ? input : {};
  return {
    volcApiKey: stringField(root, "volcApiKey", defaults.volcApiKey).trim(),
    polishModel: stringField(root, "polishModel", defaults.polishModel).trim(),
  };
}

function writeConfigFile(config: unknown) {
  ensureDir(path.dirname(CONFIG_PATH));
  writeFileSync(CONFIG_PATH, `${JSON.stringify(normalizeConfigFile(config), null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

function loadConfigFile(): VoiceInputConfigFile {
  if (!existsSync(CONFIG_PATH)) return defaultConfigFile();
  try {
    return normalizeConfigFile(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    throw new Error(`Failed to read voice input config ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getConfig(): VoiceConfig {
  const fileConfig = loadConfigFile();
  const voiceHome = path.join(homedir(), ".pi", "agent", "voice-input");
  const polishModel = fileConfig.polishModel.trim();

  return {
    configPath: CONFIG_PATH,
    apiKey: fileConfig.volcApiKey.trim(),
    wsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
    resourceId: "volc.seedasr.sauc.duration",
    language: "",
    uid: "pi-voice-input",
    prompt: "",
    segmentMs: 5000,
    requestTimeoutMs: 90000,
    finalizeDelayMs: 100,
    recorderTarget: "",
    statePath: path.join(voiceHome, "recording.json"),
    shortcut: DEFAULT_SHORTCUT,
    enableItn: true,
    enablePunc: true,
    enableDdc: false,
    showUtterances: false,
    postprocessEnabled: polishModel.length > 0,
    postprocessModel: polishModel,
    postprocessTimeoutMs: 30000,
    postprocessMaxTokens: 2048,
    postprocessContextChars: 6000,
  };
}

function ensureConfigFile(): boolean {
  const existed = existsSync(CONFIG_PATH);
  writeConfigFile(loadConfigFile());
  return !existed;
}

function writeConfigApiKey(apiKey: string) {
  if (/\r|\n/.test(apiKey)) throw new Error("volcApiKey must be a single-line value");
  const config = loadConfigFile();
  config.volcApiKey = apiKey.trim();
  writeConfigFile(config);
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function commandOutput(command: string, args: string[], timeoutMs = 1500): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function selectRecorderExecutable(): string {
  if (platform() === "darwin" && commandExists("afrecord")) return "afrecord";
  if (commandExists("pw-record")) return "pw-record";
  if (commandExists("arecord")) return "arecord";
  return "";
}

function recorderCommand(config: VoiceConfig, outputPath: string): string[] {
  const executable = selectRecorderExecutable();
  if (executable === "pw-record") {
    const cmd = ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16"];
    if (config.recorderTarget) cmd.push("--target", config.recorderTarget);
    cmd.push(outputPath);
    return cmd;
  }
  if (executable === "arecord") {
    return ["arecord", "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", outputPath];
  }
  if (executable === "afrecord") {
    return ["afrecord", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", outputPath];
  }
  throw new Error("No recorder found. On Linux, install PipeWire tools (pw-record) or alsa-utils (arecord). On macOS, afrecord should be available with the system.");
}

type PipeWireSource = {
  id: string;
  name: string;
  description: string;
};

function parsePactlSources(text: string): PipeWireSource[] {
  const sources: PipeWireSource[] = [];
  let current: PipeWireSource | null = null;
  for (const line of text.split(/\r?\n/)) {
    const sourceMatch = line.match(/^Source #(\S+)/);
    if (sourceMatch) {
      if (current) sources.push(current);
      current = { id: sourceMatch[1], name: "", description: "" };
      continue;
    }
    if (!current) continue;
    const nameMatch = line.match(/^\s*Name:\s*(.+)$/);
    if (nameMatch) {
      current.name = nameMatch[1].trim();
      continue;
    }
    const descriptionMatch = line.match(/^\s*Description:\s*(.+)$/);
    if (descriptionMatch) current.description = descriptionMatch[1].trim();
  }
  if (current) sources.push(current);
  return sources;
}

function wpctlProperty(text: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|\\n)\\s*\\*?\\s*${escaped}\\s*=\\s*"([^"]+)"`));
  return match?.[1]?.trim() ?? "";
}

function inspectPipeWireSource(target: string): string {
  if (!commandExists("wpctl")) return "";
  const inspect = commandOutput("wpctl", ["inspect", target]);
  return (
    wpctlProperty(inspect, "node.description") ||
    wpctlProperty(inspect, "node.nick") ||
    wpctlProperty(inspect, "node.name")
  );
}

function defaultPipeWireSourceFromStatus(): string {
  if (!commandExists("wpctl")) return "";
  const status = commandOutput("wpctl", ["status"]);
  let inSources = false;
  for (const line of status.split(/\r?\n/)) {
    if (/Sources:/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources && /^\s*[├└]─/.test(line)) break;
    if (!inSources) continue;
    const match = line.match(/^\s*│\s+\*\s+\d+\.\s+(.+?)(?:\s+\[|$)/);
    if (match) return match[1].trim();
  }
  return "";
}

function pipeWireSourceName(target: string): string {
  const sources = commandExists("pactl") ? parsePactlSources(commandOutput("pactl", ["list", "sources"])) : [];

  if (!target) {
    const defaultName = commandExists("pactl") ? commandOutput("pactl", ["get-default-source"]) : "";
    const source = sources.find((item) => item.name === defaultName);
    return (
      source?.description ||
      source?.name ||
      inspectPipeWireSource("@DEFAULT_SOURCE@") ||
      defaultPipeWireSourceFromStatus() ||
      defaultName ||
      "default microphone"
    );
  }

  const source = sources.find((item) => item.id === target || item.name === target || item.description === target);
  return source?.description || source?.name || (/^\d+$/.test(target) ? inspectPipeWireSource(target) : "") || target;
}

function recordingDeviceName(config: VoiceConfig, recorderExecutable: string): string {
  if (recorderExecutable === "pw-record") return pipeWireSourceName(config.recorderTarget);
  if (recorderExecutable === "arecord") return "ALSA default microphone";
  if (recorderExecutable === "afrecord") return "macOS default microphone";
  return config.recorderTarget || "default microphone";
}

function recordingStatusText(deviceName: string): string {
  return `● Mic on: ${deviceName || "default microphone"} — press Ctrl+Shift+R again to stop/transcribe`;
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

function createRecordingPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-voice-input-"));
  chmodSync(dir, 0o700);
  return path.join(dir, `recording-${timestampForFilename()}.wav`);
}

function deleteFileIfExists(filePath?: string): string | null {
  if (!filePath) return null;
  try {
    unlinkSync(filePath);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `failed to delete ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function deleteTemporaryRecordingDir(filePath: string): string | null {
  const dir = path.dirname(filePath);
  const parent = path.dirname(dir);
  if (path.resolve(parent) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith("pi-voice-input-")) {
    return null;
  }

  try {
    rmdirSync(dir);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return `failed to remove temporary directory ${dir}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function cleanupRecordingArtifacts(state: Pick<RecordingState, "path" | "logPath">): string[] {
  return [deleteFileIfExists(state.path), deleteFileIfExists(state.logPath), deleteTemporaryRecordingDir(state.path)].filter(
    (message): message is string => Boolean(message),
  );
}

function cleanupLegacyDirectory(dir: string, filePattern: RegExp, protectedPaths: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const warnings: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !filePattern.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    if (protectedPaths.has(path.resolve(filePath))) continue;
    const warning = deleteFileIfExists(filePath);
    if (warning) warnings.push(warning);
  }

  try {
    rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      warnings.push(`failed to remove legacy directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return warnings;
}

function cleanupLegacyStoredArtifacts(config: VoiceConfig): string[] {
  const state = readState(config);
  const protectedPaths = new Set<string>();
  if (state && pidAlive(state.pid)) {
    protectedPaths.add(path.resolve(state.path));
    if (state.logPath) protectedPaths.add(path.resolve(state.logPath));
  }

  const voiceHome = path.dirname(config.statePath);
  return [
    ...cleanupLegacyDirectory(path.join(voiceHome, "recordings"), /^recording-.*\.wav$/, protectedPaths),
    ...cleanupLegacyDirectory(path.join(voiceHome, "logs"), /^recording-.*\.log$/, protectedPaths),
  ];
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
    "Missing VolcEngine API key in the pi voice input config.",
    "Run /voice key and paste your VolcEngine Speech API key.",
    `Config file: ${CONFIG_PATH}`,
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
    return tailText(ctx.ui.getEditorText(), maxChars);
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
  if (!requested) throw new Error("polishModel is empty in voice input config");

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
  text = text.replace(/^(?:polished(?: user)? instruction|refined(?: user)? instruction|rewritten(?: user)? instruction|final(?: insertion)? text)\s*:\s*/iu, "").trim();
  return text;
}

function removeEditorDraftEcho(editorText: string, output: string): string {
  const draft = editorText.trim();
  const text = output.trim();
  if (draft.length < 12 || text.length <= draft.length) return output;

  let prefixLength = 0;
  while (prefixLength < draft.length && prefixLength < text.length && draft[prefixLength] === text[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < draft.length - prefixLength &&
    suffixLength < text.length - prefixLength &&
    draft[draft.length - 1 - suffixLength] === text[text.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  if (prefixLength + suffixLength !== draft.length) return output;
  const insertedText = text.slice(prefixLength, text.length - suffixLength).trim();
  return insertedText || output;
}

function getFullEditorText(ctx: ExtensionContext): string {
  try {
    return ctx.ui.getEditorText();
  } catch {
    return "";
  }
}

function buildPostprocessPrompt(ctx: ExtensionContext, rawText: string, config: VoiceConfig): string {
  const contextBudget = config.postprocessContextChars;
  const editorContext = getEditorContext(ctx, Math.floor(contextBudget / 2));
  const sessionContext = getRecentSessionContext(ctx, Math.ceil(contextBudget / 2));

  return [
    "Polish only the raw ASR text below, using context only when it helps disambiguate the user's intent.",
    "If context is empty or irrelevant, polish the raw text directly.",
    "Do not answer the raw speech, and do not execute its request. Output only the final text that should be inserted into the editor.",
    "The output language must match the primary language of the raw speech, not the context language and not this English prompt. Do not translate.",
    "Faithfully preserve the information and details in the raw speech. Do not summarize, compress, or delete details merely for brevity.",
    "IMPORTANT: your output will be pasted verbatim at the current cursor position. It is not a replacement and not a rewrite of the whole editor draft.",
    "The current editor draft is context only. Do not rewrite, repeat, complete, delete, or replace existing draft text. Do not output the full sentence after insertion.",
    "The true cursor position is not marked in the draft shown here; the pi editor owns the actual insertion point. Do not guess the cursor and synthesize a full surrounding sentence.",
    "If the raw speech is an inline insertion, continuation, a few words, or a phrase, output only the newly spoken words or phrase.",
    "Example: draft is `Please make this function async and [cursor].`, raw speech is `add error handling`, correct output is `add error handling`, not `Please make this function async and add error handling.`.",
    "Example: draft is `This variable name is [cursor]unclear`, raw speech is `still`, correct output is `still`, not `This variable name is still unclear`.",
    "",
    "--- Context: current unsent editor draft (context only; do not output wholesale) ---",
    editorContext.trim() || "(empty)",
    "",
    "--- Context: recent conversation ---",
    sessionContext || "(empty)",
    "",
    "--- Raw ASR text ---",
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
  return polished ? removeEditorDraftEcho(getFullEditorText(ctx), polished) : rawText;
}

function insertIntoEditor(ctx: ExtensionContext, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  ctx.ui.pasteToEditor(trimmed);
}

async function isRecording(config: VoiceConfig): Promise<boolean> {
  const state = readState(config);
  return Boolean(state && pidAlive(state.pid));
}

function cleanupStaleRecordingState(config: VoiceConfig): string[] {
  const state = readState(config);
  if (!state || pidAlive(state.pid)) return [];
  const cleanupWarnings = cleanupRecordingArtifacts(state);
  clearState(config);
  return cleanupWarnings;
}

function requireInteractiveUi(ctx: ExtensionContext, action: string): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify(`Voice ${action} requires interactive pi UI. Use /voice config or /voice help for setup information.`, "error");
  return false;
}

async function startRecording(ctx: ExtensionContext) {
  if (!requireInteractiveUi(ctx, "recording")) return;
  const config = getConfig();
  const existing = readState(config);
  if (existing && pidAlive(existing.pid)) {
    const deviceName = existing.deviceName || recordingDeviceName(config, selectRecorderExecutable());
    ctx.ui.notify(`Already recording: pid=${existing.pid}. ${recordingStatusText(deviceName)}`, "warning");
    ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("accent", recordingStatusText(deviceName)));
    return;
  }
  if (existing) {
    const cleanupWarnings = cleanupRecordingArtifacts(existing);
    clearState(config);
    if (cleanupWarnings.length) ctx.ui.notify(`Voice input cleanup warning:\n${cleanupWarnings.join("\n")}`, "warning");
  }

  const outputPath = createRecordingPath();
  let cmd: string[];
  try {
    cmd = recorderCommand(config, outputPath);
  } catch (error) {
    cleanupRecordingArtifacts({ path: outputPath });
    throw error;
  }
  const deviceName = recordingDeviceName(config, cmd[0]);

  ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("warning", "● starting mic"));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd[0], cmd.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch (error) {
    cleanupRecordingArtifacts({ path: outputPath });
    throw error;
  }
  child.unref();

  if (!child.pid) {
    cleanupRecordingArtifacts({ path: outputPath });
    throw new Error("Recorder failed to start: no pid returned");
  }
  writeState(config, {
    pid: child.pid,
    path: outputPath,
    startedAt: new Date().toISOString(),
    recorderTarget: config.recorderTarget || undefined,
    deviceName,
  });

  ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("accent", recordingStatusText(deviceName)));
}

async function stopRecording(ctx: ExtensionContext, transcribe = true) {
  if (transcribe && !requireInteractiveUi(ctx, "transcription")) return;
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

  if (!transcribe) {
    const cleanupWarnings = cleanupRecordingArtifacts(state);
    ctx.ui.setStatus("voice-input", undefined);
    ctx.ui.notify(
      cleanupWarnings.length
        ? `Voice recording cancelled; local audio discard attempted, but cleanup had warnings:\n${cleanupWarnings.join("\n")}`
        : "Voice recording cancelled; local audio discarded.",
      cleanupWarnings.length ? "warning" : "info",
    );
    return;
  }

  if (!existsSync(state.path) || statSync(state.path).size === 0) {
    const cleanupWarnings = cleanupRecordingArtifacts(state);
    throw new Error(
      `Recording file missing/empty: ${state.path}. Recorder output is not persisted for privacy.${
        cleanupWarnings.length ? `\nCleanup warnings:\n${cleanupWarnings.join("\n")}` : ""
      }`,
    );
  }

  let decodeMs = 0;
  let durationMs = 0;
  let result: TranscriptionResult | undefined;
  const decodeStart = Date.now();
  try {
    const recording = parseRecordedWav(state.path);
    durationMs = recording.durationMs;
    decodeMs = Date.now() - decodeStart;
    result = await transcribePcm(recording.pcm, recording.durationMs, config);
  } finally {
    const cleanupWarnings = cleanupRecordingArtifacts(state);
    if (cleanupWarnings.length) ctx.ui.notify(`Voice input cleanup warning:\n${cleanupWarnings.join("\n")}`, "warning");
  }
  if (!result) throw new Error("Transcription failed before a result was produced");

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
  insertIntoEditor(ctx, finalText);
  ctx.ui.notify(
    `Voice text inserted. audio=${(durationMs / 1000).toFixed(2)}s decode=${decodeMs}ms asr=${result.timings.totalMs}ms${
      config.postprocessEnabled ? ` postprocess=${postprocessMs}ms${postprocessUsed ? " polished" : ""}` : ""
    } packets=${result.packets}`,
    "info",
  );
}

async function toggleRecording(ctx: ExtensionContext) {
  if (!requireInteractiveUi(ctx, "input")) return;
  const config = getConfig();
  if (await isRecording(config)) await stopRecording(ctx, true);
  else await startRecording(ctx);
}

function setupHelp(config = getConfig()): string {
  return [
    "pi Voice Input setup:",
    "- Current provider: VolcEngine WebSocket ASR",
    `- Config file: ${config.configPath}`,
    `- API key: ${config.apiKey ? "set" : "missing"}`,
    "- To create/update the JSON config file, run: /voice init",
    "- To save/update the key, run: /voice key",
    `- Polish: ${config.postprocessEnabled ? config.postprocessModel : "disabled"}`,
    `- Get/create a VolcEngine Speech API key here: ${VOLC_API_KEY_URL}`,
    "- After saving the key, run: /voice config",
  ].join("\n");
}

async function configureApiKey(ctx: ExtensionContext, providedKey = "") {
  let apiKey = providedKey.trim();

  if (!apiKey) {
    if (!ctx.hasUI) {
      ctx.ui.notify(`Run /voice key in interactive pi, or edit ${CONFIG_PATH}. Get a key from ${VOLC_API_KEY_URL}.`, "error");
      return;
    }
    ctx.ui.notify(`Get/create a VolcEngine Speech API key here:\n${VOLC_API_KEY_URL}`, "info");
    const current = getConfig().apiKey;
    const placeholder = current ? "Paste a new VolcEngine API key (current key is already set)" : "Paste VolcEngine API key";
    apiKey = (await ctx.ui.input("VolcEngine API key", placeholder))?.trim() ?? "";
  }

  if (!apiKey) {
    ctx.ui.notify("API key unchanged.", "warning");
    return;
  }

  writeConfigApiKey(apiKey);
  ctx.ui.notify(`VolcEngine API key saved in ${CONFIG_PATH}. Run /voice config to verify it is detected.`, "info");
}

function configSummary(config: VoiceConfig): string {
  const recorderExecutable = selectRecorderExecutable();
  const currentDevice = recorderExecutable ? recordingDeviceName(config, recorderExecutable) : "no recorder found";
  return [
    "Voice input config:",
    `- config file: ${config.configPath}${existsSync(config.configPath) ? "" : " (missing; run /voice init to create it)"}`,
    `- volcApiKey: ${config.apiKey ? "set" : "missing"} (update with /voice key)`,
    `- polishModel: ${config.postprocessEnabled ? config.postprocessModel : "disabled"}`,
    `- current recording device: ${currentDevice}`,
    "Config keys: volcApiKey, polishModel. Leave polishModel empty to disable polish.",
    `VolcEngine API key URL: ${VOLC_API_KEY_URL}`,
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
    description: "Voice input: start | stop | status | toggle | cancel | config | init | key | help",
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
        if (action === "init") {
          const created = ensureConfigFile();
          ctx.ui.notify(`${created ? "Created" : "Updated"} voice input config: ${CONFIG_PATH}`, "info");
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
        ctx.ui.notify("Usage: /voice start | stop | status | toggle | cancel | config | init | key | help", "error");
      } catch (error) {
        ctx.ui.setStatus("voice-input", undefined);
        ctx.ui.notify(`Voice command error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const currentConfig = getConfig();
    const cleanupWarnings = [
      ...cleanupStaleRecordingState(currentConfig),
      ...cleanupLegacyStoredArtifacts(currentConfig),
    ];
    if (cleanupWarnings.length) ctx.ui.notify(`Voice input cleanup warning:\n${cleanupWarnings.join("\n")}`, "warning");

    if (currentConfig.apiKey) {
      ctx.ui.notify(`Voice input loaded: ${startupConfig.shortcut} toggles recording.`, "info");
      return;
    }
    ctx.ui.notify(
      [
        `Voice input loaded: ${startupConfig.shortcut} toggles recording.`,
        "API key is missing. Run /voice key to set it up, or edit the JSON config file.",
        `Config file: ${currentConfig.configPath}`,
        `Get/create a VolcEngine Speech API key here: ${VOLC_API_KEY_URL}`,
      ].join("\n"),
      "warning",
    );
  });
}
