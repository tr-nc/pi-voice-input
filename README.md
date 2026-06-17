# pi Voice Input

Voice dictation for [pi](https://pi.dev/). Press one shortcut, speak naturally, and insert the transcript into the editor without sending the prompt automatically.

## Why use it?

Typing long prompts can slow you down. `pi-voice-input` lets you:

- capture ideas quickly while you are thinking out loud
- dictate long instructions, notes, bug reports, or code review comments
- speak naturally in Chinese, English, or a mix of both
- keep your hands on the keyboard with a simple toggle shortcut
- review or edit the inserted text before you submit it
- pass the raw transcript to the model with an explicit voice-input caveat

## Features

- **One-key dictation**: `Ctrl+Shift+R` starts recording; press it again to stop and insert text.
- **Editor-safe workflow**: transcription is pasted into the current editor only. It does not auto-submit.
- **Chinese/English mixed input**: handles prompts that switch between Chinese, English, product names, and technical terms.
- **Hotword table support**: can pass a VolcEngine boosting table ID to improve recognition of project terms.
- **Works on Linux and macOS**: uses common system recording tools.
- **Lowers sound while you speak**: automatically turns down system audio during recording, then restores it afterwards.
- **No hidden rewriting**: inserts the raw ASR transcript, prefixed with a short note that it may contain voice-recognition errors. If the editor already contains that note, later dictation inserts only the transcript.
- **Simple setup commands**: configure from inside pi with `/voice init` and `/voice key`.

Current speech provider: **VolcEngine Speech ASR**. A VolcEngine Speech API key is required.

## Install

```bash
pi install npm:pi-voice-input
```

Update later with:

```bash
pi update npm:pi-voice-input
```

Restart pi after installing or updating.

## First-time setup

1. Install the extension:

   ```bash
   pi install npm:pi-voice-input
   ```

2. Restart pi.

3. Create the local config:

   ```text
   /voice init
   ```

4. Add your VolcEngine Speech API key:

   ```text
   /voice key
   ```

   Get your key here:

   https://console.volcengine.com/speech/new/setting/apikeys?projectName=default

5. Check that pi sees your setup:

   ```text
   /voice config
   ```

6. Press `Ctrl+Shift+R`, speak, then press `Ctrl+Shift+R` again to insert the transcript.

## Use

Press:

```text
Ctrl+Shift+R
```

Then speak naturally in Chinese, English, or both. Press `Ctrl+Shift+R` again to stop recording. The recognized text appears in the editor at your cursor.

Useful commands:

```text
/voice start    start recording
/voice stop     stop, transcribe, and insert text
/voice toggle   start or stop recording
/voice cancel   stop and discard the recording
/voice status   show current recorder state
/voice config   show non-secret configuration
/voice key      set or replace the API key
/voice help     show setup help
```

## Inserted text format

The extension does not call a model to modify or translate your transcript. It inserts a concise, location-neutral caveat saying the current conversation may include voice transcription errors, asking the model to correct them from context or ask the user if the meaning is unclear, then appends the raw ASR transcript unchanged. When you dictate multiple times in the same unsent editor draft, the caveat is kept to a single copy.

User config keys are:

```json
{
  "volcApiKey": "",
  "boostingTableId": "",
  "duckSystemVolume": true,
  "duckSystemVolumeFactor": 0.5,
  "duckSystemVolumeFadeMs": 300
}
```

Set `boostingTableId` to a VolcEngine hotword/boosting table ID to send it as `boosting_table_id` on ASR requests. Leave it empty to disable hotword-table boosting. Boosting table name is not configured yet.

## System requirements

Linux needs one recording tool:

- `pw-record` from PipeWire tools, recommended
- or `arecord` from alsa-utils

macOS uses the built-in recorder when available. If recording does not work, install ffmpeg:

```bash
brew install ffmpeg
```

On macOS, allow microphone access for your terminal or pi host app when prompted. You can also check System Settings → Privacy & Security → Microphone.

## Privacy notes

- Your API key is stored locally in `~/.pi/agent/voice-input.config.json`.
- Recordings are temporary and are removed after use.
- Transcribed text is inserted into the editor so you can review it before submitting.

## Troubleshooting

- Run `/voice status` to see whether recording is active.
- Run `/voice config` to confirm the API key and optional boosting table ID are detected.
- Run `/voice key` again if the key was changed or expired.
- On macOS, check microphone permission if recording immediately fails.
- On Linux, make sure `pw-record` or `arecord` is installed and your microphone works in other apps.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned user-visible work.

## Links

- API key settings: https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
- VolcEngine ASR: https://www.volcengine.com/product/asr
