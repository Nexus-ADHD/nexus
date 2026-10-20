import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem: Record<string, string> = {};
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItem: vi.fn(async (k: string, v: string) => {
      mem[k] = v;
    }),
  },
}));

import {
  __resetAppleLinksForTest,
  clearAppleLink,
  getAppleLink,
  hydrateAppleLinks,
  setAppleLink,
} from '../apple-link-store';

const KEY = 'nexus_apple_event_links';

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  __resetAppleLinksForTest();
});

describe('apple-link-store', () => {
  it('round-trips a link', async () => {
    await hydrateAppleLinks();
    await setAppleLink('rule-1', 'event-1');
    expect(getAppleLink('rule-1')).toBe('event-1');
    expect(JSON.parse(mem[KEY])).toEqual({ 'rule-1': 'event-1' });
  });

  it('releases a link without touching the others', async () => {
    __resetAppleLinksForTest({ a: 'ea', b: 'eb' });
    await clearAppleLink('a');
    expect(getAppleLink('a')).toBeNull();
    expect(getAppleLink('b')).toBe('eb');
  });

  // The reason this store exists: nothing here is reachable from the sync
  // payload, so a released link can never be resurrected by a cloud merge —
  // which would point it at a just-deleted event and get the routine deleted.
  it('a released link stays released', async () => {
    __resetAppleLinksForTest({ a: 'ea' });
    await clearAppleLink('a');
    await hydrateAppleLinks();
    expect(getAppleLink('a')).toBeNull();
  });

  // Before hydration the synchronous read must look like "no link", which every
  // consumer treats as "do nothing" — never as "the event is gone".
  it('reads null before hydration rather than throwing', () => {
    expect(getAppleLink('anything')).toBeNull();
  });

  it('survives a corrupt or hostile blob', async () => {
    for (const bad of ['not json', '[]', 'null', '{"a":123}', '{"":"x"}']) {
      __resetAppleLinksForTest();
      mem[KEY] = bad;
      const loaded = await hydrateAppleLinks();
      expect(Object.values(loaded).every((v) => typeof v === 'string')).toBe(true);
      expect(getAppleLink('a')).toBeNull();
    }
  });

  it('hydrates once under concurrent callers', async () => {
    mem[KEY] = JSON.stringify({ r: 'e' });
    const [x, y] = await Promise.all([hydrateAppleLinks(), hydrateAppleLinks()]);
    expect(x).toEqual({ r: 'e' });
    expect(y).toEqual({ r: 'e' });
  });

  // Greptile round 4: two links written before the first hydration both read
  // the same empty snapshot, and the second persist dropped the first.
  it('does not drop a link when writes race before hydration', async () => {
    __resetAppleLinksForTest();
    await Promise.all([setAppleLink('a', 'ea'), setAppleLink('b', 'eb')]);
    expect(getAppleLink('a')).toBe('ea');
    expect(getAppleLink('b')).toBe('eb');
    expect(JSON.parse(mem[KEY])).toEqual({ a: 'ea', b: 'eb' });
  });

  it('keeps every link when many race at once', async () => {
    __resetAppleLinksForTest();
    const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);
    await Promise.all(ids.map((id) => setAppleLink(id, `e-${id}`)));
    for (const id of ids) expect(getAppleLink(id)).toBe(`e-${id}`);
    expect(Object.keys(JSON.parse(mem[KEY])).sort()).toEqual([...ids].sort());
  });

  it('orders interleaved set and clear deterministically', async () => {
    __resetAppleLinksForTest();
    await Promise.all([
      setAppleLink('x', 'e1'),
      clearAppleLink('x'),
      setAppleLink('y', 'e2'),
    ]);
    // whatever the interleaving, y survives and the store is coherent
    expect(getAppleLink('y')).toBe('e2');
    expect(JSON.parse(mem[KEY])).toEqual(
      getAppleLink('x') ? { x: 'e1', y: 'e2' } : { y: 'e2' }
    );
  });

  it('a rejected write does not wedge the queue', async () => {
    __resetAppleLinksForTest();
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as any;
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await setAppleLink('a', 'ea');
    await setAppleLink('b', 'eb');
    expect(getAppleLink('b')).toBe('eb');
  });

  // Greptile round 8: accept wrote the link fire-and-forget, so an undo fired
  // immediately after could read no link (orphaning the new event) or a stale
  // one (deleting the WRONG event). Writes are now visible synchronously, so
  // no caller can observe a stale link whether it awaits or not.
  it('a write is readable before its promise settles', () => {
    __resetAppleLinksForTest({});
    const p = setAppleLink('rule-1', 'new-event'); // deliberately not awaited
    expect(getAppleLink('rule-1')).toBe('new-event');
    return p;
  });

  it('a release is readable before its promise settles', () => {
    __resetAppleLinksForTest({ 'rule-1': 'old-event' });
    const p = clearAppleLink('rule-1'); // deliberately not awaited
    expect(getAppleLink('rule-1')).toBeNull();
    return p;
  });

  // The precise accept-then-undo sequence, with nothing awaited.
  it('accept-then-immediate-undo sees the NEW event, never the old one', async () => {
    __resetAppleLinksForTest({ 'rule-1': 'old-event' });
    void setAppleLink('rule-1', 'new-event');
    // undo runs on the very next line, before any persist resolved
    expect(getAppleLink('rule-1')).toBe('new-event');
    void clearAppleLink('rule-1');
    expect(getAppleLink('rule-1')).toBeNull();
    await hydrateAppleLinks();
    expect(getAppleLink('rule-1')).toBeNull();
  });

  // Disk must never overwrite a write made this session.
  it('hydration does not clobber an unflushed in-session write', async () => {
    __resetAppleLinksForTest();
    mem[KEY] = JSON.stringify({ 'rule-1': 'disk-event' });
    void setAppleLink('rule-1', 'session-event');
    await hydrateAppleLinks();
    expect(getAppleLink('rule-1')).toBe('session-event');
  });
});
