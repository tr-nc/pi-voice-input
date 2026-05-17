# pi Voice Input

A publishable, pure TypeScript [pi](https://pi.dev/) extension for Linux and macOS voice dictation into pi's editor.

- Press `Ctrl+Shift+R` once to start recording.
- Press `Ctrl+Shift+R` again to stop.
- The extension sends the audio to VolcEngine WebSocket ASR.
- The recognized text is inserted into pi's editor without submitting.

Current scope:

- Linux uses `pw-record` from PipeWire tools or `arecord` from alsa-utils.
- macOS uses the system `afrecord` command. This path is implemented but not yet validated by the maintainer on macOS hardware.
- A VolcEngine Speech API key is required.
- This is not a local/offline ASR engine.

The provider layer is intended to be extensible. **Current version supports only VolcEngine WebSocket ASR.**

No Python, `uv`, upload service, or `ffmpeg` is required for normal shortcut usage.

## Architecture

```text
pi extension: extensions/voice-input.ts
  ├─ registers Ctrl+Shift+R and /voice commands
  ├─ starts/stops a local recorder process
  │    ├─ Linux preferred: pw-record
  │    ├─ Linux fallback: arecord
  │    └─ macOS: afrecord
  ├─ records a temporary 16 kHz mono 16-bit WAV
  ├─ parses the WAV container in TypeScript and extracts raw PCM
  ├─ sends PCM frames to the configured ASR provider via ws
  │    └─ current provider: VolcEngine /api/v3/sauc/bigmodel_nostream
  ├─ optionally post-processes raw ASR text with a configured pi model
  │    └─ default: disabled; set polishModel to enable it
  └─ pastes the final transcript into pi's editor
```

Runtime package dependency:

- `ws`

System dependency, one of:

- Linux: `pw-record` from PipeWire tools, preferred
- Linux: `arecord` from alsa-utils, fallback
- macOS: `afrecord`, included with macOS

On macOS, grant Terminal or your pi host app microphone permission when prompted. If macOS has previously denied microphone access, enable it in System Settings → Privacy & Security → Microphone.

## Install / Update

Install the published package with pi:

```bash
pi install npm:pi-voice-input
```

Update to the latest published version:

```bash
pi update npm:pi-voice-input
```

If pi is already running, restart pi after installing or updating. `/reload` may not replace code that was already loaded by the current pi process.

## Providers

The extension is structured around a provider boundary: recording, editor insertion, and command handling are generic; ASR transport/protocol logic is provider-specific.

Currently implemented provider:

- VolcEngine WebSocket ASR (`bigmodel_nostream`)

Planned provider direction:

- add more ASR providers without changing the shortcut/user workflow
- keep provider credentials and options isolated in config

## Configure

All plugin settings live in one JSON file:

```text
~/.pi/agent/voice-input.config.json
```

Package-local and project-local env files are not read.

Create or normalize the file from inside pi:

```text
/voice init
```

Then set the VolcEngine Speech API key:

```text
/voice key
```

The key URL is also shown inside pi when the key is missing, when you run `/voice key`, and in `/voice help`:

https://console.volcengine.com/speech/new/setting/apikeys?projectName=default

The config file is plain JSON and can be edited directly:

```json
{
  "volcApiKey": "",
  "polishModel": ""
}
```

`polishModel` is disabled by default. Set it to any model shown by `pi --list-models` to enable transcript polish. If polishing fails, the raw ASR transcript is inserted instead.

Verify the effective non-secret config:

```text
/voice config
```

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
/voice cancel   # stop recording and discard local audio without transcribing
/voice status   # show recorder state
/voice config   # show effective non-secret config and whether API key is detected
/voice init     # create or normalize ~/.pi/agent/voice-input.config.json
/voice key      # prompt for and save the current provider API key
/voice help     # show setup help, including the explicit VolcEngine API key URL
```

## Notes

- The extension uses post-recording WebSocket ASR: it records locally to a per-run temporary WAV, sends the stopped recording in chunks, then deletes the temporary audio. It is optimized for fast voice input, not live subtitles.
- The default ASR segment size is intentionally larger than realtime packet sizes because this workflow sends already-recorded audio.
- The transcript is inserted into the editor only; it is not submitted automatically.
- Recorder stdout/stderr is not logged to disk, to avoid retaining potentially sensitive runtime data.
- On startup, legacy `~/.pi/agent/voice-input/recordings` and `~/.pi/agent/voice-input/logs` artifacts are cleaned up when they are not part of an active recording.
- When `polishModel` is set, polishing uses the unsent editor draft and recent session messages as context, but outputs only the refined voice text. The final text is still pasted at the current cursor position without replacing the draft.
- While recording, the status line shows `● Mic on: [device name] — press Ctrl+Shift+R again to stop/transcribe` in the current theme accent color; no separate popup is shown when recording starts.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, validation commands, and pull request expectations.

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

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned user-visible work.

## Links

- API key settings: https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
- ASR product page: https://www.volcengine.com/product/asr
- WebSocket ASR docs: https://www.volcengine.com/docs/6561/1354869?lang=zh
