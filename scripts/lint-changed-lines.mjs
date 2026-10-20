// Diff-aware lint gate (NEX-115). Replaces the whole-changed-file `eslint` run in
// the CI `lint` job with one that fails ONLY on eslint ERRORS introduced on the
// PR's CHANGED LINES — for every rule. New code stays fully gated; pre-existing
// debt in a touched file never blocks a PR (the keystone harness blocker — see
// docs/plans/nex-115-diff-aware-lint-gate.md).
//
// Behavior contract (kept identical to the bash step it replaces):
//   - base ref unresolvable  -> exit 0 (green)
//   - no changed JS/TS files -> exit 0 (green)
//   - eslint fails to start   -> exit 1 (never silent green)
//
// Known limitation (accepted, documented): a rule that reports at an UNCHANGED
// site whose cause is a changed line (e.g. no-unused-vars at a declaration whose
// last use was deleted) is NOT caught here. typecheck + Greptile are the backstop.
// Hardening to baseline-vs-head diffing is a future option, not v1.

import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_GLOBS = ['*.js', '*.jsx', '*.cjs', '*.mjs', '*.ts', '*.tsx'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function baseRef() {
  const ref = process.env.GITHUB_BASE_REF || process.argv[2] || '';
  return ref ? `origin/${ref}` : '';
}

function baseResolvable(base) {
  if (!base) return false;
  try {
    execFileSync('git', ['rev-parse', '--verify', base], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Parse `git diff --name-status -z --find-renames` output into [{ path, status }].
// status is the first letter (A/C/M/R); for R/C the destination path is used.
// Exported for unit testing.
export function parseNameStatus(zOutput) {
  const tokens = zOutput.split('\0').filter((t) => t.length > 0);
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      i++; // skip the source path
      const dest = tokens[i++];
      out.push({ path: dest, status: letter });
    } else {
      const p = tokens[i++];
      out.push({ path: p, status: letter });
    }
  }
  return out;
}

// NEW-side changed line numbers from a single file's `git diff --unified=0` body.
// Handles `@@ -a,b +c,d @@`, omitted count (`+c` => 1 line), and `,0` (pure
// deletion => contributes nothing). Multiple hunks union. Exported for testing.
export function changedLinesForFile(diffText) {
  const set = new Set();
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of diffText.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return set;
}

function rangeIntersects(start, end, set) {
  if (!set || set.size === 0) return false;
  if (!Number.isInteger(start)) return false;
  const e = Number.isInteger(end) ? end : start;
  for (let l = start; l <= e; l++) {
    if (set.has(l)) return true;
  }
  return false;
}

// Pure filter. results: [{ relPath, messages }]; changedMap: Map<relPath, Set<line>>;
// addedSet: Set<relPath>. Keeps a message iff it is an ERROR (severity 2) AND it is
// fatal (parse/config error — always fails), OR the file is newly Added (whole file
// is the PR's), OR its [line, endLine] range intersects a changed line. Exported.
export function filterMessages(results, changedMap, addedSet) {
  const kept = [];
  for (const { relPath, messages } of results) {
    const set = changedMap.get(relPath);
    const isAdded = addedSet.has(relPath);
    for (const m of messages) {
      if (m.severity !== 2) continue;
      const reason = m.fatal
        ? 'fatal'
        : isAdded
          ? 'added-file'
          : rangeIntersects(m.line, m.endLine, set)
            ? 'changed-line'
            : null;
      if (reason) {
        kept.push({
          file: relPath,
          line: m.line ?? 0,
          rule: m.ruleId || '(fatal)',
          message: m.message,
          reason,
        });
      }
    }
  }
  return kept;
}

async function main() {
  const base = baseRef();
  if (!baseResolvable(base)) {
    console.log(`Base ref '${base || '(unset)'}' not resolvable — nothing to lint (green).`);
    return 0;
  }

  const files = parseNameStatus(
    git([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--diff-filter=ACMR',
      `${base}...HEAD`,
      '--',
      ...JS_GLOBS,
    ]),
  );
  if (files.length === 0) {
    console.log('No changed JS/TS files to lint (green).');
    return 0;
  }

  const addedSet = new Set(files.filter((f) => f.status === 'A').map((f) => f.path));
  const changedMap = new Map();
  for (const f of files) {
    changedMap.set(
      f.path,
      changedLinesForFile(git(['diff', '--unified=0', `${base}...HEAD`, '--', f.path])),
    );
  }

  console.log(`Diff-aware lint over ${files.length} changed file(s):`);
  for (const f of files) console.log(`  ${f.status}  ${f.path}`);

  const eslint = new ESLint({ warnIgnored: false });
  // Drop files eslint is configured to ignore (dist/*, supabase/functions/**,
  // .nexus-backups/**) — they still match JS_GLOBS, but passing them to lintFiles
  // throws "All files ... are ignored" when nothing else remains, which would red a
  // PR that only touched ignored paths. (deno-check covers supabase/functions.)
  const lintable = [];
  for (const f of files) {
    if (!(await eslint.isPathIgnored(f.path))) lintable.push(f.path);
  }
  if (lintable.length === 0) {
    console.log('All changed JS/TS files are eslint-ignored — nothing to lint (green).');
    return 0;
  }
  let results;
  try {
    results = await eslint.lintFiles(lintable);
  } catch (err) {
    console.error('ESLint failed to run (treated as failure):');
    console.error(err && err.message ? err.message : err);
    return 1;
  }

  const cwd = process.cwd();
  const norm = results.map((r) => ({
    relPath: path.relative(cwd, r.filePath),
    messages: r.messages,
  }));
  const kept = filterMessages(norm, changedMap, addedSet);

  if (kept.length === 0) {
    console.log('No new lint errors on changed lines.');
    return 0;
  }
  console.error(`\n${kept.length} lint error(s) introduced by this change:`);
  for (const k of kept) {
    console.error(`  ${k.file}:${k.line}  [${k.rule}] ${k.message}  (${k.reason})`);
  }
  return 1;
}

// Only run main() as a CLI; importing for tests must not execute it. Use
// fileURLToPath (not new URL().pathname, which stays percent-encoded) so the
// comparison holds when the checkout path contains spaces.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
