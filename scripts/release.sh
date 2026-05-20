#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: scripts/release.sh <version>" >&2
  echo "example: scripts/release.sh 0.2.3" >&2
  exit 1
fi

version="$1"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid semver version: $version" >&2
  exit 1
fi

node -e '
const fs = require("node:fs");
const path = "package.json";
const version = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = version;
fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
' "$version"

npm install --package-lock=false
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --types node extensions/index.ts
PI_OFFLINE=1 pi -e . --list-models >/tmp/pi-voice-input-list-models.out
npm pack --dry-run
secret_key_pattern='"volcApiKey"\\s*:\\s*"[^"]+"|VOLC_API''_KEY='
uuid_pattern='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
rg -n "${secret_key_pattern}|${uuid_pattern}" \
  --glob '!node_modules/**' --glob '!package-lock.json' . || true

git diff --check
git add package.json README.md CONTRIBUTING.md ROADMAP.md AGENTS.md extensions scripts
if git diff --cached --quiet; then
  echo "no release commit needed; package.json is already at $version"
else
  git commit -m "release voice input $version"
  git push origin HEAD
fi
npm publish --access public
npm view pi-voice-input version description --json
