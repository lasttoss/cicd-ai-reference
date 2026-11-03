# The AI review lane — first measurements

The lane (`pr-review.yml`) is advisory: it never blocks a merge. These are the first two real
executions, both against this repository, both on `deepseek-v4.1-flash` through an
OpenAI-compatible endpoint.

| Run | Input | Files | Diff | Wall time | Input tokens | Output tokens | Findings |
|---|---|---|---|---|---|---|---|
| A | one commit (`ci.yml` + docs) | 1 | small | **20 s** | 35 673 | 5 031 | 1 |
| B | one commit (workflows + rules) | 3 | small | **4 m 35 s** | 297 817 | 81 968 | 5 |

## What the findings were worth

Run A found a real defect in code written twenty minutes earlier: the Playwright cache key was a
hand-maintained literal, and `actions/cache` never overwrites an exact key, so a Playwright upgrade
would have silently disabled the cache forever. Correct, specific, with a patch. That is the
behaviour the lane exists for.

Run B reviewed the fix for run A's finding and returned four more:

| # | Finding | Verdict |
|---|---|---|
| 1 | An empty `npx playwright --version` yields the constant key `pw-linux-`, reintroducing run A's bug | **valid, fixed** (guard added) |
| 2 | `url`/`protocol` written to `custom_providers` but the key to `providers` — one half may be dead | **half valid**: `providers.<name>` is not a store, the CLI normalises it into `custom_providers`. Behaviour was correct, the code was ambiguous. **Fixed** by using one namespace plus a config assertion |
| 3 | Only the API key was validated, not the base URL | **valid, fixed** |
| 4 | A bare `\|\| true` makes a broken lane look like a clean review | **valid, fixed** — the exit code is now surfaced as a workflow annotation |

Precision across both runs: 5 findings, 4.5 substantively correct, 0 invented. On a sample this
small that is not a precision claim — see `docs/evals/goldens/` for the labelled set that would
make one measurable.

## Two operational facts that matter

1. **The token budget is a soft cap.** `--max-tokens-budget 300000` was set for run B, which then
   consumed 379 785 tokens. Per the CLI's own documentation, a group already over budget is given
   one final round, and partial results are still published with exit 0. So the flag bounds the
   number of *groups*, not the spend.
2. **Cost and latency scale with diff size, not with `--effort`.** Both runs used `--effort low`;
   run B took 14× longer and 9× the tokens for three files instead of one. A ten-file PR will
   approach the 15-minute job timeout. The lever is file selection (`exclude` in
   `.opencodereview/rule.json`), not the effort preset.

Estimated spend at $0.15/M input: run A ≈ $0.005, run B ≈ $0.045 before output pricing. Output
pricing for this endpoint is **not verified** — do not quote a total from this document alone.

## Run C — first execution on GitHub Actions (PR #1)

Setting: a branch adding `GET /api/summary` to `app/server.mjs`, **deliberately without an e2e
assertion**, using the rule file in `.opencodereview/rule.json`. If the lane works end to end, it
must flag the uncovered handler and cite the repository rule rather than generic advice.

Result on the real runner — `ci` passing, `ai-review` passing, comment posted:

> `Review complete: 2 finding(s) across 1 selected item(s).`
>
> **`app/server.mjs:75` — [test · high]** New handler `/api/summary` has no e2e assertion covering
> it. No test in `tests/e2e/*.spec.ts` calls this route (and no consumer exists in `app/public/`
> either), so per **project rule (5)** this change is incomplete as-is. Please add an e2e test —
> e.g. create an order, call `GET /api/summary` with the session token, assert the returned `counts`
> includes the expected `new` bucket, and add a sibling assertion that the same request without a
> valid `x-token` returns 401.
>
> **`app/server.mjs:73` — [maintainability · medium]** This meta-comment about shipping without e2e
> coverage should not be committed — it documents intent to bypass the project's test requirement
> rather than the behaviour of the code.

Both findings are correct. The first is the planted gap, and it cites **rule (5)** by number, which
is the evidence that the project rules reach the model on CI — the thing that was silently broken
before this file existed. The second found the comment I wrote to set up the test, which is a fair
catch: a comment documenting intent to skip a requirement is itself a defect.

Not measured for this run: wall time and token count. Those live in the job log, which needs an
authenticated API; the unauthenticated limit is 60 requests/hour per IP and was exhausted. The job
is public: `Actions → pr-review → the run on feat/review-demo`.
