# AGENTS.md

Development workflow for this repo.

## Project

- Package: `pi-voice-input`
- GitHub: `git@github.com:tr-nc/pi-voice-input.git`
- npm: `pi-voice-input`
- Main extension: `extensions/voice-input.ts`
- Current provider: VolcEngine WebSocket ASR only
- Provider architecture should remain extensible so more ASR providers can be added later.

## Secrets and local data

- Never commit API keys, `.env`, local config JSON, recordings, logs, caches, or `node_modules`.
- User credentials and plugin settings belong in `~/.pi/agent/voice-input.config.json`, usually written by `/voice key` or `/voice init`.
- Do not print or copy real API keys into commits, docs, tests, or command output.
- The explicit VolcEngine API key URL that should be shown to users is:
  `https://console.volcengine.com/speech/new/setting/apikeys?projectName=default`

## Before committing

Run from the repo root:

```bash
npm install --package-lock=false
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --types node extensions/voice-input.ts
PI_OFFLINE=1 pi -e ./extensions/voice-input.ts --list-models
npm pack --dry-run
```

Check that `npm pack --dry-run` includes only publishable files, normally:

```text
AGENTS.md
CONTRIBUTING.md
README.md
ROADMAP.md
extensions/voice-input.ts
package.json
```

Clean local generated files before committing:

```bash
rm -rf node_modules package-lock.json logs recordings
```

Then check:

```bash
git status --short
rg -n '"volcApiKey"\\s*:\\s*"[^"]+"|VOLC_API_KEY=|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  --glob '!node_modules/**' --glob '!package-lock.json' . || true
```

Use conventional commit messages, for example:

- `feat: add voice API key setup command`
- `fix: handle missing recorder cleanly`
- `docs: clarify npm installation`
- `chore: update package metadata`

## Release workflow

Use the project release script for normal releases. It takes exactly one argument: the next package version.

```bash
scripts/release.sh <version>
```

Example:

```bash
scripts/release.sh 0.2.7
```

The script updates `package.json`, installs dependencies without writing a lockfile, runs validation, checks the package tarball, scans for likely secrets, commits, pushes to GitHub, publishes to npm with public access, and prints npm package metadata.

Do not manually run separate commit/push/publish steps unless the script is broken or the user explicitly asks for a manual release path. npm versions are immutable, so always choose a new version.

After publishing, update the local installed pi package from npm and verify startup:

```bash
pi update npm:pi-voice-input
PI_OFFLINE=1 pi --list-models
```

If testing a local checkout instead of the npm package, use:

```bash
pi -e ./extensions/voice-input.ts
```

Do not leave local development wrappers in `~/.pi/agent/extensions/voice-input.ts` when validating the npm installation path.
