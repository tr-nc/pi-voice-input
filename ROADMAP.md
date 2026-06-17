# Roadmap

This roadmap lists user-visible work planned for pi Voice Input. It is intentionally short so users can quickly understand what is supported now and what is coming next.

## Current support

- Linux voice input through `pw-record` or `arecord`
- macOS voice input through the system `afrecord` command
- VolcEngine WebSocket ASR
- Raw ASR transcript insertion with a voice-input caveat wrapper

## Planned

### Validate and refine macOS support

The macOS recording path is implemented with `afrecord`, but it still needs hands-on validation on macOS hardware.

Expected follow-up:

- confirm microphone permission prompts and recovery steps
- confirm produced WAV files are compatible across supported macOS versions
- refine device naming and setup diagnostics if needed
- preserve the same config file and ASR provider behavior

## Later candidates

- additional ASR providers
- configurable shortcut
- better provider setup diagnostics
