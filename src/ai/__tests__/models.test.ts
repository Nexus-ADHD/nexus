/**
 * NEX-283 — the orb's Tier-2 capture parse routes to a DEDICATED model entry.
 * Before this, the call passed no model and silently rode the DAILY_PULSE
 * default; a future default change would have changed the app's most
 * user-facing AI call as a side effect.
 *
 * NEX-305 — that was not one call site, it was the whole table. Seven of the
 * ten keys were referenced NOWHERE in the app (MANDATE_GENERATION, DEEP_REVIEW,
 * WEEKLY_REVIEW, MONTHLY_REVIEW, MORNING_BRIEF, QUICK_PARSE, DEFAULT), and
 * DEFAULT_MODEL aliased DAILY_PULSE, so nearly every AI call in the app rode a
 * single model while the table read as if it were tiered. These tests pin the
 * three properties that let that happen:
 *
 *   1. every id is OpenAI-routable (the proxy is an OpenAI passthrough),
 *   2. DEFAULT is standalone, not an alias of a named tier,
 *   3. every tier is actually referenced by the app.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MODELS,
  MODEL_TIER_NAMES,
  assertOpenAIRoutable,
  isOpenAIRoutable,
  isAnthropicRoutable,
  isKimiRoutable,
  isProxyRoutable,
  assertProxyRoutable,
} from '../models';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('MODELS.COMMAND_ROUTER (NEX-283)', () => {
  it('exists and is a proxy-routable id', () => {
    expect(typeof MODELS.COMMAND_ROUTER).toBe('string');
    expect(isProxyRoutable(MODELS.COMMAND_ROUTER)).toBe(true);
  });

  it('pins the exact id — a routing change here must be a deliberate, reviewed edit', () => {
    expect(MODELS.COMMAND_ROUTER).toBe('kimi-k2.6');
  });

  it('does not ride the deprecated gpt-4o family', () => {
    expect(MODELS.COMMAND_ROUTER.startsWith('gpt-4o')).toBe(false);
  });
});

describe('the routing table is servable by the proxy (NEX-305 rule 2)', () => {
  it.each(Object.entries(MODELS))('%s is proxy-routable', (_name, id) => {
    expect(isProxyRoutable(id)).toBe(true);
  });

  it.each(Object.entries(MODELS))('%s is Kimi-routable (the table is deliberately all-Kimi)', (_name, id) => {
    // Every tier routes to Moonshot. A re-tier to OpenAI or Anthropic must be
    // a deliberate, reviewed edit here — not a silent drift this test misses.
    expect(isKimiRoutable(id)).toBe(true);
  });

  it('has fully left the deprecated gpt-4o family (NEX-284)', () => {
    for (const id of Object.values(MODELS)) {
      expect(id.startsWith('gpt-4o')).toBe(false);
    }
  });

  it('rejects a non-OpenAI id rather than letting it reach api.openai.com', () => {
    // The exact regression NEX-305 defuses: the old enableClaude flag would
    // have put ids like this into the proxy body.
    expect(isOpenAIRoutable('claude-opus-4-5')).toBe(false);
    expect(isOpenAIRoutable('gemini-2.0-pro')).toBe(false);
    expect(isOpenAIRoutable('')).toBe(false);
    // Fails CLOSED: an unrecognized id is not assumed to be OpenAI.
    expect(isOpenAIRoutable('something-new')).toBe(false);
  });

  it('accepts OpenAI families beyond the table, so a valid override is not rejected', () => {
    // The EXPO_PUBLIC_OPENAI_MODEL override (parser-service.ts) can name any
    // real OpenAI model. The guard must not be stricter than OpenAI itself
    // about which of ITS models are valid, or it regresses a path the old
    // no-guard code sent fine.
    expect(isOpenAIRoutable('o4-mini')).toBe(true);
    expect(isOpenAIRoutable('o1')).toBe(true);
    expect(isOpenAIRoutable('o3-mini')).toBe(true);
    expect(isOpenAIRoutable('chatgpt-4o-latest')).toBe(true);
    expect(isOpenAIRoutable('gpt-4o-mini')).toBe(true);
  });

  it('assertOpenAIRoutable throws with an actionable message and returns valid ids', () => {
    expect(assertOpenAIRoutable('gpt-5.4')).toBe('gpt-5.4');
    expect(() => assertOpenAIRoutable('claude-opus-4-5', 'chatCompletion')).toThrow(
      /not OpenAI-routable/,
    );
    // Names the fix, not just the symptom.
    expect(() => assertOpenAIRoutable('claude-opus-4-5')).toThrow(/ai-proxy/);
  });
});

describe('DEFAULT is standalone (NEX-305 rule 1)', () => {
  // The invariant is REFERENCE independence, not id distinctness. Two tiers
  // sharing a model id is fine and deliberate (WEEKLY_REVIEW and MONTHLY_REVIEW
  // are both mini). What broke the app was `DEFAULT_MODEL = MODELS.DAILY_PULSE`
  // — an alias, so re-tiering the daily-pulse surface silently re-routed every
  // uncategorized call with it. At runtime both are just strings, so the only
  // place that coupling is observable is the source.
  it('ai-client resolves its fallback from MODELS.DEFAULT, not another tier', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/utils/ai-client.ts'), 'utf8');
    const match = src.match(/const\s+DEFAULT_MODEL\s*=\s*MODELS\.([A-Z_]+)\s*;/);
    expect(
      match?.[1],
      'ai-client.ts must resolve DEFAULT_MODEL from MODELS.DEFAULT. Pointing it ' +
        'at a named tier makes re-tiering that one surface silently move every ' +
        'uncategorized call in the app (NEX-305).',
    ).toBe('DEFAULT');
  });

  it('MODELS.DEFAULT exists and is routable', () => {
    expect(typeof MODELS.DEFAULT).toBe('string');
    expect(isProxyRoutable(MODELS.DEFAULT)).toBe(true);
  });
});

describe('no dead tiers (NEX-305 rule 3)', () => {
  // Finds every tier NAME referenced in actual CODE. A tier nobody passes is
  // not routing — it is documentation of an intention, and it is how six
  // surfaces ended up sharing one model while the table looked tiered.
  //
  // Comments are stripped before matching: a leftover `// TODO: use
  // MODELS.DEEP_REVIEW` must NOT keep a tier green after its real call site is
  // removed. This is a tripwire, not a parser — the comment strip is a regex,
  // good enough to tell a live reference from prose.
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/[^\n]*/g, ''); // line comments (and any trailing prose)

  const referenced = (() => {
    // `git grep -l` narrows to files that even mention MODELS. before we read
    // and comment-strip them, so the test stays fast.
    let fileList = '';
    try {
      fileList = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-E',
          'MODELS\\.[A-Z_]+',
          '--',
          'src',
          'app',
          'supabase',
          ':(exclude)src/ai/models.js',
          ':(exclude)src/ai/__tests__/models.test.ts',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch {
      // `git grep` exits 1 when there are no matches; treat as empty.
      fileList = '';
    }
    const set = new Set<string>();
    for (const file of fileList.split('\n').map((f) => f.trim()).filter(Boolean)) {
      let code: string;
      try {
        code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      } catch {
        continue;
      }
      for (const m of code.matchAll(/MODELS\.([A-Z_]+)/g)) set.add(m[1]);
    }
    return set;
  })();

  it('finds at least one reference (guards against the grep itself breaking)', () => {
    expect(referenced.size).toBeGreaterThan(0);
  });

  it.each(MODEL_TIER_NAMES)('MODELS.%s is passed by at least one call site', (name) => {
    expect(
      referenced.has(name),
      `MODELS.${name} is declared but never passed. Either wire it at the call ` +
        'site it was written for, or delete it — an unused tier reads as routing ' +
        'that is not happening (NEX-305).',
    ).toBe(true);
  });
});

