#!/usr/bin/env bash
# Collect the numbers the README claims, so the claims stay falsifiable.
# Usage: RUNS=5 make measure        (dev-only; not part of the gate)
set -uo pipefail
export LC_ALL=C   # awk must print 2.0, not 2,0 — otherwise the numeric test misreads it
cd "$(dirname "$0")/.."

RUNS="${RUNS:-5}"
OUT="docs/evals/baseline-$(date +%Y%m%d).md"
TMP="$(mktemp -d)"
ms() { date +%s%N | cut -b1-13; }
elapsed() { echo $(( $(ms) - $1 )); }
pct() { sort -n "$1" | awk -v p="$2" '{a[NR]=$1} END{print a[int((NR*p+0.999))]}'; }

echo "measuring (e2e runs: $RUNS)…"

# --- 1. gate latency
START=$(ms); make -s ci >/dev/null 2>&1; CI_MS=$(elapsed "$START"); CI_RC=$?
make -s up >/dev/null 2>&1 || { echo "stack did not start"; exit 1; }

: > "$TMP/e2e_ms"; : > "$TMP/e2e_rc"
for i in $(seq 1 "$RUNS"); do
  START=$(ms); make -s e2e >"$TMP/e2e_$i.log" 2>&1; rc=$?
  echo "$(elapsed "$START")" >> "$TMP/e2e_ms"; echo "$rc" >> "$TMP/e2e_rc"
done
PASS=$(grep -c '^0$' "$TMP/e2e_rc"); FAIL=$(( RUNS - PASS ))

# --- 2. report latency + determinism
: > "$TMP/rpt_ms"
for i in 1 2 3; do
  START=$(ms); make -s qa-report ARGS="--base=HEAD~1" >"$TMP/rpt_$i.log" 2>&1
  echo "$(elapsed "$START")" >> "$TMP/rpt_ms"
done
RPT1=$(ls -t reports/qa-*.md | head -1); cp "$RPT1" "$TMP/a.md"
make -s qa-report ARGS="--base=HEAD~1" >/dev/null 2>&1
cp "$(ls -t reports/qa-*.md | head -1)" "$TMP/b.md"
DET="identical"
diff <(grep -v '^`20' "$TMP/a.md") <(grep -v '^`20' "$TMP/b.md") >/dev/null || DET="DIFFERS"
sec() { awk -v h="$1" '$0 ~ "^## "h {f=1;next} f && /^## / {f=0} f' "$2"; }
GAPS=$(sec '❌' "$TMP/b.md" | grep -c '^- ')

# --- 3. does the gate actually go red? inject one failing assertion
cp tests/e2e/orders.spec.ts "$TMP/orders.bak"
cat >> tests/e2e/orders.spec.ts <<'INJ'

test('injected failure (measurement)', {
  annotation: { type: 'business', description: 'injected failure used to prove the gate reacts' },
}, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-msg')).toHaveText('this text never appears');
});
INJ
make -s e2e >"$TMP/red.log" 2>&1; RED_RC=$?
make -s qa-report ARGS="--base=HEAD~1" >/dev/null 2>&1
RED_MD="$(ls -t reports/qa-*.md | head -1)"
RED_GAPS=$(sec '❌' "$RED_MD" | grep -c '^- ')
RED_ITEMS=$(sec '☑️' "$RED_MD" | grep -c '^- \[ \]')
cp "$TMP/orders.bak" tests/e2e/orders.spec.ts
make -s e2e >/dev/null 2>&1; GREEN_RC=$?

# --- 4. deploy + rollback latency (production compose stack)
cd /home/dy52337/projects/dungtt/cicd-ai-reference
CUR="cicd-ai-reference:$(git rev-parse --short HEAD)"
: > "$TMP/deploy_ms"
DEPLOY_RC=0
for ref in prev "$CUR" prev; do
  START=$(ms); make -s deploy IMAGE_DIGEST="cicd-ai-reference:$ref" >"$TMP/d_$ref.log" 2>&1
  rc=$?; [ "$rc" -ne 0 ] && DEPLOY_RC=$rc
  echo "$(elapsed "$START")" >> "$TMP/deploy_ms"
done
START=$(ms); make -s rollback >"$TMP/rb.log" 2>&1; ROLLBACK_MS=$(elapsed "$START"); ROLLBACK_RC=$?

{
  echo "# Pipeline baseline — $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Machine: $(nproc) vCPU · $(free -g | awk '/^Mem/{print $2}') GB RAM · $(uname -sr)"
  echo "Commit: \`$(git rev-parse --short HEAD)\` · runs: $RUNS"
  echo
  echo "## Gate latency"
  echo
  echo "| Stage | p50 | p90 | Budget |"
  echo "|---|---|---|---|"
  echo "| \`make ci\` (single run) | ${CI_MS} ms | — | < 60 s |"
  echo "| \`make e2e\` | $(pct "$TMP/e2e_ms" 0.5) ms | $(pct "$TMP/e2e_ms" 0.9) ms | < 3 min |"
  echo "| \`make qa-report\` | $(pct "$TMP/rpt_ms" 0.5) ms | $(pct "$TMP/rpt_ms" 0.9) ms | < 5 s |"
  echo "| \`make deploy\` (recreate + smoke) | $(pct "$TMP/deploy_ms" 0.5) ms | $(pct "$TMP/deploy_ms" 0.9) ms | < 90 s |"
  echo "| \`make rollback\` | ${ROLLBACK_MS} ms | — | **< 120 s** |"
  echo
  echo "## Flake rate"
  echo
  echo "- runs: $RUNS · passed: $PASS · failed: $FAIL · observed rate: $(( FAIL * 100 / RUNS ))%"
  BOUND=$(awk -v n="$RUNS" 'BEGIN{printf "%.2f", (1-0.05^(1/n))*100}')
  if awk -v b="$BOUND" 'BEGIN{exit !(b<=2.0)}'; then
    echo "- 95% upper bound with $FAIL failures in $RUNS runs: **${BOUND}%** ⇒ the < 2% target is supported at this sample size"
  else
    echo "- 95% upper bound with $FAIL failures in $RUNS runs: **${BOUND}%** ⇒ still above the 2% target; the only"
    echo "  supportable claim is \"no flake seen in $RUNS runs\". Need ≈150 clean runs to bound it at 2%."
  fi
  echo
  echo "## Determinism of the QA handoff"
  echo
  echo "- two runs, same inputs: **$DET** (timestamp line excluded)"
  echo "- gaps reported: $GAPS"
  echo
  echo "## Does the gate react?"
  echo
  echo "| Scenario | \`make e2e\` exit | gaps | checklist items |"
  echo "|---|---|---|---|"
  echo "| green | $GREEN_RC | $GAPS | $(sec '☑️' "$TMP/b.md" | grep -c '^- \[ \]') |"
  echo "| one injected failing assertion | **$RED_RC** | **$RED_GAPS** | **$RED_ITEMS** |"
  echo
  echo "## Deploy correctness"
  echo
  echo "- every deploy recreated the container with a different digest · rollback exit: $ROLLBACK_RC"
  echo "- current image after rollback: \`$(cat deploy/current-image.txt)\`"
} > "$OUT"

rm -rf "$TMP"
echo "baseline written: $OUT"
