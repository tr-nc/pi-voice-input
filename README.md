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
  ├─ optionally post-processes raw ASR text with a configured pi model
  │    └─ default: deepseek/deepseek-v4-flash, no reasoning option
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

You can get/manage the key here:

https://console.volcengine.com/speech/new/setting/apikeys?projectName=default

The key URL is also shown inside pi when the key is missing, when you run `/voice key`, and in `/voice help`:

Then verify:

```text
/voice config
```

## Configure post-processing

By default, recognized text is polished before insertion with pi's existing `deepseek/deepseek-v4-flash` model. Configure it in `~/.pi/agent/voice-input.env`:

```env
VOICE_POSTPROCESS_ENABLED=true
VOICE_POSTPROCESS_MODEL=deepseek/deepseek-v4-flash
```

`VOICE_POSTPROCESS_MODEL` is resolved from pi's model registry, so any model shown by `pi --list-models` can be used. If post-processing fails, the raw ASR transcript is inserted instead.

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
/voice help     # show setup help, including the explicit VolcEngine API key URL
```

## Notes

- The extension uses post-recording WebSocket ASR: it records locally first, then sends the stopped recording in chunks. It is optimized for fast voice input, not live subtitles.
- The default `STREAM_SEGMENT_MS=5000` is intentionally larger than realtime packet sizes because this workflow sends already-recorded audio.
- The transcript is inserted into the editor only; it is not submitted automatically.
- Post-processing uses the current editor content and recent session messages as context, but outputs only the refined user instruction.

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

## Links

- API key settings: https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
- ASR product page: https://www.volcengine.com/product/asr
- WebSocket ASR docs: https://www.volcengine.com/docs/6561/1354869?lang=zh
