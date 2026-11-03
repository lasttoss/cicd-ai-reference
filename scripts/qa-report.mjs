#!/usr/bin/env node
/**
 * Build the QA handoff document from real pipeline evidence.
 *
 * Inputs
 *   artifacts/results.json | .xml   test results — Playwright JSON or JUnit XML
 *   docs/features.yaml              feature <-> test file <-> owned paths <-> criteria
 *   docs/qa/known-issues.yaml       bugs already known, testers should not re-report
 *   git diff <base>...HEAD          which files changed, and whether a test owns them
 *
 * Outputs
 *   reports/qa-<version>.md         the document a tester reads and confirms
 *   reports/qa-<version>.json       machine copy, used to track gaps shrinking per release
 *
 * Deliberately dependency-light: Node only, no Python, no language-specific runner.
 * The gap section is computed, never guessed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RISKY = /(auth|login|session|payment|pay|billing|checkout|migration|\.sql$|docker-compose|Dockerfile|\.env|lock$)/i;
const IGNORED = ['reports/', 'artifacts/', 'docs/qa/', 'test-results/'];

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const env = process.env;
const opt = (k, d) => (args[k] !== undefined && args[k] !== true ? args[k] : d);

const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const base = opt('base', env.QA_BASE || 'HEAD~1');
const outdir = resolvePath(opt('outdir', 'reports'));
const resultsPath = resolvePath(opt('results', 'artifacts/playwright.json'));
const featuresPath = resolvePath(opt('features', 'docs/features.yaml'));
const knownPath = resolvePath(opt('known', 'docs/qa/known-issues.yaml'));
const digest = opt('digest', env.IMAGE_DIGEST || 'n/a');
const envUrl = opt('env-url', env.QA_ENV_URL || 'local');
const prs = String(opt('pr', env.QA_PRS || '')).split(',').map((s) => s.trim()).filter(Boolean);

// Path glob -> RegExp. Escape first, then expand wildcards, or `**` becomes garbage.
const glob = (g) => {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = esc.split('**').join('\u0000').split('*').join('[^/]*').split('\u0000').join('.*');
  return new RegExp(`^${rx}$`);
};

const sh = (...cmd) => {
  try { return execFileSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const die = (m) => { console.error(`qa-report: ${m}`); process.exit(2); };

// ---------- results: one normalised shape regardless of the test runner ----------
const norm = (o) => ({ file: (o.file || '').replace(/\\/g, '/'), title: o.title,
  business: o.business || o.title, status: o.status, evidence: o.evidence || [] });

function fromJunit(xml) {
  const rows = [];
  const cases = xml.match(/<testcase\b[^>]*>[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g) || [];
  const attr = (tag, name) => (tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';
  for (const c of cases) {
    const open = c.match(/<testcase\b[^>]*>/)[0];
    const business = (c.match(/<property\s+name="business"\s+value="([^"]*)"/) || [])[1];
    const name = attr(open, 'name');
    const status = /<failure|<error/.test(c) ? 'failed' : /<skipped/.test(c) ? 'skipped' : 'passed';
    rows.push(norm({ file: attr(open, 'file') || attr(open, 'classname'),
      title: name, business: business || name, status }));
  }
  return rows;
}

function fromPlaywright(json) {
  const rows = [];
  let root;
  try { root = JSON.parse(readFileSync(json, 'utf8')); } catch { return rows; }
  const walk = (n) => {
    for (const s of n.suites || []) walk(s);
    for (const spec of n.specs || []) {
      for (const t of spec.tests || []) {
        const rs = t.results || [];
        const st = rs.length && rs.every((r) => r.status === 'passed') ? 'passed'
          : rs.length && rs.every((r) => r.status === 'skipped') ? 'skipped' : 'failed';
        const business = (t.annotations || []).find((a) => a.type === 'business')?.description;
        const evidence = rs.flatMap((r) => (r.attachments || [])
          .filter((a) => String(a.contentType || '').startsWith('image')).map((a) => a.path));
        rows.push(norm({ file: spec.file, title: spec.title, business, status: st,
          evidence: evidence.filter(Boolean) }));
      }
    }
  };
  walk(root);
  return rows;
}

if (!existsSync(resultsPath)) die(`missing ${resultsPath} — run \`make e2e\` first`);
const raw = readFileSync(resultsPath, 'utf8').trimStart();
const results = raw.startsWith('<') ? fromJunit(raw) : fromPlaywright(resultsPath);
if (!results.length) die(`${resultsPath} contained no test cases`);

// ---------- config ----------
const readYaml = (p, fallback) => (existsSync(p) ? parseYaml(readFileSync(p, 'utf8')) || fallback : fallback);
const cfg = readYaml(featuresPath, {});
const features = cfg.features || [];
const canNotCover = cfg.can_not_cover || [];
const ignorePaths = cfg.ignore_paths || [];
const known = readYaml(knownPath, {}).known_issues || [];
const markers = known.map((k) => k.match).filter(Boolean);
if (!features.length) die(`${featuresPath} declares no features`);

const version = opt('version', env.QA_VERSION
  || sh('git', 'describe', '--tags', '--always') || new Date().toISOString().slice(0, 10));

// Playwright reports spec.file relative to testDir, so match on suffix.
const resolve = (declared) => {
  const want = declared.replace(/^\.\//, '');
  return results.filter((r) => r.file === want || r.file.endsWith(`/${want}`) || want.endsWith(`/${r.file}`));
};

// ---------- classify ----------
const verified = [], knownFailing = [], unverified = [];
for (const f of features) {
  const files = (f.e2e || []).map((e) => e.replace(/\\/g, '/'));
  if (!files.length) { unverified.push({ feature: f, why: 'no test declared' }); continue; }
  const rows = files.flatMap(resolve);
  if (!rows.length) { unverified.push({ feature: f, why: 'declared test never ran (file missing)' }); continue; }
  const failing = rows.filter((r) => r.status === 'failed');
  const passing = rows.filter((r) => r.status === 'passed');
  if (failing.length && failing.every((r) => markers.some((m) => r.title.includes(m)))) {
    knownFailing.push({ feature: f, rows: failing });
  } else if (failing.length) unverified.push({ feature: f, why: 'test is FAILING', rows: failing });
  else if (passing.length) verified.push({ feature: f, rows: passing });
  else unverified.push({ feature: f, why: 'test was skipped' });
}
const unverifiedIds = new Set(unverified.map((u) => u.feature.id));

// ---------- criteria coverage ----------
// A feature counts as "verified" as soon as one of its declared test files passes, which hides a
// criterion nobody wrote a test for — the report then claims coverage it does not have. Compare
// each declared criterion against the business annotation of the passing rows instead.
const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.;]$/, '').trim();
const uncoveredCriteria = [];
for (const v of verified) {
  const covered = new Set(v.rows.map((r) => normText(r.business)));
  for (const criterion of (v.feature.criteria || [])) {
    if (!covered.has(normText(criterion))) uncoveredCriteria.push({ feature: v.feature, criterion });
  }
}
const allCriteria = features.reduce((n, f) => n + (f.criteria || []).length, 0);
// Only criteria of verified features can be proven. Subtracting from allCriteria would count a
// criterion belonging to a feature with no tests as covered — the exact false claim this file
// exists to prevent.
const coveredCriteria = verified.reduce((n, v) => n + (v.feature.criteria || []).length, 0)
  - uncoveredCriteria.length;

// ---------- changed files ----------
const changes = (base ? (sh('git', 'diff', '--name-only', `${base}...HEAD`)
  || sh('git', 'diff', '--name-only', base, 'HEAD')) : '')
  .split('\n').filter((p) => p && !IGNORED.some((i) => p.startsWith(i)));
const owns = (path, f) => (f.paths || []).some((g) => glob(g).test(path));

const isIgnored = (p) => ignorePaths.some((g) => glob(g).test(p));

const unmapped = [], ownedByUnverified = [];
for (const path of changes) {
  if (isIgnored(path)) continue;
  const owners = features.filter((f) => owns(path, f));
  if (!owners.length) unmapped.push(path);
  else if (owners.some((o) => unverifiedIds.has(o.id))) {
    ownedByUnverified.push([path, owners.filter((o) => unverifiedIds.has(o.id)).map((o) => o.name)]);
  }
}

const riskyFeatures = features
  .filter((f) => String(f.risk || '').toLowerCase() === 'high')
  .map((f) => [f.name, changes.filter((p) => owns(p, f)).length])
  .filter(([, n]) => n > 0);
const riskyPaths = changes.filter((p) => RISKY.test(p));

// ---------- tester checklist, highest risk first ----------
const checks = [];
for (const [name] of riskyFeatures) {
  const f = features.find((x) => x.name === name);
  checks.push(`**high risk · ${name}** — manually verify: ${(f.criteria || ['(none declared)']).join('; ')}`);
}
for (const u of unverified) {
  checks.push(`**${u.feature.name}** — ${u.why}; verify: ${(u.feature.criteria || ['(none declared)']).join('; ')}`);
}
for (const [path, names] of ownedByUnverified) {
  checks.push(`\`${path}\` changed and is owned by unverified feature(s): ${names.join(', ')}`);
}
for (const path of unmapped.slice(0, 5)) {
  checks.push(`\`${path}\` changed but belongs to no declared feature — confirm the behaviour`);
}
for (const item of canNotCover) checks.push(`cannot be covered by machine: ${item}`);
for (const u of uncoveredCriteria) {
  checks.push(`${u.feature.name}: confirm "${u.criterion}" — no test asserts it yet`);
}

// ---------- render ----------
const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const gapCount = unverified.length + ownedByUnverified.length + unmapped.length
  + uncoveredCriteria.length;
const L = [
  `# QA Handoff — Release ${version}`, '',
  `\`${ts}\` · image digest \`${digest}\` · target \`${envUrl}\``, '',
  `- Pull requests: ${prs.length ? prs.map((p) => `#${p}`).join(', ') : '(none declared)'}`,
  `- Commits in range: ${base ? sh('git', 'log', `${base}..HEAD`, '--pretty=%h %s').split('\n').filter(Boolean).length : 0}`
    + ` · files changed: ${changes.length}`,
  `- Automated coverage: ${verified.length}/${features.length} declared areas verified`
    + ` · criteria proven: ${coveredCriteria}/${allCriteria}`, '',
  '## ✅ Verified by the machine', '',
];
if (verified.length) {
  L.push('| Area | What was checked | Result |', '|---|---|---|');
  for (const v of verified) for (const r of v.rows) {
    L.push(`| ${v.feature.name} | ${r.business} | pass · ${r.evidence[0] ? `\`${r.evidence[0]}\`` : '`artifacts/`'} |`);
  }
} else L.push('_Nothing passed. Do not approve this release._');
L.push('');

L.push('## ⚠️ Known issues — do not re-report', '');
const knownLines = known.map((k) => `- ${k.title}${k.pr ? ` (#${k.pr})` : ''}${k.note ? ` — ${k.note}` : ''}`)
  .concat(knownFailing.map((k) => `- ${k.feature.name}: known failing test`));
L.push(...(knownLines.length ? knownLines : ['_None._']), '');

L.push('## ❌ NOT verified — this is where a human is needed', '');
const gaps = unverified.map((u) => `- **${u.feature.name}** — ${u.why}`
  + ((u.feature.paths || []).length ? ` (\`paths\`: ${u.feature.paths.join(', ')})` : ''))
  .concat(ownedByUnverified.map(([p, names]) => `- **${names.join(', ')}** — \`${p}\` changed, current test does not cover it`));
gaps.push(...uncoveredCriteria.map((u) => `- **${u.feature.name}** — declared criterion has no passing test: `
  + `"${u.criterion}"`));
if (unmapped.length) {
  gaps.push(`- **Unmapped changes** — ${unmapped.length} file(s) belong to no declared feature: `
    + unmapped.slice(0, 8).map((p) => `\`${p}\``).join(', ') + (unmapped.length > 8 ? ' …' : ''));
}
gaps.push(...canNotCover.map((c) => `- ${c}`));
L.push(...(gaps.length ? gaps : ['_No gaps detected — check that docs/features.yaml is not empty._']), '');

if (riskyFeatures.length || riskyPaths.length) {
  L.push('## 🔥 High-risk areas in this release', '');
  L.push(...riskyFeatures.map(([n, c]) => `- ${n} (${c} file${c > 1 ? 's' : ''} changed)`));
  if (riskyPaths.length) L.push(`- sensitive paths touched: ${riskyPaths.slice(0, 8).map((p) => `\`${p}\``).join(', ')}`);
  L.push('');
}

L.push('## ▶️ Reproduce the environment', '', '```bash', 'make up', '```', '',
  'Test accounts live in `.env.test` (committed on purpose — never real credentials).', '',
  '## ☑️ Tester checklist', '');
L.push(...(checks.length ? checks.map((c, i) => `- [ ] **QA-${i + 1}** ${c}`)
  : ['- [ ] No gap detected — exploratory testing still applies.']));
L.push('', '---',
  '_Generated from the pipeline\'s own artefacts. Every bug found here must be paid back with one test, '
  + 'so the ❌ section shrinks each release._');

mkdirSync(outdir, { recursive: true });
const md = join(outdir, `qa-${version}.md`), js = join(outdir, `qa-${version}.json`);
writeFileSync(md, L.join('\n') + '\n');
writeFileSync(js, JSON.stringify({ version, generated_at: ts, digest,
  verified: verified.map((v) => v.feature.id),
  known_failing: knownFailing.map((k) => k.feature.id),
  unverified: unverified.map((u) => ({ id: u.feature.id, why: u.why })),
  uncovered_criteria: uncoveredCriteria.map((u) => ({ id: u.feature.id, criterion: u.criterion })),
  unmapped_changes: unmapped, checklist: checks }, null, 2));
console.log(`qa-report: ${md}`);
console.log(`  source ${basename(resultsPath)} (${raw.startsWith('<') ? 'junit xml' : 'playwright json'})`);
console.log(`  verified ${verified.length}/${features.length} · criteria ${coveredCriteria}/${allCriteria}`
  + ` · gaps ${gapCount} · checklist ${checks.length}`);
