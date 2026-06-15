import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
const DEFAULT_POSTPROCESS_CONTEXT_TOKENS = 20000;
const POSTPROCESS_GIT_LOG_LIMIT = 10;
const POSTPROCESS_DIRECTORY_DEPTH = 2;
const POSTPROCESS_DIRECTORY_TOKENS = 20000;
const SKIPPED_DIRECTORY_ENTRIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "logs",
  "recordings",
]);
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
- Make the output complete relative to the raw speech, logically clear, and actionable, but do not drop raw-speech information or repeat existing draft text.
- Preserve the raw speech layout. If the raw speech is a single line, output a single line unless the user explicitly dictates line breaks or another multiline layout, for example by saying "new line" or "换行".
- Do not introduce line breaks, bullets, numbered lists, tables, or code fences merely to improve style.
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
  postprocessEnabled: boolean;
  postprocessModel: string;
  postprocessTimeoutMs: number;
  postprocessMaxTokens: number;
  postprocessContextTokens: number;
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
    polishModel: DEFAULT_POSTPROCESS_MODEL,
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
    polishModel: stringField(root, "polishModel", defaults.polishModel).trim(),
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
    postprocessContextTokens: DEFAULT_POSTPROCESS_CONTEXT_TOKENS,
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
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function commandOutput(command: string, args: string[], timeoutMs = 1500): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function runCommand(command: string, args: string[], timeoutMs = 1500): boolean {
  return spawnSync(command, args, { stdio: "ignore", timeout: timeoutMs }).status === 0;
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

function estimateTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  };

  for (const char of text) {
    if (/\s/u.test(char)) {
      flushAscii();
    } else if (/[^\x00-\x7F]/u.test(char)) {
      flushAscii();
      tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  flushAscii();
  return tokens;
}

function takeTokensFromStart(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return "";
  if (estimateTokens(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function takeTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return "";
  if (estimateTokens(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(text.length - mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(text.length - low);
}

function limitTokensFromStart(text: string, maxTokens: number, marker = "\n…(truncated to fit token budget)"): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const markerTokens = estimateTokens(marker);
  return `${takeTokensFromStart(text, Math.max(0, maxTokens - markerTokens)).trimEnd()}${marker}`;
}

function limitTokensFromEnd(text: string, maxTokens: number, marker = "…(older context omitted to fit token budget)\n"): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const markerTokens = estimateTokens(marker);
  return `${marker}${takeTokensFromEnd(text, Math.max(0, maxTokens - markerTokens)).trimStart()}`;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(\bVOLC_API_KEY\s*=\s*)[^\s"']+/giu, "$1[redacted]")
    .replace(/((?:\b|["'])(?:volcApiKey|api[_-]?key|apikey|access[_-]?token|secret|password)(?:\b|["'])\s*[:=]\s*["']?)[^"'\s,}]+/giu, "$1[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "[redacted-uuid]");
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

function getEditorContext(ctx: ExtensionContext): string {
  try {
    return redactSensitiveText(ctx.ui.getEditorText()).trim();
  } catch {
    return "";
  }
}

function getRecentSessionContext(ctx: ExtensionContext): string {
  const lines: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = redactSensitiveText(textFromContent(message.content)).trim();
    if (!text) continue;
    lines.push(`${message.role}: ${text}`);
  }
  return lines.join("\n\n");
}

function buildConversationContext(ctx: ExtensionContext, maxTokens: number): { editorContext: string; sessionContext: string } {
  if (maxTokens <= 0) return { editorContext: "", sessionContext: "" };

  const editorContext = getEditorContext(ctx);
  const sessionContext = getRecentSessionContext(ctx);
  const editorSection = [
    "--- Context: current unsent editor draft (context only; do not output wholesale) ---",
    editorContext || "(empty)",
  ].join("\n");
  const sessionHeader = "--- Context: recent conversation ---\n";
  const totalTokens = estimateTokens([editorSection, sessionHeader, sessionContext || "(empty)"].join("\n\n"));
  if (totalTokens <= maxTokens) return { editorContext, sessionContext };

  const editorTokenBudget = Math.min(5000, Math.floor(maxTokens / 4));
  const limitedEditor = editorContext ? limitTokensFromEnd(editorContext, editorTokenBudget) : "";
  const fixedTokens = estimateTokens(
    [
      "--- Context: current unsent editor draft (context only; do not output wholesale) ---",
      limitedEditor || "(empty)",
      sessionHeader,
    ].join("\n\n"),
  );
  const sessionBudget = Math.max(0, maxTokens - fixedTokens);
  return {
    editorContext: limitedEditor,
    sessionContext: sessionContext ? limitTokensFromEnd(sessionContext, sessionBudget) : "",
  };
}

function commandOutputInDir(cwd: string, command: string, args: string[], timeoutMs = 2500): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function findGitRoot(startDir: string): string | null {
  const root = commandOutputInDir(startDir, "git", ["rev-parse", "--show-toplevel"], 1500);
  return root || null;
}

function buildGitContext(cwd: string): string {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return "(not a git repository)";

  const recentLog = commandOutputInDir(
    gitRoot,
    "git",
    ["log", `-${POSTPROCESS_GIT_LOG_LIMIT}`, "--date=short", "--pretty=format:%h %ad %an %s"],
    2500,
  );

  return [
    `Repository root: ${gitRoot}`,
    `Recent commits (up to ${POSTPROCESS_GIT_LOG_LIMIT}):`,
    recentLog ? redactSensitiveText(recentLog) : "(no commits yet)",
  ].join("\n");
}

function shouldSkipDirectoryEntry(name: string): boolean {
  return SKIPPED_DIRECTORY_ENTRIES.has(name);
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function formatDirectoryEntry(fullPath: string, name: string, isCwd = false): string {
  try {
    const stat = lstatSync(fullPath);
    const suffix = stat.isDirectory() ? "/" : stat.isSymbolicLink() ? "@" : "";
    return `${name}${suffix}${isCwd ? "  <-- current" : ""}`;
  } catch {
    return `${name}${isCwd ? "  <-- current" : ""}`;
  }
}

function buildTreeLines(dir: string, depth: number, prefix = "", state = { entries: 0, omitted: 0 }): string[] {
  if (depth < 0) return [];
  const names = safeReadDir(dir).filter((name) => !shouldSkipDirectoryEntry(name));
  const visibleNames = names.slice(0, 120);
  state.omitted += Math.max(0, names.length - visibleNames.length);
  const lines: string[] = [];

  visibleNames.forEach((name, index) => {
    const fullPath = path.join(dir, name);
    const isLast = index === visibleNames.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
    const label = formatDirectoryEntry(fullPath, name);
    lines.push(`${prefix}${connector}${label}`);
    state.entries += 1;

    try {
      const stat = lstatSync(fullPath);
      if (stat.isDirectory() && !stat.isSymbolicLink() && depth > 0) {
        lines.push(...buildTreeLines(fullPath, depth - 1, childPrefix, state));
      }
    } catch {
      // ignore unreadable entries
    }
  });

  return lines;
}

function buildDirectoryContext(cwd: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const parent = path.dirname(cwd);
  const isRootDirectory = path.resolve(parent) === path.resolve(cwd);
  const cwdName = path.basename(cwd) || cwd;
  const parentEntries = isRootDirectory
    ? []
    : safeReadDir(parent)
        .filter((name) => !shouldSkipDirectoryEntry(name))
        .slice(0, 160)
        .map((name) => formatDirectoryEntry(path.join(parent, name), name, path.resolve(parent, name) === path.resolve(cwd)));
  const state = { entries: 0, omitted: 0 };
  const cwdTree = buildTreeLines(cwd, POSTPROCESS_DIRECTORY_DEPTH - 1, "", state);
  const text = [
    `Current directory: ${cwd}`,
    isRootDirectory ? "Parent directory: (current directory is filesystem root; no parent directory)" : `Parent directory: ${parent}`,
    "Parent entries (one level up):",
    isRootDirectory ? "- (none; current directory is filesystem root)" : parentEntries.length ? parentEntries.map((entry) => `- ${entry}`).join("\n") : "- (empty or unreadable)",
    "",
    `Current directory tree (${cwdName}/, ${POSTPROCESS_DIRECTORY_DEPTH} levels deep):`,
    `${cwdName}/`,
    cwdTree.length ? cwdTree.join("\n") : "└── (empty or no readable child entries)",
    state.omitted > 0 ? `…(${state.omitted} entries omitted)` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return limitTokensFromStart(text, maxTokens);
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
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .join("")
    .trim();
}

function cleanPostprocessOutput(output: string): string {
  let text = output.trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:polished(?: user)? instruction|refined(?: user)? instruction|rewritten(?: user)? instruction|final(?: insertion)? text)\s*:\s*/iu, "").trim();
  return text;
}

const EXPLICIT_ENGLISH_MULTILINE_PATTERN =
  /\b(?:new\s*line|newline|line break|next line|new paragraph|paragraph break|carriage return|press enter|separate lines?|multi[- ]line|multiple lines)\b/i;
const EXPLICIT_CHINESE_MULTILINE_PATTERN = /(?:换行|新的一行|另起一行|下一行|回车|分行|多行|逐行|每行|空一行|新段落|另起一段|分段)/u;
const CJK_LIKE_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_PUNCTUATION_PATTERN = /[，。！？、；：（）《》「」『』“”‘’]/u;
const CLOSING_PUNCTUATION_PATTERN = /^[,.;:!?，。！？、；：）)\]}》」』”’]/u;
const OPENING_PUNCTUATION_PATTERN = /[（([{\[《「『“‘]$/u;

function rawTextRequestsMultiline(rawText: string): boolean {
  // Existing newlines in raw ASR are not reliable user intent: providers can
  // insert segment or sentence breaks on their own. Treat only spoken layout
  // commands as intentional multiline input.
  return EXPLICIT_ENGLISH_MULTILINE_PATTERN.test(rawText) || EXPLICIT_CHINESE_MULTILINE_PATTERN.test(rawText);
}

function lineBreakJoiner(left: string, right: string): string {
  if (!left || !right) return "";
  if (CLOSING_PUNCTUATION_PATTERN.test(right) || OPENING_PUNCTUATION_PATTERN.test(left)) return "";
  if (CJK_PUNCTUATION_PATTERN.test(left) || CJK_PUNCTUATION_PATTERN.test(right)) return "";
  if (CJK_LIKE_PATTERN.test(left) && CJK_LIKE_PATTERN.test(right)) return "";
  return " ";
}

function collapseUnexpectedLineBreaks(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized
    .replace(/[ \t\f\v]*\n+[ \t\f\v]*/g, (match, offset: number, source: string) => {
      const left = source.slice(0, offset).replace(/[ \t\f\v]+$/g, "").at(-1) ?? "";
      const right = source.slice(offset + match.length).replace(/^[ \t\f\v]+/g, "").at(0) ?? "";
      return lineBreakJoiner(left, right);
    })
    .replace(/[ \t\f\v]{2,}/g, " ")
    .trim();
}

function normalizeRawTextForPostprocess(rawText: string): string {
  const raw = rawText.trim();
  return rawTextRequestsMultiline(raw) ? raw : collapseUnexpectedLineBreaks(raw);
}

function preserveExpectedPostprocessLayout(rawText: string, output: string): string {
  if (rawTextRequestsMultiline(rawText)) return output.trim();
  return collapseUnexpectedLineBreaks(output);
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
  const { editorContext, sessionContext } = buildConversationContext(ctx, config.postprocessContextTokens);
  const cwd = process.cwd();
  const gitContext = buildGitContext(cwd);
  const directoryContext = buildDirectoryContext(cwd, POSTPROCESS_DIRECTORY_TOKENS);

  return [
    "Polish only the raw ASR text below, using context only when it helps disambiguate the user's intent.",
    "If context is empty or irrelevant, polish the raw text directly.",
    "Do not answer the raw speech, and do not execute its request. Output only the final text that should be inserted into the editor.",
    "The output language must match the primary language of the raw speech, not the context language and not this English prompt. Do not translate.",
    "Faithfully preserve the information and details in the raw speech. Do not summarize, compress, or delete details merely for brevity.",
    "IMPORTANT: your output will be pasted verbatim at the current cursor position. It is not a replacement and not a rewrite of the whole editor draft.",
    "The current editor draft is context only. Do not rewrite, repeat, complete, delete, or replace existing draft text. Do not output the full sentence after insertion.",
    "The true cursor position is not marked in the draft shown here; the pi editor owns the actual insertion point. Do not guess the cursor and synthesize a full surrounding sentence.",
    "Preserve layout: if the raw ASR text is one line, output one line unless the user explicitly dictated line breaks or another multiline layout.",
    "If the raw speech is an inline insertion, continuation, a few words, or a phrase, output only the newly spoken words or phrase.",
    "Use the git history and directory structure only as reference context for project names, files, APIs, and intent; never summarize them in the output.",
    "Example: draft is `Please make this function async and [cursor].`, raw speech is `add error handling`, correct output is `add error handling`, not `Please make this function async and add error handling.`.",
    "Example: draft is `This variable name is [cursor]unclear`, raw speech is `still`, correct output is `still`, not `This variable name is still unclear`.",
    "",
    "--- Context: current unsent editor draft (context only; do not output wholesale) ---",
    editorContext || "(empty)",
    "",
    "--- Context: recent conversation (recent tail, capped at 20k estimated tokens with the editor draft) ---",
    sessionContext || "(empty)",
    "",
    "--- Context: git history (latest commit summaries only) ---",
    gitContext || "(empty)",
    "",
    "--- Context: directory structure (parent one level; current directory two levels deep) ---",
    directoryContext || "(empty)",
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
          content: buildPostprocessPrompt(ctx, normalizeRawTextForPostprocess(raw), config),
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
  if (!polished) return rawText;
  const insertion = removeEditorDraftEcho(getFullEditorText(ctx), polished);
  return preserveExpectedPostprocessLayout(raw, insertion) || rawText;
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

  let finalText = result.text;
  let postprocessMs = 0;
  let postprocessSucceeded = false;
  let postprocessUsed = false;
  if (config.postprocessEnabled) {
    ctx.ui.setStatus("voice-input", ctx.ui.theme.fg("warning", "● polishing"));
    const postprocessStart = Date.now();
    try {
      finalText = await postprocessTranscript(ctx, result.text, config);
      postprocessMs = Date.now() - postprocessStart;
      postprocessSucceeded = true;
    } catch (error) {
      postprocessMs = Date.now() - postprocessStart;
      ctx.ui.notify(
        `Voice postprocess failed; inserting raw transcript. ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  finalText = preserveExpectedPostprocessLayout(result.text, finalText);
  postprocessUsed = postprocessSucceeded && finalText.trim() !== result.text.trim();

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
    `- polishModel: ${config.postprocessEnabled ? config.postprocessModel : "disabled"}`,
    `- duckSystemVolume: ${config.duckSystemVolume ? "enabled" : "disabled"}`,
    `- duckSystemVolumeFactor: ${config.duckSystemVolumeFactor}`,
    `- duckSystemVolumeFadeMs: ${config.duckSystemVolumeFadeMs}`,
    `- current recording device: ${currentDevice}`,
    "Config keys: volcApiKey, polishModel, duckSystemVolume, duckSystemVolumeFactor, duckSystemVolumeFadeMs. Leave polishModel empty to disable polish.",
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
