// Contract tests for the outbound user_state.state_data allow-list.
//
// Why this file exists: four fields (mandateFocus, nextWeekRuleOverrides,
// pendingMondayIntention, morningIntentionCompletedDate) were RESTORED by
// mergeCloudState but never SENT by buildCloudSyncPayload, so a reinstall
// silently dropped them. The restore code existed and read correctly, which is
// exactly why nobody caught it — no test compared the two directions.
//
// The parity test below is the real guard: a CLASS check, not four assertions.
// Any future field added to mergeCloudState's inbound reads must either ride
// the outbound payload or be listed as a deliberate exclusion with a reason.
//
// Extraction is AST-based rather than a regex. A regex over `cloudState.` was
// the first attempt and it was porous: destructuring, bracket access with a
// string literal, and an alias binding are all valid ways to read an inbound
// field, and all three slipped past it — so a field could be restored without
// riding the payload while this test still passed. The mutation tests at the
// bottom are what prove the extractor sees each form.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { buildCloudSyncPayload, cloudPayloadsEqual, normalizeCloudSyncPayload } from '../cloud-sync-payload';

const SRC = join(__dirname, '..', '..');
const APP_STATE = join(SRC, 'state', 'app-state.ts');

/** Fields mergeCloudState reads inbound but the payload deliberately omits. */
const DELIBERATE_INBOUND_ONLY: Record<string, string> = {
  // Removed from the outbound payload 2026-04; still accepted inbound so an
  // older cloud row does not fail to merge. Deprecated, no UI consumer.
  activeChallenge: 'deprecated, inbound back-compat only',
  completedChallenges: 'deprecated, inbound back-compat only',
  // Not sent, but self-healing: mergeCloudState backfills both from the cloud
  // activation signals (activatedDate / isActivated / habitLog) when absent,
  // so a reinstall reconstructs them rather than losing them.
  firstActionIntent: 'reconstructed by the mergeCloudState backfill heuristic',
  firstHabitCompletedAt: 'reconstructed by the mergeCloudState backfill heuristic',
};

function outboundKeys(): Set<string> {
  return new Set(Object.keys(buildCloudSyncPayload({})));
}

/**
 * Every inbound field mergeCloudState reads off its `cloudState` parameter,
 * collected from the TypeScript AST of the implementation only.
 *
 * Covers the four ways a field can legitimately be read:
 *   cloudState.foo              property access
 *   cloudState['foo']           element access with a string literal
 *   const { foo } = cloudState  object destructuring
 *   const cs = cloudState       an alias, then any of the above on `cs`
 */
export function extractInboundFields(source: string, fileName = 'app-state.ts'): Set<string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  // Find the IMPLEMENTATION, not the interface declaration: an object-literal
  // property named mergeCloudState whose initializer is a function with a body.
  let impl: ts.Node | undefined;
  const findImpl = (node: ts.Node): void => {
    if (impl) return;
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'mergeCloudState' &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      impl = node.initializer.body;
      return;
    }
    ts.forEachChild(node, findImpl);
  };
  findImpl(sf);
  if (!impl) throw new Error('mergeCloudState implementation not found');

  const roots = new Set(['cloudState']);
  const fields = new Set<string>();

  // Two passes: aliases can be declared after their first use in principle, and
  // a second walk is cheaper than reasoning about order.
  for (let pass = 0; pass < 2; pass++) {
    const walk = (node: ts.Node): void => {
      // const cs = cloudState  /  const { a, b } = cloudState
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer)) {
        if (roots.has(node.initializer.text)) {
          if (ts.isIdentifier(node.name)) roots.add(node.name.text);
          else if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              const key = el.propertyName ?? el.name;
              if (ts.isIdentifier(key)) fields.add(key.text);
              else if (ts.isStringLiteral(key)) fields.add(key.text);
            }
          }
        }
      }
      // cloudState.foo
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        roots.has(node.expression.text)
      ) {
        fields.add(node.name.text);
      }
      // cloudState['foo']
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        roots.has(node.expression.text) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        fields.add(node.argumentExpression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(impl);
  }

  return fields;
}

