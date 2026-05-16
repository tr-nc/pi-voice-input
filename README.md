# pi Voice Input for Volcengine ASR

A publishable, pure TypeScript [pi](https://pi.dev/) extension for local voice input with Volcengine/Doubao ASR.

- Press `Ctrl+Shift+R` once to start recording.
- Press `Ctrl+Shift+R` again to stop.
- The extension sends the audio directly to Volcengine WebSocket ASR.
- The recognized text is inserted into pi's editor without submitting.

No Python, `uv`, upload service, or `ffmpeg` is required for normal shortcut usage.

## Architecture

```text
pi extension: extensions/voice-input.ts
  ├─ registers Ctrl+Shift+R and /voice commands
  ├─ starts/stops a local recorder process
  │    ├─ preferred: pw-record
  │    └─ fallback: arecord
  ├─ records 16 kHz mono 16-bit WAV
  ├─ parses the WAV container in TypeScript and extracts raw PCM
  ├─ sends PCM frames to Volcengine WebSocket ASR via ws
  │    └─ default endpoint: /api/v3/sauc/bigmodel_nostream
  └─ appends the final transcript to pi's editor with ctx.ui.setEditorText()
```

Runtime package dependency:

- `ws`

System dependency, one of:

- `pw-record` from PipeWire tools, preferred
- `arecord` from alsa-utils, fallback

## Install

From a local checkout:

```bash
git clone <this-repo-url>
cd pi-voice-input-volc-asr
pi install .
```

For development without installing:

```bash
npm install
pi -e ./extensions/voice-input.ts
```

After changing the extension while pi is open, run:

```text
/reload
```

## Configure credentials

Create a config file:

```bash
mkdir -p ~/.pi/agent
cp .env.example ~/.pi/agent/voice-input.env
$EDITOR ~/.pi/agent/voice-input.env
```

At minimum, set:

```bash
VOLC_API_KEY=your_volcengine_speech_api_key
```

You can get/manage the key here:

https://console.volcengine.com/speech/new/setting/apikeys?projectName=default

If `VOLC_API_KEY` is missing, the extension does not silently fail. It shows an error notification explaining:

- that `VOLC_API_KEY` is missing
- where to put it: `~/.pi/agent/voice-input.env`
- the exact config line to add
- the Volcengine API-key settings URL
- that `/voice config` can be used to verify detection

## Configuration reference

Example:

```bash
# Required
VOLC_API_KEY=your_volcengine_speech_api_key

# ASR endpoint and resource
VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
VOLC_STREAM_RESOURCE_ID=volc.seedasr.sauc.duration

# Empty means auto-detect. Example: zh-CN.
ASR_LANGUAGE=

# Optional contextual prompt for ASR.
ASR_PROMPT=

# Faster for post-recording batch transcription. Use 200 for realtime-like packet size.
STREAM_SEGMENT_MS=5000
ASR_REQUEST_TIMEOUT_MS=90000

# Empty means use PipeWire's default source.
RECORDER_TARGET=
RECORDING_FINALIZE_DELAY=0.1

# Storage for recordings, logs, and state.
VOICE_INPUT_HOME=~/.pi/agent/voice-input
RECORDINGS_DIR=recordings
RECORDER_STATE=recording.json
RECORDER_LOG_DIR=logs

# Shortcut. Default: ctrl+shift+r
VOICE_INPUT_SHORTCUT=ctrl+shift+r
```

Config loading order, later values override earlier ones:

1. `~/.pi/agent/voice-input.env`
2. package-local `.env`
3. current-working-directory `.env`
4. shell environment variables

Do not commit real credentials. Keep private local values in `.env` or `~/.pi/agent/voice-input.env`.

## Usage

Shortcut:

```text
Ctrl+Shift+R
```

Slash commands:

```text
/voice start    # start recording
/voice stop     # stop, transcribe, insert text
/voice toggle   # start if idle, stop if recording
/voice cancel   # stop recording without transcribing
/voice status   # show recorder state
/voice config   # show effective non-secret config and whether API key is detected
```

## Notes

- The extension uses post-recording WebSocket ASR: it records locally first, then sends the stopped recording in chunks. It is optimized for fast voice input, not live subtitles.
- The default `STREAM_SEGMENT_MS=5000` is intentionally larger than realtime packet sizes because this workflow sends already-recorded audio.
- The transcript is inserted into the editor only; it is not submitted automatically.

## Volcengine links

- API key settings: https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
- ASR product page: https://www.volcengine.com/product/asr
- WebSocket ASR docs: https://www.volcengine.com/docs/6561/1354869?lang=zh
