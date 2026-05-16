# pi Voice Input for Volcengine ASR

A pure TypeScript pi extension for local voice input:

1. `Ctrl+Shift+R` starts microphone recording.
2. `Ctrl+Shift+R` again stops recording.
3. The extension sends the recorded PCM audio directly to Volcengine/Doubao WebSocket ASR.
4. The recognized text is inserted into pi's editor without submitting.

No Python or `uv` is required for the extension path.

Speed notes and benchmark results are in [`BENCHMARKS.md`](BENCHMARKS.md).

## Install

Install as a pi package from this directory:

```bash
cd /path/to/pi-voice-input-volc-asr
pi install .
```

For local development in this repo, the project-local shim remains at:

```text
.pi/extensions/voice-input.ts -> ../../extensions/voice-input.ts
```

After updating the extension while pi is open, run `/reload`.

## Configure

Copy the example config and fill in your own API key:

```bash
mkdir -p ~/.pi/agent
cp .env.example ~/.pi/agent/voice-input.env
$EDITOR ~/.pi/agent/voice-input.env
```

Required:

```bash
VOLC_API_KEY=your_volcengine_speech_api_key
```

Useful options:

```bash
# WebSocket ASR endpoint; default is the fast no-streaming-response endpoint.
VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
VOLC_STREAM_RESOURCE_ID=volc.seedasr.sauc.duration

# Empty means auto-detect. Example: zh-CN.
ASR_LANGUAGE=

# Faster for post-recording batch transcription. Use 200 for realtime-like packet size.
STREAM_SEGMENT_MS=5000

# Empty means use PipeWire's default source.
RECORDER_TARGET=

# Optional storage location for state, logs, and recordings.
VOICE_INPUT_HOME=~/.pi/agent/voice-input
```

For my local machine, the previous hardcoded private settings have been moved into the git-ignored local `.env` file, so they are not committed.

## Usage

Shortcut:

```text
Ctrl+Shift+R
```

Slash commands:

```text
/voice start
/voice stop
/voice status
/voice toggle
/voice cancel
/voice config
```

## Runtime dependencies

The extension uses Node/TypeScript plus the npm package `ws`, installed automatically by `pi install` / `npm install`.

System recorder dependency, one of:

- `pw-record` from PipeWire tools, preferred
- `arecord` from alsa-utils, fallback

The extension records directly as 16 kHz mono 16-bit WAV, then parses the WAV in TypeScript and sends raw PCM to ASR. No `ffmpeg`, Python, or `uv` is needed for normal shortcut use.

## Volcengine links

- API key settings: https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
- ASR product page: https://www.volcengine.com/product/asr
- WebSocket ASR docs: https://www.volcengine.com/docs/6561/1354869?lang=zh

## Legacy Python CLI

The previous Python CLI (`main.py`) is kept in this branch as a reference and for comparison, but the publishable pi extension no longer calls it. If you use the legacy CLI, provide `VOLC_API_KEY` through `.env` or the environment; there is no committed default key.
