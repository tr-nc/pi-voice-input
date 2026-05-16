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

- Never commit API keys, `.env`, recordings, logs, caches, or `node_modules`.
- User credentials belong in `~/.pi/agent/voice-input.env`, usually written by `/voice key`.
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
.env.example
AGENTS.md
README.md
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
rg -n "VOLC_API_KEY=|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" \
  --glob '!node_modules/**' --glob '!package-lock.json' . || true
```

Use conventional commit messages, for example:

- `feat: add voice API key setup command`
- `fix: handle missing recorder cleanly`
- `docs: clarify npm installation`
- `chore: update package metadata`

## Release workflow

1. Bump `package.json` version. npm versions are immutable.
2. Validate with the commands above.
3. Commit with a conventional commit message.
4. Push to GitHub:

```bash
git push origin main
```

5. Publish to npm:

```bash
npm publish --access public
```

6. Update the local installed pi package and verify startup:

```bash
pi update npm:pi-voice-input
PI_OFFLINE=1 pi --list-models
```

If testing a local checkout instead of the npm package, use:

```bash
pi -e ./extensions/voice-input.ts
```

Do not leave local development wrappers in `~/.pi/agent/extensions/voice-input.ts` when validating the npm installation path.
