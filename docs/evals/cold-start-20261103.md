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

So the measured **18121 ms is a floor, not a forecast.** Adding the cold-cache costs above puts a
GitHub runner at roughly **1.7–2× this number** before provisioning and queue time are counted.