describe('NEX-314 — provider-aware routing guard (completes the NEX-311 wire)', () => {
  // NEX-311 gave the proxy a real Anthropic route. The client guard was written
  // when the proxy was OpenAI-only, so left unchanged it would reject every
  // claude-* id before the request left the device — the route live in the
  // proxy, dead from the client. These pin the widened guard.

  it('isAnthropicRoutable matches claude-* and nothing else', () => {
    expect(isAnthropicRoutable('claude-opus-4-5')).toBe(true);
    expect(isAnthropicRoutable('CLAUDE-SONNET-4-5')).toBe(true);
    for (const m of ['gpt-5.4', 'o4-mini', 'gemini-2.0-pro', 'llama-3', '', null, undefined, 42] as unknown[]) {
      expect(isAnthropicRoutable(m as string)).toBe(false);
    }
  });

  it('isKimiRoutable matches kimi-* and nothing else', () => {
    expect(isKimiRoutable('kimi-k2.6')).toBe(true);
    expect(isKimiRoutable('KIMI-K3')).toBe(true);
    // `moonshot-v1-*` is deliberately NOT routed — the table only names kimi-*.
    for (const m of ['moonshot-v1-8k', 'gpt-5.4', 'claude-opus-4-5', 'gemini-2.0-pro', '', null, undefined, 42] as unknown[]) {
      expect(isKimiRoutable(m as string)).toBe(false);
    }
  });

  it('isProxyRoutable accepts ALL providers the proxy routes', () => {
    expect(isProxyRoutable('gpt-5.4')).toBe(true);
    expect(isProxyRoutable('o4-mini')).toBe(true);
    expect(isProxyRoutable('claude-opus-4-5')).toBe(true);
    expect(isProxyRoutable('kimi-k2.6')).toBe(true);
    expect(isProxyRoutable('kimi-k2.5')).toBe(true);
  });

  it('isProxyRoutable STILL fails closed on providers the proxy does not route', () => {
    for (const m of ['gemini-2.0-pro', 'llama-3-70b', 'mistral-large', 'something-new', '']) {
      expect(isProxyRoutable(m)).toBe(false);
    }
  });

  it('assertProxyRoutable passes claude ids that assertOpenAIRoutable would have thrown on', () => {
    expect(assertProxyRoutable('claude-opus-4-5')).toBe('claude-opus-4-5');
    expect(() => assertOpenAIRoutable('claude-opus-4-5')).toThrow(); // the exact block this fixes
  });

  it('assertProxyRoutable throws an actionable message on an unroutable provider', () => {
    expect(() => assertProxyRoutable('gemini-2.0-pro', 'chatCompletion')).toThrow(/no proxy route/);
    expect(() => assertProxyRoutable('gemini-2.0-pro')).toThrow(/ai-proxy/);
  });

  it('the client is never MORE permissive than the proxy: provider-routable implies proxy-routable', () => {
    // Mirror invariant. The proxy routes claude-* to Anthropic and kimi-* to
    // Moonshot; if the client ever accepted an id the proxy could not place,
    // the request would 400 upstream with no local signal — the very failure
    // the guard exists to prevent. Every OpenAI-, Anthropic-, or
    // Kimi-routable id must be proxy-routable.
    for (const m of ['gpt-5.4', 'o4-mini', 'chatgpt-4o', 'claude-opus-4-5', 'claude-haiku-4-5', 'kimi-k2.6', 'kimi-k3']) {
      const routable = isOpenAIRoutable(m) || isAnthropicRoutable(m) || isKimiRoutable(m);
      expect(isProxyRoutable(m)).toBe(routable);
    }
  });

  it('every current MODELS id is proxy-routable (the table stays deployable)', () => {
    for (const id of Object.values(MODELS)) {
      expect(isProxyRoutable(id)).toBe(true);
    }
  });
});
