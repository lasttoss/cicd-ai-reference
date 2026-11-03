#!/usr/bin/env bash
# Cold-start breakdown: what a CI runner pays before a single test runs.
# Everything here is executed exactly as .github/workflows/ci.yml declares it.
set -uo pipefail
export LC_ALL=C
cd "$(dirname "$0")/.."

OUT="docs/evals/cold-start-$(date +%Y%m%d).md"
TMP="$(mktemp -d)"; : > "$TMP/steps"
ms() { date +%s%N | cut -b1-13; }

step() { # name, then command
  local name="$1"; shift
  local s; s=$(ms)
  "$@" >"$TMP/step.log" 2>&1; local rc=$?
  echo "$name|$(( $(ms) - s ))|$rc" >> "$TMP/steps"
  printf '  %-42s %6s ms  rc=%s\n' "$name" "$(( $(ms) - s ))" "$rc"
}

echo "cold start measurement…"
docker compose down -v >/dev/null 2>&1
rm -rf node_modules test-results artifacts

step "npm ci"                         npm ci
step "playwright install chromium"    npx playwright install chromium
step "docker build (no cache)"        docker build --no-cache -q -t cicd-ai-reference:cold .
step "compose up (db→migrate→seed→app)" bash -c 'docker compose up -d --wait'
step "make ci"                        make ci
step "make e2e"                       npx playwright test
step "make qa-report"                 node scripts/qa-report.mjs --base=HEAD~1

TOTAL=$(awk -F'|' '{s+=$2} END{print s}' "$TMP/steps")

# Honesty check: several caches are warm on a developer machine and cold on a runner.
NPM_CACHE=$(du -sh "$HOME/.npm" 2>/dev/null | cut -f1); [ -z "$NPM_CACHE" ] && NPM_CACHE="absent"
PW_BROWSERS=$(ls "$HOME/.cache/ms-playwright" 2>/dev/null | wc -l | tr -d ' ')
BASE_IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -cE '^(node:22-alpine|postgres:16-alpine)$' || true)
{
  echo "# Cold-start cost — $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Machine: $(nproc) vCPU · $(free -g | awk '/^Mem/{print $2}') GB RAM"
  echo "Commit: \`$(git rev-parse --short HEAD)\` · steps executed as declared in \`.github/workflows/ci.yml\`"
  echo
  echo "| Step | ms | share |"
  echo "|---|---|---|"
  awk -F'|' -v t="$TOTAL" '{printf "| %s | %s | %d%% |\n", $1, $2, ($2*100/t)}' "$TMP/steps"
  echo "| **total** | **$TOTAL** | 100% |"
  echo
  echo "## What this is and is not"
  echo
  echo "- **Is**: every build/install step the workflow runs, from a clean checkout (no \`node_modules\`,"
  echo "  no docker layer cache, no running stack). These are the steps whose cost is platform-independent."
  echo "- **Is not**: GitHub runner overhead — machine provisioning, queue wait, artifact upload,"
  echo "  and \`playwright install --with-deps\` (apt packages, needs root; expect +40–70 s)."
  echo "  Those need \`gh auth login\` and a real run."
  echo
  echo "## Reading it"
  echo
  echo "- If \`total\` is dominated by install/build, caching is the only lever worth pulling"
  echo "  (\`actions/cache\` on the npm store and the docker layer cache)."
  echo "- The gate itself is the cheap part; a slow pipeline here is almost never the tests."
} > "$OUT"

echo >> "$OUT"
cat >> "$OUT" <<'DISCLOSURE'
## Which caches were warm — read this before quoting the total

| Cache | State here | What a cold runner pays instead |
|---|---|---|
| `node_modules` | cleared before measuring | same |
| docker layer cache | cleared (`--no-cache`) | same |
| docker base images | __IMG__/2 present (node:22-alpine, postgres:16-alpine) | pull ≈ 80 MB, +10–30 s |
| npm package cache | __NPM__ in `~/.npm` | +10–20 s |
| playwright browsers | __PW__ entries in `~/.cache/ms-playwright` | +40–70 s, plus apt deps |
| database volume | dropped | same |

So the measured **__TOTAL__ ms is a floor, not a forecast.** Adding the cold-cache costs above puts a
GitHub runner at roughly **1.7–2× this number** before provisioning and queue time are counted.
DISCLOSURE
sed -i "s|__TOTAL__|$TOTAL|; s|__NPM__|$NPM_CACHE|; s|__PW__|$PW_BROWSERS|; s|__IMG__|$BASE_IMAGES|" "$OUT"

rm -rf "$TMP"
echo
echo "written: $OUT"
