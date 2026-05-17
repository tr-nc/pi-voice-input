# Contributing to pi Voice Input

Thank you for your interest in contributing to pi Voice Input. This project is a small, user-facing pi extension, so contributions should stay focused, easy to review, and safe for end users.

## Ways to contribute

Useful contributions include:

- bug reports with clear reproduction steps
- documentation improvements
- recorder support and diagnostics for Linux or macOS
- ASR provider improvements behind the existing provider boundary
- small usability improvements to commands, setup, or status messages
- tests or validation notes for platforms the maintainer cannot easily access

Please avoid broad rewrites or unrelated cleanup in feature pull requests.

## Before you start

1. Check existing issues and pull requests to avoid duplicate work.
2. For larger changes, open an issue first and describe the proposed direction.
3. Keep changes small and focused.
4. Do not commit API keys, local config files, recordings, transcripts, or other private data.

## Development setup

Requirements:

- Node.js compatible with the current pi runtime
- npm
- pi installed locally
- one supported recorder:
  - Linux: `pw-record` or `arecord`
  - macOS: `afrecord`

Clone and install dependencies:

```bash
git clone git@github.com:tr-nc/pi-voice-input.git
cd pi-voice-input
npm install
```

Run the extension directly from the checkout:

```bash
pi -e ./extensions/voice-input.ts
```

Or install the local checkout into pi while developing:

```bash
pi install .
```

After changing code, restart pi. `/reload` may not replace extension code that was already loaded by the current pi process.

## Configuration for local testing

The extension stores user config at:

```text
~/.pi/agent/voice-input.config.json
```

Create or normalize it from inside pi:

```text
/voice init
```

Set the VolcEngine Speech API key from inside pi:

```text
/voice key
```

Do not commit this config file or any secrets.

## Validation

Before opening a pull request, run:

```bash
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --types node extensions/voice-input.ts
PI_OFFLINE=1 pi -e ./extensions/voice-input.ts --list-models
npm pack --dry-run
git diff --check
```

For recorder or ASR changes, also include a short manual test note in the pull request, for example:

- platform and OS version
- recorder used (`pw-record`, `arecord`, or `afrecord`)
- whether recording starts and stops cleanly
- whether transcription inserts text into the editor
- any relevant log output or errors

macOS support is implemented but may need more community validation. macOS test reports are especially welcome.

## Code style

- Use TypeScript.
- Keep the extension self-contained and dependency-light.
- Prefer clear, explicit error messages over silent fallback behavior.
- Preserve the existing user workflow unless the change is intentional and documented.
- Keep provider-specific ASR logic isolated from generic recording and editor insertion logic.

## Documentation

Update `README.md` when changing user-visible behavior, setup steps, commands, supported platforms, or configuration.

Update `ROADMAP.md` when changing the status of user-visible planned work.

## Pull request checklist

Before submitting, confirm:

- [ ] The change is focused and easy to review.
- [ ] No secrets, recordings, transcripts, or local config files are committed.
- [ ] Validation commands were run, or skipped with a reason.
- [ ] User-facing docs were updated when needed.
- [ ] Platform-specific behavior is documented.

## Releases

Maintainers publish releases with:

```bash
scripts/release.sh <version>
```

Example:

```bash
scripts/release.sh 0.2.7
```

The script validates, commits, pushes, publishes to npm, and checks the published package metadata.
