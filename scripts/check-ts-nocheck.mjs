#!/usr/bin/env node
// @ts-nocheck ratchet guard (NEX-140).
//
// Why this exists: NEX-25 typed `app/_layout.tsx` and made `tsc --noEmit` a
// required CI check, but nothing stopped a later PR from re-adding `// @ts-nocheck`
// — and commit 937e1bb (2026-03-27) did exactly that to `_layout.tsx`, silently
// reverting the win. `tsc` stays green because the directive suppresses the file,
// so the typecheck gate never noticed. This script is the missing ratchet: the set
// of files allowed to carry `// @ts-nocheck` is committed in
// `docs/ts-nocheck-allowlist.txt`, and CI fails if any file carries the directive
// without being on the list. The count can only go DOWN (remove a directive ->
// drop it from the allowlist in the same, reviewable PR). A new directive on ANY
// file — touched or not — fails, which the diff-scoped `lint` job could not catch.
//
// Detection: a `// @ts-nocheck` LINE comment (not a ` * @ts-nocheck` mention inside a JSDoc
// block — that is prose, e.g. giving-screen.tsx's "removed in PR #15"). Intentionally a touch
// broader than TypeScript's own rule (it also catches a mid-file or trailing `// @ts-nocheck`
// that TS would ignore) — erring toward "catch" is the right bias for a ratchet.
//
// Run: `node scripts/check-ts-nocheck.mjs` (invoked directly in CI; no npm script wrapper).

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = 'docs/ts-nocheck-allowlist.txt';

const DIRECTIVE_RE = /^\s*\/\/\s*@ts-nocheck\b/m;

function gitTrackedTsFiles() {
  // Exclude `.nexus-backups/**` — it is tracked (not gitignored) and holds ~50 frozen
  // snapshots of source files, several of them copies of allowlisted paths. A snapshot that
  // ever captured a directive would land at a path the allowlist can't match and red every PR.
  const out = execSync("git ls-files '*.ts' '*.tsx' ':(exclude).nexus-backups/**'", {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function readAllowlist() {
  const p = resolve(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(p)) {
    console.error(`[ts-nocheck guard] missing allowlist: ${ALLOWLIST_PATH}`);
    process.exit(2);
  }
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

const files = gitTrackedTsFiles();
const withDirective = files.filter((f) => {
  try {
    return DIRECTIVE_RE.test(readFileSync(resolve(repoRoot, f), 'utf8'));
  } catch {
    return false;
  }
});

const allowlist = readAllowlist();
const allowSet = new Set(allowlist);
const presentSet = new Set(withDirective);

const unlisted = withDirective.filter((f) => !allowSet.has(f)); // NEW debt — fatal
const stale = allowlist.filter((f) => !presentSet.has(f)); // already cleaned — soft

if (stale.length) {
  console.warn(`[ts-nocheck guard] ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} (no longer in code — drop from ${ALLOWLIST_PATH}):`);
  for (const f of stale) console.warn(`  - ${f}`);
}

if (unlisted.length) {
  console.error(`\n[ts-nocheck guard] FAIL: ${unlisted.length} file(s) carry // @ts-nocheck but are not on the allowlist:`);
  for (const f of unlisted) console.error(`  + ${f}`);
  console.error(`\nThe @ts-nocheck count can only go down. If this is genuinely unavoidable, add the path to`);
  console.error(`${ALLOWLIST_PATH} with a one-line reason + a Linear follow-up — that edit is visible in review.`);
  console.error(`Otherwise remove the directive and fix the surfaced type errors (NEX-140).`);
  process.exit(1);
}

console.log(`[ts-nocheck guard] OK — ${withDirective.length} allowlisted file(s) carry // @ts-nocheck, none unlisted.`);
