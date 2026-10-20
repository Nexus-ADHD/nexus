import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { requestCloudPull } from './cloud-sync';
import type { SyncSession } from './sync-session';

type Subscription = {
  session: SyncSession;
  channel: RealtimeChannel;
  status: string;
  detach: () => void;
};

let active: Subscription | null = null;
let subscriptionAttempt = 0;

function isCurrent(subscription: Subscription): boolean {
  return active === subscription && subscription.session.isCurrent();
}

function pull(subscription: Subscription): void {
  if (!isCurrent(subscription)) return;
  // The coordinator serializes this behind any in-flight write. A timestamp
  // is not proof of write ownership: another device can produce the same one.
  void requestCloudPull(subscription.session).catch((error) => {
    if (isCurrent(subscription)) console.warn('[Sync] Realtime pull failed:', error);
  });
}

/** Start or repair this session's channel without restarting a healthy one. */
export function startUserStateRealtime(session: SyncSession): void {
  if (!session.isCurrent()) return;
  if (active?.session === session &&
      (active.status === 'CONNECTING' || active.status === 'SUBSCRIBED')) return;

  // Teardown detaches the old owner synchronously, before removeChannel awaits.
  void stopUserStateRealtime();
  // realtime-js caches channels by topic until asynchronous removal finishes.
  // A repair must not retrieve the same channel that is currently leaving.
  const channel = supabase.channel(`user-state-${session.userId}-${session.generation}-${++subscriptionAttempt}`);
  const subscription: Subscription = { session, channel, status: 'CONNECTING', detach: () => {} };
  active = subscription;
  subscription.detach = session.onStop(() => { void stopUserStateRealtime(session); });

  const changed = (payload: { new: Record<string, unknown> }) => {
    if (payload.new.user_id !== session.userId) return;
    pull(subscription);
  };
  try {
    channel
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'user_state', filter: `user_id=eq.${session.userId}`,
      }, changed)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'user_state', filter: `user_id=eq.${session.userId}`,
      }, changed)
      .subscribe((status, error) => {
        if (!isCurrent(subscription)) return;
        subscription.status = status;
        // A fresh join/rejoin can have missed changes before it became live.
        if (status === 'SUBSCRIBED') pull(subscription);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Sync] Realtime subscription:', status, error?.message ?? '');
        }
      });
  } catch (error) {
    subscription.status = 'CHANNEL_ERROR';
    console.warn('[Sync] Realtime setup failed:', error);
  }
}

/** An old session's cleanup must never remove the replacement user's channel. */
export async function stopUserStateRealtime(session?: SyncSession): Promise<void> {
  const subscription = active;
  if (!subscription || (session && subscription.session !== session)) return;
  active = null;
  subscription.detach();
  try {
    await supabase.removeChannel(subscription.channel);
  } catch (error) {
    console.warn('[Sync] Realtime teardown failed:', error);
  }
}
