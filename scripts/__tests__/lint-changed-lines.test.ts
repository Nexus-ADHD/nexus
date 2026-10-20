import { describe, it, expect } from 'vitest';
// Pure exports only — no git/eslint I/O, no RN imports (vitest is pure-Node here).
import {
  parseNameStatus,
  changedLinesForFile,
  filterMessages,
} from '../lint-changed-lines.mjs';

describe('changedLinesForFile (the core correctness risk — hunk header parsing)', () => {
  it('expands the FULL new-side range, not just the start line', () => {
    // 5 lines added starting at 11 -> {11,12,13,14,15}
    const diff = `@@ -10,0 +11,5 @@\n+a\n+b\n+c\n+d\n+e`;
    expect([...changedLinesForFile(diff)].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15]);
  });

  it('treats an omitted count as exactly one line', () => {
    expect([...changedLinesForFile('@@ -3 +3 @@')]).toEqual([3]);
  });

  it('treats `,0` (pure deletion) as contributing no new lines', () => {
    expect(changedLinesForFile('@@ -5,2 +4,0 @@').size).toBe(0);
  });

  it('unions multiple hunks', () => {
    const diff = `@@ -1 +1 @@\n+x\n@@ -10,0 +20,2 @@\n+y\n+z`;
    expect([...changedLinesForFile(diff)].sort((a, b) => a - b)).toEqual([1, 20, 21]);
  });

  it('ignores non-hunk lines (file headers, context)', () => {
    const diff = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,1 +2,1 @@ function foo()\n-old\n+new`;
    expect([...changedLinesForFile(diff)]).toEqual([2]);
  });
});

describe('parseNameStatus', () => {
  it('parses A/M and uses the destination path for renames', () => {
    const z = 'A\0a.ts\0M\0b.ts\0R100\0old/c.ts\0new/c.ts\0';
    expect(parseNameStatus(z)).toEqual([
      { path: 'a.ts', status: 'A' },
      { path: 'b.ts', status: 'M' },
      { path: 'new/c.ts', status: 'R' },
    ]);
  });

  it('returns [] for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('filterMessages', () => {
  const changedMap = new Map<string, Set<number>>([['m.ts', new Set([7])]]);

  it('keeps a NEW error on a changed line', () => {
    const r = [{ relPath: 'm.ts', messages: [{ severity: 2, line: 7, ruleId: 'no-undef', message: 'x' }] }];
    const kept = filterMessages(r, changedMap, new Set());
    expect(kept).toHaveLength(1);
    expect(kept[0].reason).toBe('changed-line');
  });

  it('drops a pre-existing error on an unchanged line of a Modified file', () => {
    const r = [{ relPath: 'm.ts', messages: [{ severity: 2, line: 99, ruleId: 'no-undef', message: 'x' }] }];
    expect(filterMessages(r, changedMap, new Set())).toHaveLength(0);
  });

  it('keeps a fatal/parse error regardless of line or A/M status', () => {
    const r = [{ relPath: 'm.ts', messages: [{ severity: 2, fatal: true, message: 'Parsing error' }] }];
    const kept = filterMessages(r, changedMap, new Set());
    expect(kept).toHaveLength(1);
    expect(kept[0].reason).toBe('fatal');
  });

  it('drops warnings even on a changed line', () => {
    const r = [{ relPath: 'm.ts', messages: [{ severity: 1, line: 7, ruleId: 'x', message: 'warn' }] }];
    expect(filterMessages(r, changedMap, new Set())).toHaveLength(0);
  });

  it('keeps ALL errors in an Added file (whole file is the PR)', () => {
    const r = [{ relPath: 'new.ts', messages: [{ severity: 2, line: 1000, ruleId: 'x', message: 'e' }] }];
    const kept = filterMessages(r, new Map(), new Set(['new.ts']));
    expect(kept).toHaveLength(1);
    expect(kept[0].reason).toBe('added-file');
  });

  it('intersects the [line, endLine] range, not just the start line', () => {
    // error spans lines 4..8; only line 7 changed -> still kept
    const r = [{ relPath: 'm.ts', messages: [{ severity: 2, line: 4, endLine: 8, ruleId: 'x', message: 'e' }] }];
    const kept = filterMessages(r, changedMap, new Set());
    expect(kept).toHaveLength(1);
    expect(kept[0].reason).toBe('changed-line');
  });

  it('keys correctly on paren-containing paths', () => {
    const cm = new Map<string, Set<number>>([['app/(tabs)/x.tsx', new Set([3])]]);
    const r = [{ relPath: 'app/(tabs)/x.tsx', messages: [{ severity: 2, line: 3, ruleId: 'x', message: 'e' }] }];
    expect(filterMessages(r, cm, new Set())).toHaveLength(1);
  });
});