describe('buildCloudSyncPayload', () => {
  it('excludes per-device calendar links and voice preferences on both legacy and new wire paths', () => {
    const local = { recurringRules: [{ id: 'r', appleEventId: 'phone', title: 'Run' }], coachThread: { messages: [], speakReplies: true } };
    const remote = { recurringRules: [{ id: 'r', appleEventId: 'tablet', title: 'Run' }], coachThread: { messages: [], speakReplies: false } };
    expect(cloudPayloadsEqual(local, remote)).toBe(true);
    const payload = buildCloudSyncPayload(local);
    expect(payload.recurringRules[0]).not.toHaveProperty('appleEventId');
    expect(payload.coachThread).not.toHaveProperty('speakReplies');
    expect(local.recurringRules[0].appleEventId).toBe('phone');
    expect(local.coachThread.speakReplies).toBe(true);
  });

  it('clones an explicit payload and treats object insertion order as equivalent', () => {
    const source = { inbox: [{ id: 'a', title: 'sent' }] };
    const snapshot = normalizeCloudSyncPayload(source);
    source.inbox[0].title = 'later';
    expect(snapshot.inbox[0].title).toBe('sent');
    expect(cloudPayloadsEqual(snapshot, { inbox: [{ title: 'sent', id: 'a' }] })).toBe(true);
  });

  it('sends the four fields whose absence silently lost data on reinstall', () => {
    const keys = outboundKeys();
    for (const field of [
      'mandateFocus',
      'nextWeekRuleOverrides',
      'pendingMondayIntention',
      'morningIntentionCompletedDate',
    ]) {
      expect(keys.has(field), `${field} must ride the outbound payload`).toBe(true);
    }
  });

  it('passes each field through from the source state', () => {
    const state = {
      mandateFocus: { '2026-08-29': 'mandate-1' },
      nextWeekRuleOverrides: { '2026-08-30': [] },
      pendingMondayIntention: { text: 'ship it', targetDateKey: '2026-08-31' },
      morningIntentionCompletedDate: '2026-08-29',
    };
    const payload = buildCloudSyncPayload(state) as Record<string, unknown>;
    expect(payload.mandateFocus).toBe(state.mandateFocus);
    expect(payload.nextWeekRuleOverrides).toBe(state.nextWeekRuleOverrides);
    expect(payload.pendingMondayIntention).toBe(state.pendingMondayIntention);
    expect(payload.morningIntentionCompletedDate).toBe('2026-08-29');
  });

  it('has no field restored from the cloud that is never sent to it', () => {
    const inbound = extractInboundFields(readFileSync(APP_STATE, 'utf8'));
    // Silence must not read as success: if the AST anchors ever drift, an empty
    // set would make this pass while checking nothing.
    expect(inbound.size, 'extracted too few inbound fields — anchors have drifted').toBeGreaterThan(30);

    const outbound = outboundKeys();
    const orphans = [...inbound]
      .filter((k) => !outbound.has(k))
      .filter((k) => !(k in DELIBERATE_INBOUND_ONLY))
      .sort();

    expect(
      orphans,
      `These fields are restored by mergeCloudState but never sent by ` +
        `buildCloudSyncPayload, so they are silently lost on reinstall. ` +
        `Either add them to the payload, or add them to ` +
        `DELIBERATE_INBOUND_ONLY with the reason they are safe to omit.`,
    ).toEqual([]);
  });
});

describe('extractInboundFields sees every access form', () => {
  // Each fixture is a minimal store object with a mergeCloudState implementation
  // reading one field a different way. A regex over `cloudState.` passed three
  // of these four while missing the field entirely — that is the hole these
  // mutation tests exist to keep closed.
  const fixture = (body: string) => `
    const useAppState = create((set, get) => ({
      mergeCloudState: (cloudState: any, opts?: { force?: boolean }) => {
        ${body}
      },
    }));
  `;

  it('property access', () => {
    expect(extractInboundFields(fixture('set({ a: cloudState.alpha });'))).toContain('alpha');
  });

  it('element access with a string literal', () => {
    expect(extractInboundFields(fixture("set({ a: cloudState['bravo'] });"))).toContain('bravo');
  });

  it('object destructuring', () => {
    expect(extractInboundFields(fixture('const { charlie } = cloudState; set({ a: charlie });'))).toContain('charlie');
  });

  it('destructuring with a renamed binding keeps the SOURCE key', () => {
    const found = extractInboundFields(fixture('const { delta: renamed } = cloudState; set({ a: renamed });'));
    expect(found).toContain('delta');
    expect(found).not.toContain('renamed');
  });

  it('an alias binding, then any form on the alias', () => {
    const found = extractInboundFields(
      fixture("const cs = cloudState; set({ a: cs.echo, b: cs['foxtrot'] });"),
    );
    expect(found).toContain('echo');
    expect(found).toContain('foxtrot');
  });

  it('ignores same-named properties read off an unrelated object', () => {
    const found = extractInboundFields(fixture('const other = { golf: 1 }; set({ a: other.golf });'));
    expect(found).not.toContain('golf');
  });

  it('throws rather than returning empty when the implementation is absent', () => {
    expect(() => extractInboundFields('export const nothing = 1;')).toThrow(/not found/);
  });
});
