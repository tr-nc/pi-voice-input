# pi Voice Input

Voice dictation for [pi](https://pi.dev/). Press one shortcut, speak naturally, and insert the transcript into the editor without sending the prompt automatically.

## Why use it?

Typing long prompts can slow you down. `pi-voice-input` lets you:

- capture ideas quickly while you are thinking out loud
- dictate long instructions, notes, bug reports, or code review comments
- speak naturally in Chinese, English, or a mix of both
- keep your hands on the keyboard with a simple toggle shortcut
- review or edit the inserted text before you submit it
- optionally polish dictated text with one of your configured pi models

## Features

- **One-key dictation**: `Ctrl+Shift+R` starts recording; press it again to stop and insert text.
- **Editor-safe workflow**: transcription is pasted into the current editor only. It does not auto-submit.
- **Chinese/English mixed input**: handles prompts that switch between Chinese, English, product names, and technical terms.
- **Works on Linux and macOS**: uses common system recording tools.
- **Lowers sound while you speak**: automatically turns down system audio during recording, then restores it afterwards.
- **Optional transcript polish**: use a pi model to clean up punctuation and wording before insertion.
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

## Optional: polish dictated text

By default, pi inserts the raw transcript. To let a pi model clean up punctuation and wording, set `polishModel` in:

```text
~/.pi/agent/voice-input.config.json
```

Use any model name shown by:

```bash
pi --list-models
```

Example:

```json
{
  "volcApiKey": "",
  "polishModel": "your-model-name"
}
```

If polishing fails, the raw transcript is inserted instead.

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
- Run `/voice config` to confirm the API key is detected.
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
