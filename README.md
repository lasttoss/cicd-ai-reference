# cicd-ai-reference

> **The application in this repository is a vehicle. The deliverable is the pipeline around it.**

A deliberately small shop API (sign in → create order → cancel → delivery address) exists
here for one reason: to make a complete **CI/CD + AI review + QA handoff** pipeline
executable and provable end to end. Nothing in this repository is a product.

If you are reading this to evaluate the workflow rather than the app, start from
**The pipeline** and **Language independence**, and ignore `app/`.

## What this project is for

| Goal | Where it lives |
|---|---|
| Every change is verified before a human looks at it | `.github/workflows/ci.yml`, `make e2e` |
| A reviewer bot that knows *this* repo's rules, not generic advice | `.opencodereview/rule.json` |

### Secrets in a public repository

Repository secrets are write-only: GitHub never displays the value again, for anyone, including the
owner, and no API returns it. A public repository therefore exposes secret *names*, never values.
The residual risks are worth naming rather than hiding:

- **Anyone who can push can read the secrets.** A workflow on a branch inside the repo receives
  them. Protect the SSH key or token that grants push, not the secret itself.
- **Fork pull requests receive no secrets** and are skipped here (`head.repo.fork == false`). This
  is also why the lane uses `pull_request` and never `pull_request_target`.
- **Logs are the leak surface.** Secrets are injected through `env:` rather than interpolated into
  the command line, and `ocr config set` masks values itself (verified: `DUMM***2345`). Its config
  file is written to `~/.opencodereview/config.json` (mode 600), outside the checkout, so it cannot
  reach an artifact.

Optional hardening: move the two secrets into an *Environment* (`Settings → Environments → ci`)
restricted to the `dev` branch and add `environment: ci` to the job. Repository-level secrets keep
working either way.
| Testers receive evidence, not just a URL | `scripts/qa-report.mjs` → `reports/qa-*.md` |
| Production receives exactly the artefact verified on dev | `docker-compose.prod.yml`, `make deploy` |
| A bad deploy is undone in one command | `make rollback` |
| A bug found by a human can never escape twice | `docs/features.yaml` (the ratchet) |

Guiding rule: **the model may speak, only tests may conclude, a human decides.**

## Verified, not claimed

```
$ make up
 Container cicd-ai-reference-db-1       Healthy
 Container cicd-ai-reference-migrate-1  Exited
 Container cicd-ai-reference-seed-1     Exited
 Container cicd-ai-reference-app-1      Healthy
up: http://127.0.0.1:8080

$ make e2e
6 passed (1.8s)

$ make qa-report
qa-report: reports/qa-<sha>.md
  source playwright.json
  verified 2/4 · gaps 7 · checklist 10

$ make deploy IMAGE_DIGEST=cicd-ai-reference:<sha> SMOKE_FULL=1
6/6 smoke checks passed
deploy: cicd-ai-reference:<sha> live on http://127.0.0.1:9090

$ make rollback
6/6 smoke checks passed
rollback: back on <previous-sha>
```

## The pipeline

```
feature/* --PR--> dev --PR--> main --> production
                  │            │
                  │            └─ promote the digest that passed on dev (never rebuild)
                  └─ gates: make ci · make e2e · AI review (advisory)
                             + QA handoff document generated from real artefacts
```

| Event | Runs | Blocks a merge? |
|---|---|---|
| PR → `dev` | `make ci` (lint/type/unit/build) | yes |
| PR → `dev` | `make e2e` against the Compose stack | yes |
| PR → `dev` | AI diff review (`ocr`, project rules) | no — advisory only |
| any gate run | `make qa-report` → `reports/qa-*.md` | no, but the process requires it |
| PR `dev` → `main` | provenance check + e2e on staging | yes |
| merge → `main` | deploy the **same digest**, smoke test | yes |
| smoke fails | `make rollback` | — |

Two rules make the two-branch model safe:

- **Promotion, not rebuild.** `main` receives the image reference that was verified on `dev`.
  Rebuilding on `main` silently ships code nobody tested.
- **Back-merge.** `main` returns into `dev` after every deploy, hotfixes included.

## Language independence

This kit assumes **one extra toolchain: Node**, because Playwright is Node-based. That is the
only toolchain requirement — it is *not* a requirement on the project language.

- `make ci`, `make e2e`, `make qa-report`, `make deploy`, `make rollback` are the contract.
  CI never inspects the project; it only calls `make`.
- The report generator reads **JUnit XML or Playwright JSON**. Any runner that can produce
  JUnit XML is supported, which is most of them:

