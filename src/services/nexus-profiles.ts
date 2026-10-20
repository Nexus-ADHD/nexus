// src/services/nexus-profiles.ts
// Client wiring to the Nexus email/profile edge functions.
// Fire-and-forget: never throws to caller. Honors SIM_BYPASS.

import * as Device from 'expo-device';
import { supabase } from './supabase';

// Matches SIM_BYPASS in src/services/revenuecat.ts and app/_layout.tsx.
const SIM_BYPASS = __DEV__ && !Device.isDevice;

const APP_STORE_URL = 'https://apps.apple.com/app/id6761865566';

export interface NexusUser {
  id: string;
  email: string;
  name: string;
}

export type Plan = 'monthly' | 'annual';

export async function onActivation(user: NexusUser): Promise<void> {
  if (SIM_BYPASS) {
    console.log('[nexus-profiles] SIM bypass — skipping onActivation');
    return;
  }
  if (!user?.id || !user?.email) {
    console.log('[nexus-profiles] onActivation skipped — missing id/email');
    return;
  }

  try {
    const { error: upsertErr } = await supabase.functions.invoke('upsert-profile', {
      body: {
        trigger: 'activation',
        userId: user.id,
        email: user.email,
        name: user.name ?? '',
        plan: 'trial',
        subscribed: false,
      },
    });
    if (upsertErr) console.log('[nexus-profiles] upsert-profile error:', upsertErr.message);

    const { error: welcomeErr } = await supabase.functions.invoke('welcome-email', {
      body: { userEmail: user.email, userName: user.name ?? '', appUrl: APP_STORE_URL },
    });
    if (welcomeErr) {
      console.log('[nexus-profiles] welcome-email error:', welcomeErr.message);
      return;
    }
    console.log('[nexus-profiles] onActivation ok for', user.email);
  } catch (e: any) {
    console.log('[nexus-profiles] onActivation exception:', e?.message ?? e);
  }
}

export async function onPurchase(user: NexusUser, plan: Plan): Promise<void> {
  if (SIM_BYPASS) {
    console.log('[nexus-profiles] SIM bypass — skipping onPurchase');
    return;
  }
  if (!user?.id || !user?.email) {
    console.log('[nexus-profiles] onPurchase skipped — missing id/email');
    return;
  }

  try {
    const { error: upsertErr } = await supabase.functions.invoke('upsert-profile', {
      body: {
        trigger: 'purchase',
        userId: user.id,
        email: user.email,
        name: user.name ?? '',
        plan,
        subscribed: true,
      },
    });
    if (upsertErr) console.log('[nexus-profiles] upsert-profile error:', upsertErr.message);

    const { error: confirmErr } = await supabase.functions.invoke('post-purchase-confirm', {
      body: { userEmail: user.email, userName: user.name ?? '', plan, appUrl: APP_STORE_URL },
    });
    if (confirmErr) {
      console.log('[nexus-profiles] post-purchase-confirm error:', confirmErr.message);
      return;
    }
    console.log('[nexus-profiles] onPurchase ok for', user.email, plan);
  } catch (e: any) {
    console.log('[nexus-profiles] onPurchase exception:', e?.message ?? e);
  }
}
