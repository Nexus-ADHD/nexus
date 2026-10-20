import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSession } from '../sync-session';

const fake = vi.hoisted(() => ({
  channels: [] as any[],
  topics: new Map<string, any>(),
  remove: vi.fn(async (_channel: any) => 'ok'),
  pull: vi.fn(async (_session: any) => ({ status: 'unchanged' })),
}));
vi.mock('../cloud-sync', () => ({ requestCloudPull: fake.pull }));
vi.mock('../supabase', () => ({
  supabase: {
    channel: (name: string) => {
      if (fake.topics.has(name)) return fake.topics.get(name);
      const channel: any = {
        name, listeners: [], status: () => {},
        on(_kind: string, filter: any, callback: any) {
          this.listeners.push({ filter, callback });
          return this;
        },
        subscribe(callback: any) { this.status = callback; return this; },
      };
      fake.channels.push(channel);
      fake.topics.set(name, channel);
      return channel;
    },
    removeChannel: fake.remove,
  },
}));
import { startUserStateRealtime, stopUserStateRealtime } from '../realtime-sync';

function session(userId = 'one', generation = 1) {
  let current = true;
  const stops = new Set<() => void>();
  return {
    userId, generation,
    isCurrent: () => current,
    onStop(fn: () => void) { stops.add(fn); return () => { stops.delete(fn); }; },
    stop() { current = false; for (const fn of [...stops]) fn(); },
  } as SyncSession & { stop(): void };
}

beforeEach(() => {
  fake.channels.length = 0;
  fake.topics.clear();
  vi.clearAllMocks();
  fake.remove.mockImplementation(async (channel) => {
    fake.topics.delete(channel.name);
    return 'ok';
  });
});
afterEach(async () => { await stopUserStateRealtime(); vi.restoreAllMocks(); });

describe('user-state realtime ownership and recovery', () => {
  it('listens to the first INSERT and later UPDATE, only for the current user', () => {
    const owner = session();
    startUserStateRealtime(owner);
    const channel = fake.channels[0];
    expect(channel.listeners.map((entry: any) => entry.filter)).toEqual([
      { event: 'INSERT', schema: 'public', table: 'user_state', filter: 'user_id=eq.one' },
      { event: 'UPDATE', schema: 'public', table: 'user_state', filter: 'user_id=eq.one' },
    ]);
    channel.listeners[0].callback({ new: { user_id: 'one' } });
    channel.listeners[1].callback({ new: { user_id: 'one' } });
    channel.listeners[1].callback({ new: { user_id: 'someone-else' } });
    expect(fake.pull).toHaveBeenCalledTimes(2);
    expect(fake.pull).toHaveBeenLastCalledWith(owner);
  });

  it('keeps a connecting or healthy channel and pulls on join/rejoin', () => {
    const owner = session();
    startUserStateRealtime(owner);
    startUserStateRealtime(owner);
    const channel = fake.channels[0];
    channel.status('SUBSCRIBED');
    startUserStateRealtime(owner);
    channel.status('SUBSCRIBED');
    expect(fake.channels).toHaveLength(1);
    expect(fake.pull).toHaveBeenCalledTimes(2);
  });

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])('replaces a %s channel on the next start', (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const owner = session();
    startUserStateRealtime(owner);
    const old = fake.channels[0];
    old.status(status);
    startUserStateRealtime(owner);
    expect(fake.channels).toHaveLength(2);
    expect(fake.remove).toHaveBeenCalledWith(old);
    old.status('SUBSCRIBED');
    old.listeners[1].callback({ new: { user_id: 'one' } });
    expect(fake.pull).not.toHaveBeenCalled();
  });

  it('cancels all old-user callbacks immediately when the owner stops', async () => {
    const owner = session();
    startUserStateRealtime(owner);
    const old = fake.channels[0];
    owner.stop();
    old.status('SUBSCRIBED');
    old.listeners[0].callback({ new: { user_id: 'one' } });
    startUserStateRealtime(owner);
    expect(fake.channels).toHaveLength(1);
    expect(fake.pull).not.toHaveBeenCalled();
    expect(fake.remove).toHaveBeenCalledWith(old);
  });

  it('repairs while old topic removal is pending without reusing the leaving channel', async () => {
    let finishRemoval!: () => void;
    fake.remove.mockImplementationOnce((channel) => new Promise<string>((resolve) => {
      finishRemoval = () => { fake.topics.delete(channel.name); resolve('ok'); };
    }));
    const owner = session();
    startUserStateRealtime(owner);
    const old = fake.channels[0];
    old.status('CLOSED');
    startUserStateRealtime(owner);
    const replacement = fake.channels[1];
    expect(replacement).toBeDefined();
    expect(replacement.name).not.toBe(old.name);
    finishRemoval();
    await Promise.resolve();
    replacement.status('SUBSCRIBED');
    expect(fake.topics.get(replacement.name)).toBe(replacement);
    expect(fake.pull).toHaveBeenCalledWith(owner);
  });

  it('does not let delayed old-session cleanup remove a new account channel', async () => {
    const first = session('one');
    const second = session('two', 2);
    startUserStateRealtime(first);
    startUserStateRealtime(second);
    const replacement = fake.channels[1];
    await stopUserStateRealtime(first);
    first.stop();
    replacement.status('SUBSCRIBED');
    expect(fake.remove).not.toHaveBeenCalledWith(replacement);
    expect(fake.pull).toHaveBeenCalledWith(second);
  });

  it('does not mistake equal timestamps for proof that an event is its own write', () => {
    const owner = session();
    startUserStateRealtime(owner);
    const change = fake.channels[0].listeners[1].callback;
    const row = { new: { user_id: 'one', updated_at: '2026-09-12T12:00:00.000Z' } };
    change(row);
    change(row);
    expect(fake.pull).toHaveBeenCalledTimes(2);
  });
});
