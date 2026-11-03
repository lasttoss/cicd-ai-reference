# Evals and baselines

`make measure RUNS=<n>` regenerates `baseline-<date>.md` from the pipeline itself. Nothing here is
hand-written; if a number in the top-level README disagrees with a baseline file, the baseline wins.

```bash
make up                  # the e2e gate needs a running stack
make measure RUNS=150    # ~6 min; 150 is the smallest sample that bounds a 2% flake rate
```

## What each number is for

| Metric | Why it is measured | What to do with it |
|---|---|---|
| `make ci` latency | the cheap gate must never be a reason to bypass | if > 60 s, split it |
| `make e2e` p50 / p90 | the gate that people wait on | p90 drives the merge queue, not p50 |
| `make qa-report` latency | produce a handoff document cheaply enough to generate per PR | if > 5 s it stops being free |
| deploy recreate time | rollback speed is bounded by it | keep < 90 s |
| rollback time | the number that dominates user-visible damage | keep < 2 min |
| flake rate | a flaky gate gets bypassed within weeks | below 2%, or fix the test |

## Flake rate needs a sample size, not an opinion

With **zero** failures in `n` runs, the 95% upper bound is `1 − 0.05^(1/n)`:

| Runs | 95% upper bound with 0 failures |
|---|---|
| 5 | 45.1% |
| 40 | 7.2% |
| 150 | **2.0%** |
| 300 | 1.0% |

So "0 failures in 5 runs" says almost nothing, and 150 is the smallest honest sample for a 2% claim.
This is why the generator prints the bound next to the observed rate: reporting `0%` from 5 runs would
be a claim nobody should believe.

## Determinism

Two consecutive `make qa-report` runs on the same inputs must produce byte-identical output apart from
the timestamp. The generator is deterministic by construction — no model is involved — and the baseline
verifies it rather than assuming it.

## CI-side numbers (once the repository is authenticated)

These need `gh auth login`, then:

```bash
gh workflow list --repo lasttoss/cicd-ai-reference
gh run list --repo lasttoss/cicd-ai-reference --limit 10 \
  --json name,status,conclusion,createdAt,updatedAt
# per-job durations for the latest run:
gh run view <run-id> --repo lasttoss/cicd-ai-reference --json jobs
```

What to record from there: job duration (cold runner, so expect 3–5× the local timings because of
`npm ci` and `playwright install`), queue wait, and whether the report artifact uploads on the first try.
Local numbers describe the pipeline; CI numbers describe the platform. They are not interchangeable.
