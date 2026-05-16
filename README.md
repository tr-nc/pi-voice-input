# pi Voice Input

A publishable, pure TypeScript [pi](https://pi.dev/) extension for local voice input.

- Press `Ctrl+Shift+R` once to start recording.
- Press `Ctrl+Shift+R` again to stop.
- The extension sends the audio to an ASR provider.
- The recognized text is inserted into pi's editor without submitting.

The provider layer is intended to be extensible. **Current version supports only VolcEngine WebSocket ASR.**

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
  ├─ sends PCM frames to the configured ASR provider via ws
  │    └─ current provider: VolcEngine /api/v3/sauc/bigmodel_nostream
  └─ appends the final transcript to pi's editor with ctx.ui.setEditorText()
```

Runtime package dependency:

- `ws`

System dependency, one of:

- `pw-record` from PipeWire tools, preferred
- `arecord` from alsa-utils, fallback

## Install

Install the published package with pi:

```bash
pi install npm:pi-voice-input
```

To pin a specific version:

```bash
pi install npm:pi-voice-input@0.1.0
```

If pi is already running, reload extensions after installation:

```text
/reload
```

## Providers

The extension is structured around a provider boundary: recording, editor insertion, and command handling are generic; ASR transport/protocol logic is provider-specific.

Currently implemented provider:

- VolcEngine WebSocket ASR (`bigmodel_nostream`)

Planned provider direction:

- add more ASR providers without changing the shortcut/user workflow
- keep provider credentials and options isolated in config

## Configure credentials

In pi, run:

```text
/voice key
```

Paste your VolcEngine Speech API key into the prompt. The extension saves it for future sessions and keeps it out of your project files.

Then verify:

```text
/voice config
```

You can get/manage the key here:

https://console.volcengine.com/speech/new/setting/apikeys?projectName=default

If `VOLC_API_KEY` is missing, the extension does not silently fail. It shows an error notification explaining:

- that the current provider API key is missing
- to run `/voice key`
- the VolcEngine API-key settings URL
- that `/voice config` can be used to verify detection

Manual fallback:

```bash
mkdir -p ~/.pi/agent
cp .env.example ~/.pi/agent/voice-input.env
$EDITOR ~/.pi/agent/voice-input.env
```

## Configuration reference

Example:

```bash
# Required for the current provider. Usually set by /voice key.
VOLC_API_KEY=your_volcengine_speech_api_key

# Current provider: VolcEngine WebSocket ASR endpoint and resource
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

Do not commit real credentials. Prefer `/voice key`, or keep private local values in `.env` or `~/.pi/agent/voice-input.env`.

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
/voice key      # prompt for and save the current provider API key
```

## Notes

- The extension uses post-recording WebSocket ASR: it records locally first, then sends the stopped recording in chunks. It is optimized for fast voice input, not live subtitles.
- The default `STREAM_SEGMENT_MS=5000` is intentionally larger than realtime packet sizes because this workflow sends already-recorded audio.
- The transcript is inserted into the editor only; it is not submitted automatically.

## Development

Clone the repo and install dependencies:

```bash
git clone git@github.com:tr-nc/pi-voice-input.git
cd pi-voice-input
npm install
```

Run directly without installing the package:

```bash
pi -e ./extensions/voice-input.ts
```

Or install the local checkout while developing:

```bash
pi install .
```

After changing the extension while pi is open, run:

```text
/reload
```

## Volcengine links

- API key settings: https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
- ASR product page: https://www.volcengine.com/product/asr
- WebSocket ASR docs: https://www.volcengine.com/docs/6561/1354869?lang=zh
