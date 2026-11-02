#!/usr/bin/env python3
"""Build the QA handoff document from real pipeline evidence.

Inputs
  artifacts/playwright.json   e2e results (each test carries a `business` annotation)
  docs/features.yaml          feature <-> e2e test <-> owned paths <-> acceptance criteria
  docs/qa/known-issues.yaml   bugs already known, testers should not re-report
  git diff <base>...HEAD      which files changed, and whether a test owns them

Outputs
  reports/qa-<version>.md     the document a tester reads (and confirms)
  reports/qa-<version>.json   machine copy, used to track gaps shrinking over releases

The gap section is the point of this tool: it is computed, never guessed.
"""
import argparse
import datetime
import fnmatch
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Paths where a mistake costs the most; used only to order the tester's attention.
RISKY_PATH = re.compile(
    r"(auth|login|session|payment|pay|billing|checkout|migration|\.sql$|"
    r"docker-compose|Dockerfile|\.env|lock$|\.lockb$)", re.I)

IGNORED_CHANGES = ("reports/", "artifacts/", "docs/qa/", "test-results/")


def sh(*cmd):
    try:
        return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                              check=True).stdout.strip()
    except Exception:
        return ""


def die(msg):
    print(f"qa-report: {msg}", file=sys.stderr)
    sys.exit(2)


def load_yaml_or_json(path):
    raw = open(path, encoding="utf-8").read()
    if path.endswith((".yaml", ".yml")):
        try:
            import yaml
        except ImportError:
            die("pyyaml is required for YAML inputs (`pip install pyyaml`)")
        return yaml.safe_load(raw) or {}
    return json.loads(raw) or {}


def collect_specs(node, out):
    """A Playwright JSON report is a tree of nested suites."""
    for child in node.get("suites") or []:
        collect_specs(child, out)
    out.extend(node.get("specs") or [])
    return out


def load_results(path):
    if not os.path.exists(path):
        die(f"missing {path} — run `make e2e` first")
    rows = []
    for spec in collect_specs(json.load(open(path, encoding="utf-8")), []):
        for test in spec.get("tests") or []:
            results = test.get("results") or []
            statuses = [(r.get("status") or "").lower() for r in results]
            if statuses and all(s == "passed" for s in statuses):
                status = "passed"
            elif statuses and all(s == "skipped" for s in statuses):
                status = "skipped"
            else:
                status = "failed"
            business = next((a.get("description") for a in test.get("annotations") or []
                             if a.get("type") in ("business", "mo-ta-nghiep-vu")), None)
            shots = [a.get("path") for r in results for a in (r.get("attachments") or [])
                     if str(a.get("contentType", "")).startswith("image")]
            rows.append({
                "file": (spec.get("file") or "").replace("\\", "/"),
                "title": spec.get("title") or test.get("title") or "?",
                "desc": business or spec.get("title") or "?",
                "status": status,
                "screenshots": [s for s in shots if s],
            })
    return rows


def changed_files(base):
    if not base:
        return []
    out = (sh("git", "diff", "--name-only", f"{base}...HEAD")
           or sh("git", "diff", "--name-only", base, "HEAD"))
    return [p for p in out.splitlines()
            if p.strip() and not p.startswith(IGNORED_CHANGES)]


def commits_in_range(base):
    if not base:
        return []
    return [l for l in sh("git", "log", f"{base}..HEAD", "--pretty=%h %s").splitlines() if l.strip()]


def owners_of(path, features):
    return [f for f in features if any(fnmatch.fnmatch(path, g) for g in (f.get("paths") or []))]


