// src/services/sign-out.ts
// hardSignOut — a sign-out that actually signs out (NEX-328).
//
// Why the SDK's own `supabase.auth.signOut()` can't be the mechanism
// (@supabase/auth-js 2.102.1, verified in GoTrueClient.js):
//
//  1. It RESOLVES `{ error }` instead of throwing for auth/API failures, so a
//     caller's try/catch almost never fires.
//  2. `_signOut` → `_useSession` → `__loadSession` REFRESHES an expired token
//     first; a retryable refresh failure (offline, GoTrue 5xx/hang) early-
//     returns BEFORE `_removeSession()` — the session persists and no
//     SIGNED_OUT fires. `scope: 'local'` is not exempt. RN fetch has no
//     default timeout, so the button can also just hang.
//
// Why not "race the SDK call and walk away": four review rounds on #386
// proved every variant of that is a finding generator — the abandoned SDK
// call completes LATE and deletes whatever session is current (a re-signed-in
// user's), and every guard built around that (stale windows, snapshot-
// restore) opened the next edge. The fix is to never leave an SDK call
// dangling: this module never calls `auth.signOut()` at all.
//
// Two facts make that safe here:
//  - auth-js 2.102.1 keeps NO in-memory session — `__loadSession` re-reads
//    AsyncStorage every time and `_removeSession` is storage-only + notify —
//    so removing the stored blob IS removing the session.
//  - This app has exactly ONE onAuthStateChange subscriber (app/_layout.tsx),
//    and the signed-out transition is app-owned via notifyForceSignOut(), so
//    skipping the SDK's SIGNED_OUT emission loses nothing.
//
// Accepted residual (also true of the SDK's own signOut): an auto-refresh
// already in flight when surgery runs could re-persist its refreshed session.
// Sub-second window, native to the SDK, not defended here.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { publicConfigValue } from '../utils/public-config';
import { clearCloudSyncMetadata } from './cloud-sync-guard';
import { stopSyncSession } from './sync-session';
import { clearAiSessionCache } from '../utils/ai-session-cache';

// Resolved exactly like src/services/supabase.ts resolves them (env first,
// app.json extra fallback) — static member expressions are required for Metro
// inlining (see public-config.ts).
const SUPABASE_URL = publicConfigValue(
  'EXPO_PUBLIC_SUPABASE_URL',
  process.env.EXPO_PUBLIC_SUPABASE_URL,
);
const SUPABASE_ANON_KEY = publicConfigValue(
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

// Mirrors the SDK's default storageKey derivation (supabase-js dist/index.cjs:
// `sb-${baseUrl.hostname.split('.')[0]}-auth-token`) from the SAME URL the
// client is built with, so the two match by construction. In degraded mode
// (unconfigured) the client targets `https://unconfigured.invalid`, whose
// first hostname label is "unconfigured" — matching the fallback below.
export const SUPABASE_AUTH_STORAGE_KEY = (() => {
  try {
    return `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
  } catch {
    return 'sb-unconfigured-auth-token';
  }
})();

// Bounds the server revoke. Long enough for a healthy /logout round trip,
// short enough that a hung GoTrue can't strand the button.
const SIGN_OUT_TIMEOUT_MS = 4000;

interface SignOutStorage {
  getItem(key: string): Promise<string | null>;
  multiRemove(keys: string[]): Promise<void>;
  // Optional so existing test doubles keep working; the baseline sweep below
  // simply skips when a storage implementation does not provide it.
  getAllKeys?(): Promise<readonly string[]>;
}

/**
 * Best-effort server-side revocation via a plain fetch — deliberately NOT
 * the SDK's signOut, so a late-settling call touches no client state. A
 * 401/403 means the token was already dead server-side (nothing to revoke);
 * offline/timeout means the next cold start simply finds no local session.
 * Never throws.
 */
async function revokeOnServer(accessToken: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // ignored — see docstring
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Sign out for real:
 *  1. Read the persisted blob (the only place a session exists) and lift the
 *     access token for the server revoke.
 *  2. Remove the same three keys the SDK's `_removeSession` removes — FIRST,
 *     so a sign-in completing during the revoke writes its blob AFTER the
 *     surgery and is never deleted by it (Greptile round 5).
 *  3. Fire the server revoke DETACHED (global scope — other devices too). It
 *     is best-effort hygiene; the user must not watch a spinner for it, and a
 *     late-settling fetch touches no client state.
 * The caller pairs this with notifyForceSignOut() to drive the UI transition.
 */
export async function hardSignOut(
  storage: SignOutStorage = AsyncStorage as unknown as SignOutStorage,
): Promise<{ persistedSessionCleared: boolean }> {
  // Stop callbacks and in-flight completions before the first storage await.
  stopSyncSession();
  // First, before anything can fail: the last-known access token ai-client
  // keeps for a wedged session lookup belongs to the person signing out.
  clearAiSessionCache();
  let raw: string | null = null;
  try {
    raw = await storage.getItem(SUPABASE_AUTH_STORAGE_KEY);
  } catch {
    return { persistedSessionCleared: false };
  }
  let accessToken: string | null = null;
  if (raw) {
    try {
      const token = JSON.parse(raw)?.access_token;
      if (typeof token === 'string' && token.length > 0) accessToken = token;
    } catch {
      // malformed blob — no token to revoke, surgery below still signs out
    }
  }
  try {
    await storage.multiRemove([
      SUPABASE_AUTH_STORAGE_KEY,
      `${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`,
      `${SUPABASE_AUTH_STORAGE_KEY}-user`,
    ]);
  } catch {
    return { persistedSessionCleared: false };
  }
  // Serialize cleanup behind earlier metadata writes. A late old-session
  // acknowledgement can never recreate a baseline after this sweep.
  try {
    await clearCloudSyncMetadata(undefined, storage);
  } catch {
    // Auth removal succeeded; a metadata-storage failure cannot undo sign-out.
  }

  if (accessToken && SUPABASE_URL && SUPABASE_ANON_KEY) {
    // Detached, never awaited: revokeOnServer swallows all failures itself.
    void revokeOnServer(accessToken);
  }
  return { persistedSessionCleared: true };
}

// ─── App-owned signed-out transition ─────────────────────────────────────────
// The routing gate reads authState in app/_layout.tsx, which registers the
// one transition it owns here; the Settings sign-out handler invokes it after
// hardSignOut so the UI leaves the signed-in tree regardless of what the SDK
// emitted (or didn't). Idempotent by construction (re-sets the same state).

let forceSignOutHandler: (() => void) | null = null;

export function setForceSignOutHandler(fn: (() => void) | null): void {
  forceSignOutHandler = fn;
}

export function notifyForceSignOut(): void {
  try {
    forceSignOutHandler?.();
  } catch {
    // A throwing handler must never break the sign-out flow itself.
  }
}
