import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
// pi-bridge redirects child_process calls whose cwd is inside the bridged fake
// project directory. Audio capture and system volume control must always use
// the local machine, so force those subprocesses to a known-local cwd.
const LOCAL_AUDIO_PROCESS_CWD = homedir();
const DEFAULT_SHORTCUT = Key.ctrlShift("r");
const VOICE_TRANSCRIPT_NOTICE = [
  "以下内容来自用户通过语音输入的原始转写，可能包含语音识别错误、错别字、同音词、断句或标点不准确，以及中英文、术语、代码名、文件名误识别等问题。",
  "请明确注意：这段转写不一定完全准确。请结合上下文理解用户意图；必要时可以先澄清、翻译或推断，再继续处理。",
  "原始语音转写如下：",
].join("\n");

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
  duckSystemVolume: boolean;
  duckSystemVolumeFactor: number;
  duckSystemVolumeFadeMs: number;
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
  duckSystemVolume: boolean;
  duckSystemVolumeFactor: number;
  duckSystemVolumeFadeMs: number;
};

type SystemVolumeDuckingState = {
  provider: "macos" | "wpctl" | "pactl";
  originalVolumePercent: number;
  duckedVolumePercent: number;
  factor: number;
  fadeMs: number;
};

type RecordingState = {
  pid: number;
  path: string;
  logPath?: string;
  startedAt: string;
  recorderTarget?: string;
  deviceName?: string;
  systemVolume?: SystemVolumeDuckingState;
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
    duckSystemVolume: true,
    duckSystemVolumeFactor: 0.5,
    duckSystemVolumeFadeMs: 300,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(source: JsonObject, name: string, fallback: string): string {
  const value = source[name];
  return typeof value === "string" ? value : fallback;
}

function booleanField(source: JsonObject, name: string, fallback: boolean): boolean {
  const value = source[name];
  return typeof value === "boolean" ? value : fallback;
}

function numberField(source: JsonObject, name: string, fallback: number): number {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeConfigFile(input: unknown): VoiceInputConfigFile {
  const defaults = defaultConfigFile();
  const root = isObject(input) ? input : {};
  return {
    volcApiKey: stringField(root, "volcApiKey", defaults.volcApiKey).trim(),
    duckSystemVolume: booleanField(root, "duckSystemVolume", defaults.duckSystemVolume),
    duckSystemVolumeFactor: clamp(numberField(root, "duckSystemVolumeFactor", defaults.duckSystemVolumeFactor), 0, 1),
    duckSystemVolumeFadeMs: Math.round(clamp(numberField(root, "duckSystemVolumeFadeMs", defaults.duckSystemVolumeFadeMs), 0, 3000)),
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
    duckSystemVolume: fileConfig.duckSystemVolume,
    duckSystemVolumeFactor: fileConfig.duckSystemVolumeFactor,
    duckSystemVolumeFadeMs: fileConfig.duckSystemVolumeFadeMs,
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
  return spawnSync("sh", ["-lc", `command -v ${command}`], { cwd: LOCAL_AUDIO_PROCESS_CWD, stdio: "ignore" }).status === 0;
}

function commandOutput(command: string, args: string[], timeoutMs = 1500): string {
  const result = spawnSync(command, args, { cwd: LOCAL_AUDIO_PROCESS_CWD, encoding: "utf8", timeout: timeoutMs });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function runCommand(command: string, args: string[], timeoutMs = 1500): boolean {
  return spawnSync(command, args, { cwd: LOCAL_AUDIO_PROCESS_CWD, stdio: "ignore", timeout: timeoutMs }).status === 0;
}

function formatPercent(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function readSystemOutputVolume(): Pick<SystemVolumeDuckingState, "provider" | "originalVolumePercent"> | null {
  if (platform() === "darwin") {
    if (!commandExists("osascript")) return null;
    const output = commandOutput("osascript", ["-e", "output volume of (get volume settings)"]);
    const volume = Number(output.trim());
    return Number.isFinite(volume) ? { provider: "macos", originalVolumePercent: clamp(volume, 0, 100) } : null;
  }

  if (platform() !== "linux") return null;

  if (commandExists("wpctl")) {
    const output = commandOutput("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]);
    const match = output.match(/Volume:\s*([0-9.]+)/);
    const volume = match ? Number(match[1]) * 100 : NaN;
    if (Number.isFinite(volume)) return { provider: "wpctl", originalVolumePercent: Math.max(0, volume) };
  }

  if (commandExists("pactl")) {
    const output = commandOutput("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]);
    const match = output.match(/([0-9]+(?:\.[0-9]+)?)%/);
    const volume = match ? Number(match[1]) : NaN;
    if (Number.isFinite(volume)) return { provider: "pactl", originalVolumePercent: Math.max(0, volume) };
  }

  return null;
}

function setSystemOutputVolume(state: Pick<SystemVolumeDuckingState, "provider">, volumePercent: number): boolean {
  if (state.provider === "macos") {
    return runCommand("osascript", ["-e", `set volume output volume ${Math.round(clamp(volumePercent, 0, 100))}`]);
  }

  const safePercent = Math.max(0, volumePercent);
  if (state.provider === "wpctl") {
    return runCommand("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", `${formatPercent(safePercent)}%`]);
  }

  return runCommand("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${formatPercent(safePercent)}%`]);
}

function easeInOut(t: number): number {
  return 0.5 - Math.cos(Math.PI * clamp(t, 0, 1)) / 2;
}

async function fadeSystemOutputVolume(
  state: Pick<SystemVolumeDuckingState, "provider">,
  fromPercent: number,
  toPercent: number,
  fadeMs: number,
): Promise<string | null> {
  if (fadeMs <= 0 || Math.abs(fromPercent - toPercent) < 0.1) {
    return setSystemOutputVolume(state, toPercent) ? null : "failed to set system output volume";
  }

  const steps = Math.max(2, Math.min(20, Math.round(fadeMs / 30)));
  const intervalMs = fadeMs / steps;
  for (let step = 1; step <= steps; step += 1) {
    const eased = easeInOut(step / steps);
    const volume = fromPercent + (toPercent - fromPercent) * eased;
    if (!setSystemOutputVolume(state, volume)) return "failed to set system output volume";
    if (step < steps) await sleep(intervalMs);
  }
  return null;
}

function createSystemVolumeDuckingState(config: VoiceConfig): { state?: SystemVolumeDuckingState; warning?: string } {
  if (!config.duckSystemVolume || config.duckSystemVolumeFactor >= 1) return {};
  const snapshot = readSystemOutputVolume();
  if (!snapshot) return { warning: "system output volume ducking is enabled, but no supported volume control was found" };

  return {
    state: {
      ...snapshot,
      duckedVolumePercent: snapshot.originalVolumePercent * config.duckSystemVolumeFactor,
      factor: config.duckSystemVolumeFactor,
      fadeMs: config.duckSystemVolumeFadeMs,
    },
  };
}

async function applySystemVolumeDucking(state?: SystemVolumeDuckingState): Promise<string | null> {
  if (!state) return null;
  const warning = await fadeSystemOutputVolume(state, state.originalVolumePercent, state.duckedVolumePercent, state.fadeMs);
  return warning ? `system output volume ducking failed: ${warning}` : null;
}

async function restoreSystemOutputVolume(state?: SystemVolumeDuckingState): Promise<string | null> {
  if (!state) return null;
  const warning = await fadeSystemOutputVolume(state, state.duckedVolumePercent, state.originalVolumePercent, state.fadeMs);
  return warning ? `system output volume restore failed: ${warning}` : null;
}

function restoreSystemOutputVolumeNow(state?: SystemVolumeDuckingState): string | null {
  if (!state) return null;
  return setSystemOutputVolume(state, state.originalVolumePercent) ? null : "system output volume restore failed";
}

function selectRecorderExecutable(): string {
  if (platform() === "darwin") {
    if (commandExists("afrecord")) return "afrecord";
    if (commandExists("ffmpeg")) return "ffmpeg";
  }
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
  if (executable === "ffmpeg" && platform() === "darwin") {
    return [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      config.recorderTarget || "none:default",
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      outputPath,
    ];
  }
  throw new Error("No recorder found. On Linux, install PipeWire tools (pw-record) or alsa-utils (arecord). On macOS, install ffmpeg (brew install ffmpeg) if afrecord is not available.");
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
  if (recorderExecutable === "ffmpeg" && platform() === "darwin") return "macOS default microphone (ffmpeg/AVFoundation)";
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

function wrapVoiceTranscript(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return "";
  return `${VOICE_TRANSCRIPT_NOTICE}

${trimmed}`;
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
  const volumeWarning = restoreSystemOutputVolumeNow(state.systemVolume);
  const cleanupWarnings = cleanupRecordingArtifacts(state);
  clearState(config);
  return [volumeWarning, ...cleanupWarnings].filter((message): message is string => Boolean(message));
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
  const volumeDucking = createSystemVolumeDuckingState(config);

  ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("warning", "● starting mic"));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd[0], cmd.slice(1), {
      cwd: LOCAL_AUDIO_PROCESS_CWD,
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
    systemVolume: volumeDucking.state,
  });
  if (volumeDucking.warning) ctx.ui.notify(`Voice input warning: ${volumeDucking.warning}`, "warning");
  const duckingWarning = await applySystemVolumeDucking(volumeDucking.state);
  if (duckingWarning) ctx.ui.notify(`Voice input warning: ${duckingWarning}`, "warning");

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
  const volumeRestoreWarning = await restoreSystemOutputVolume(state.systemVolume);
  clearState(config);
  if (volumeRestoreWarning) ctx.ui.notify(`Voice input warning: ${volumeRestoreWarning}`, "warning");
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
      `No speech detected. audio=${(durationMs / 1000).toFixed(2)}s total=${result.timings.totalMs}ms`,
      "info",
    );
    return;
  }

  const finalText = wrapVoiceTranscript(result.text);

  ctx.ui.setStatus("voice-input", undefined);
  insertIntoEditor(ctx, finalText);
  ctx.ui.notify(
    `Voice text inserted. audio=${(durationMs / 1000).toFixed(2)}s decode=${decodeMs}ms asr=${result.timings.totalMs}ms packets=${result.packets}`,
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
    "- Output: raw ASR transcript wrapped with a short voice-input caveat",
    `- System volume ducking: ${config.duckSystemVolume ? `${Math.round(config.duckSystemVolumeFactor * 100)}% over ${config.duckSystemVolumeFadeMs}ms` : "disabled"}`,
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
    "- outputMode: raw transcript with voice-input caveat wrapper",
    `- duckSystemVolume: ${config.duckSystemVolume ? "enabled" : "disabled"}`,
    `- duckSystemVolumeFactor: ${config.duckSystemVolumeFactor}`,
    `- duckSystemVolumeFadeMs: ${config.duckSystemVolumeFadeMs}`,
    `- current recording device: ${currentDevice}`,
    "Config keys: volcApiKey, duckSystemVolume, duckSystemVolumeFactor, duckSystemVolumeFadeMs.",
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
