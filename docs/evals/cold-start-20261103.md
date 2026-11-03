# Cold-start cost — 2026-11-03T02:32Z

Machine: 16 vCPU · 22 GB RAM
Commit: `055bb80` · steps executed as declared in `.github/workflows/ci.yml`

| Step | ms | share |
|---|---|---|
| npm ci | 590 | 3% |
| playwright install chromium | 532 | 2% |
| docker build (no cache) | 5859 | 32% |
| compose up (db→migrate→seed→app) | 8751 | 48% |
| make ci | 107 | 0% |
| make e2e | 2219 | 12% |
| make qa-report | 63 | 0% |
| **total** | **18121** | 100% |

## What this is and is not

- **Is**: every build/install step the workflow runs, from a clean checkout (no `node_modules`,
  no docker layer cache, no running stack). These are the steps whose cost is platform-independent.
- **Is not**: GitHub runner overhead — machine provisioning, queue wait, artifact upload,
  and `playwright install --with-deps` (apt packages, needs root; expect +40–70 s).
  Those need `gh auth login` and a real run.

## Reading it

- If `total` is dominated by install/build, caching is the only lever worth pulling
  (`actions/cache` on the npm store and the docker layer cache).
- The gate itself is the cheap part; a slow pipeline here is almost never the tests.

## Which caches were warm — read this before quoting the total

| Cache | State here | What a cold runner pays instead |
|---|---|---|
| `node_modules` | cleared before measuring | same |
| docker layer cache | cleared (`--no-cache`) | same |
| docker base images | 2/2 present (node:22-alpine, postgres:16-alpine) | pull ≈ 80 MB, +10–30 s |
| npm package cache | 3.9G in `~/.npm` | +10–20 s |
| playwright browsers | 11 entries in `~/.cache/ms-playwright` | +40–70 s, plus apt deps |
| database volume | dropped | same |

So the measured **18121 ms is a floor, not a forecast.**

## Measured on a clean container — this replaced the estimates above

`docker run --rm node:22` with empty caches, timing only the steps that cannot be measured on a machine
where everything is already installed:

| Step | Warm (this machine) | Cold container | Delta |
|---|---|---|---|
| `npm ci` | 590 ms | 1 241 ms | +0.7 s |
| `playwright install --with-deps chromium` | 532 ms | **58 405 ms** | **+57.9 s** |

Base-image pulls (node:22-alpine + postgres:16-alpine, ~80 MB) add roughly +15–25 s.

**Revised projection for a GitHub runner: ≈97 s, i.e. ~5.4× the local figure** — not the 1.7–2× first
written here. The first estimate was wrong by a factor of three because the dominant cost had never been
executed. `playwright install --with-deps` alone is 60% of the whole cold run.

## What that changes about optimisation

1. **Cache `~/.cache/ms-playwright` first** — restoring it costs ~2 s and removes 58 s of 97 s.
   `actions/cache` on `~/.cache/ms-playwright` keyed by the Playwright version.
2. Cache the docker layers second (≈6–15 s).
3. `npm ci` is noise at 1.2 s; caching it is not worth a step.
