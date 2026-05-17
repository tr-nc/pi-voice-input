# Roadmap

This roadmap lists user-visible work planned for pi Voice Input. It is intentionally short so users can quickly understand what is supported now and what is coming next.

## Current support

- Linux voice input through `pw-record` or `arecord`
- VolcEngine WebSocket ASR
- Optional transcript polish through a configured pi model

## Planned

### macOS support

Add first-class macOS recording support so users can dictate into pi without PipeWire or ALSA.

Expected direction:

- use a macOS-native recording command or a small bundled recorder helper
- keep the existing user workflow: press `Ctrl+Shift+R` to start, press it again to stop and insert text
- document required microphone permissions clearly
- preserve the same config file and ASR provider behavior where possible

Status: planned, not yet implemented.

## Later candidates

- additional ASR providers
- configurable shortcut
- better provider setup diagnostics