def main():
    ap = argparse.ArgumentParser(description="Generate the QA handoff document.")
    ap.add_argument("--features", default=os.path.join(ROOT, "docs", "features.yaml"))
    ap.add_argument("--results", default=os.path.join(ROOT, "artifacts", "playwright.json"))
    ap.add_argument("--known", default=os.path.join(ROOT, "docs", "qa", "known-issues.yaml"))
    ap.add_argument("--base", default=os.environ.get("QA_BASE", "HEAD~1"),
                    help="git ref to diff against (the release baseline)")
    ap.add_argument("--version", default=os.environ.get("QA_VERSION", ""))
    ap.add_argument("--digest", default=os.environ.get("IMAGE_DIGEST", "n/a"))
    ap.add_argument("--env-url", default=os.environ.get("QA_ENV_URL", "local"))
    ap.add_argument("--pr", default=os.environ.get("QA_PRS", ""),
                    help="comma-separated pull request numbers")
    ap.add_argument("--outdir", default=os.path.join(ROOT, "reports"))
    args = ap.parse_args()

    if not os.path.exists(args.features):
        die(f"missing {args.features}")
    cfg = load_yaml_or_json(args.features)
    features = cfg.get("features") or []
    can_not_cover = cfg.get("can_not_cover") or []

    known = []
    if os.path.exists(args.known):
        known = load_yaml_or_json(args.known).get("known_issues") or []
    known_markers = [k.get("match") for k in known if k.get("match")]

    results = load_results(args.results)
    version = (args.version or sh("git", "describe", "--tags", "--always")
               or datetime.date.today().isoformat())
    prs = [p.strip() for p in args.pr.split(",") if p.strip()]

    by_file = {}
    for row in results:
        by_file.setdefault(row["file"], []).append(row)

    def resolve(declared):
        """Playwright reports spec.file relative to testDir, so match on suffix."""
        want = declared[2:] if declared.startswith("./") else declared
        hits = []
        for key, rows in by_file.items():
            k = key.replace("\\", "/")
            if k == want or k.endswith("/" + want) or want.endswith("/" + k):
                hits.extend(rows)
        return hits

    # ---- classify every declared feature
    passed, known_failing, uncovered = [], [], []
    for f in features:
        files = [e.replace("\\", "/") for e in (f.get("e2e") or [])]
        if not files:
            uncovered.append({"feature": f, "why": "no e2e test declared"})
            continue
        rows = [r for fn in files for r in resolve(fn)]
        if not rows:
            uncovered.append({"feature": f, "why": "declared test never ran (file missing)"})
            continue
        fails = [r for r in rows if r["status"] == "failed"]
        passes = [r for r in rows if r["status"] == "passed"]
        if fails and all(any(m in r["title"] for m in known_markers) for r in fails):
            known_failing.append({"feature": f, "rows": fails})
        elif fails:
            uncovered.append({"feature": f, "why": "e2e test is FAILING", "rows": fails})
        elif passes:
            passed.append({"feature": f, "rows": passes})
        else:
            uncovered.append({"feature": f, "why": "e2e test was skipped"})

    uncovered_ids = {u["feature"]["id"] for u in uncovered}

    # ---- changed files that no verified test owns
    changes = changed_files(args.base)
    unmapped, owned_by_unverified = [], []
    for path in changes:
        owners = owners_of(path, features)
        if not owners:
            unmapped.append(path)
        elif any(o["id"] in uncovered_ids for o in owners):
            owned_by_unverified.append(
                (path, [o["name"] for o in owners if o["id"] in uncovered_ids]))

    # ---- risk hotspots
    risky_features = []
    for f in features:
        if str(f.get("risk", "")).lower() != "high":
            continue
        touched = [p for p in changes if any(fnmatch.fnmatch(p, g) for g in (f.get("paths") or []))]
        if touched:
            risky_features.append((f["name"], len(touched)))
    risky_paths = [p for p in changes if RISKY_PATH.search(p)]

    # ---- tester checklist, gaps first
    checks = []
    for name, n in risky_features:
        f = next(x for x in features if x["name"] == name)
        checks.append(f"**high risk · {name}** ({n} file{'s' if n > 1 else ''} changed) — "
                      f"manually verify: " + "; ".join(f.get("criteria") or ["(no criteria declared)"]))
    for u in uncovered:
        checks.append(f"**{u['feature']['name']}** — {u['why']}; verify: "
                      + "; ".join(u["feature"].get("criteria") or ["(no criteria declared)"]))
    for path, names in owned_by_unverified:
        checks.append(f"`{path}` changed and is owned by unverified feature(s) "
                      f"{', '.join(names)}")
    for path in unmapped[:5]:
        checks.append(f"`{path}` changed but belongs to no declared feature — confirm the behaviour")
    for item in can_not_cover:
        checks.append(f"cannot be covered by machine: {item}")

    # ---- render
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    n_ok, n_all = len(passed), len(features)
    gap_count = len(uncovered) + len(owned_by_unverified) + len(unmapped)
    L = [
        f"# QA Handoff — Release {version}",
        "",
        f"`{ts}` · image digest `{args.digest}` · target `{args.env_url}`",
        "",
        f"- Pull requests: {', '.join('#' + p for p in prs) if prs else '(none declared)'}",
        f"- Commits in range: {len(commits_in_range(args.base))} · files changed: {len(changes)}",
        f"- Automated coverage: {n_ok}/{n_all} declared areas verified",
        "",
        "## ✅ Verified by the machine",
        "",
    ]
    if passed:
        L += ["| Area | What was checked | Result |", "|---|---|---|"]
        for p in passed:
            for r in p["rows"]:
                ev = f"`{r['screenshots'][0]}`" if r["screenshots"] else "`artifacts/playwright.json`"
                L.append(f"| {p['feature']['name']} | {r['desc']} | pass · {ev} |")
    else:
        L.append("_Nothing passed. Do not approve this release._")
    L.append("")

    L += ["## ⚠️ Known issues — do not re-report", ""]
    known_lines = [f"- {k.get('title', '?')}"
                   + (f" (#{k['pr']})" if k.get("pr") else "")
                   + (f" — {k['note']}" if k.get("note") else "") for k in known]
    known_lines += [f"- {f['feature']['name']}: known failing e2e test" for f in known_failing]
    L += known_lines or ["_None._"]
    L.append("")

    L += ["## ❌ NOT verified — this is where a human is needed", ""]
    gaps = [f"- **{u['feature']['name']}** — {u['why']}"
            + (f" (`paths`: {', '.join(u['feature'].get('paths') or [])})"
               if u["feature"].get("paths") else "") for u in uncovered]
    gaps += [f"- **{', '.join(names)}** — `{path}` changed, current test does not cover it"
             for path, names in owned_by_unverified]
    if unmapped:
        gaps.append(f"- **Unmapped changes** — {len(unmapped)} file(s) belong to no declared feature: "
                    + ", ".join(f"`{p}`" for p in unmapped[:8])
                    + (" …" if len(unmapped) > 8 else ""))
    gaps += [f"- {item}" for item in can_not_cover]
    L += gaps or ["_No gaps detected — check that `docs/features.yaml` is not empty._"]
    L.append("")

    if risky_features or risky_paths:
        L += ["## 🔥 High-risk areas in this release", ""]
        L += [f"- {name} ({n} file{'s' if n > 1 else ''} changed)" for name, n in risky_features]
        if risky_paths:
            L.append("- sensitive paths touched: " + ", ".join(f"`{p}`" for p in risky_paths[:8]))
        L.append("")

    L += [
        "## ▶️ Reproduce the environment",
        "",
        "```bash",
        "make up && make seed && make e2e",
        "```",
        "",
        "Test accounts live in `.env.test` (committed on purpose — never use real credentials).",
        "",
        "## ☑️ Tester checklist",
        "",
    ]
    if checks:
        L += [f"- [ ] **QA-{i}** {c}" for i, c in enumerate(checks, 1)]
    else:
        L.append("- [ ] No gap detected — exploratory testing still applies.")
    L += [
        "",
        "---",
        "_Generated by `make qa-report` from the pipeline's own artefacts. "
        "Every bug found here must be paid back with one test, so the ❌ section shrinks each release._",
    ]

    os.makedirs(args.outdir, exist_ok=True)
    md_path = os.path.join(args.outdir, f"qa-{version}.md")
    json_path = os.path.join(args.outdir, f"qa-{version}.json")
    open(md_path, "w", encoding="utf-8").write("\n".join(L) + "\n")
    json.dump({
        "version": version,
        "generated_at": ts,
        "digest": args.digest,
        "verified": [p["feature"]["id"] for p in passed],
        "known_failing": [f["feature"]["id"] for f in known_failing],
        "unverified": [{"id": u["feature"]["id"], "why": u["why"]} for u in uncovered],
        "unmapped_changes": unmapped,
        "checklist": checks,
    }, open(json_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print(f"qa-report: {md_path}")
    print(f"  verified {n_ok}/{n_all} · gaps {gap_count} · checklist {len(checks)} items")


if __name__ == "__main__":
    main()