| Stack | `make ci` | `make e2e` | Results file |
|---|---|---|---|
| Go API | `go vet ./... && go test ./... && go build ./...` | `gotestsum --junitfile artifacts/results.xml ./...` | JUnit XML |
| Vite / React | `npm ci && npm run lint && npm test && npm run build` | `playwright test` against `vite preview` | Playwright JSON or JUnit |
| Go API + Vite UI | `make -C api ci && make -C web ci` | Playwright against the UI, which drives the API | Playwright JSON |
| Python | `ruff check . && pytest` | `pytest --junit-xml=artifacts/results.xml` | JUnit XML |
| Java / Kotlin | `./gradlew check` | `./gradlew integrationTest` | JUnit XML |

Proven in this repo: the same generator produced a correct report from Go output with zero
code changes —

```
$ node scripts/qa-report.mjs --results=docs/examples/go-junit.xml \
    --features=docs/examples/go-features.yaml --base= --outdir=/tmp/qa-go --version=go-demo
qa-report: /tmp/qa-go/qa-go-demo.md
  source go-junit.xml (junit xml)
  verified 1/2 · gaps 1 · checklist 2
```

A pure API with no UI has no browser step. Its `make e2e` is HTTP-level integration testing;
the report and the gates are unchanged. The pipeline does not assume a browser.

## The QA handoff document

`make qa-report` writes `reports/qa-<version>.md` from read-only inputs: test results,
`git diff base...HEAD`, `docs/features.yaml`, `docs/qa/known-issues.yaml`. No model is
involved, so identical inputs always produce identical output.

Six sections, all computed:

1. **Verified by the machine** — passing assertions written in business language.
2. **Known issues — do not re-report** — stops duplicate tickets.
3. **NOT verified** — features whose test never ran, changed files owned by an unverified
   feature, changed files owned by **no** feature, and the human-only checks.
4. **High-risk areas** — `risk: high` features whose files changed, plus sensitive paths.
5. **Reproduce the environment** — commands and throwaway accounts.
6. **Tester checklist** — the gaps as `- [ ] QA-n`, highest risk first.

`docs/features.yaml` is the only file a team maintains per release:

```yaml
features:
  - id: orders
    name: "Orders"
    risk: high
    paths: ["app/server.mjs", "app/migrations/**"]
    e2e: ["tests/e2e/orders.spec.ts"]
    criteria: ["a created order appears in my own list"]
can_not_cover:
  - "real confirmation email (CI blocks outbound traffic)"
```

Each test declares how it reads to a human:

```ts
test('Cancel an order', {
  annotation: { type: 'business', description: 'a freshly created order can be cancelled' },
}, async ({ page }) => { /* ... */ });
```

## The rule that makes quality compound

> **Every bug a tester finds must be paid back with one test.**

```
tester confirms -> finds a bug
    ├─ fix it
    └─ add an e2e test, or an acceptance criterion to features.yaml
                    ↓
        next release: that item moves from "NOT verified" to "Verified"
                    ↓
        the tester checklist shrinks instead of growing
```

Without this rule the checklist grows every release and testers re-walk the same paths
forever. With it, the "less work reaching the tester" goal becomes measurable.

## Metrics worth tracking

| Metric | Direction | Meaning |
|---|---|---|
| PR lead time (open → merge) | down | manual work actually shrank |
| % PRs merged with zero human comments | up | the machine caught it first |
| e2e flake rate | < 2% | above this, people bypass the gate |
| Reviewer precision on the golden set | > 60% | a noisy bot gets muted |
| **Escaped defects per week** | down | the only number that proves quality |
| Time to rollback | < 2 min | dominates user-visible damage |

## Security notes

- AI review runs on `pull_request` (never `pull_request_target`) and is skipped for fork PRs,
  because fork events receive no secrets.
- The report is produced from read-only inputs; nothing writes to a database or to memory.
- All browser automation is headless. No window is opened on a developer's desktop.
- `.env.test` and `deploy/*.txt` hold demo state only. Real credentials live in CI secrets.

## Deliberately excluded

Patterns that pay off at thousands of pull requests per day, not one or two per week:
a product-direction gate before review, multi-stage approval pipelines, custom
comment-positioning modules, self-hosted model endpoints, and a preview environment per PR
(start with e2e against the Compose stack; add previews when the shared environment flakes).

## Known limitations

- Gap detection is **path and feature based**: it answers "does any test own this file", not
  "is this line covered". Wire in a coverage summary if line-level precision is needed.
- The AI review step needs an OpenAI-compatible endpoint; verify `ocr config` flags for the
  installed version.
- `seed-demo` is a demo profile. A real deployment seeds through its own migration or admin path.
