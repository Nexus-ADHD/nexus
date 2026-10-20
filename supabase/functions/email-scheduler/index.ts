/**
 * Nexus Email Scheduler — Supabase Edge Function
 * ────────────────────────────────────────────────────────────────────
 * pg_cron runs this once per day at ~9am ET.
 *
 * Logic:
 *   For each non-subscribed user in nexus_profiles with a trial_start:
 *     - trial_start + 3 days = today?  → send trial_day_3
 *     - trial_start + 7 days = today?  → send trial_day_7
 *     - trial_start + 12 days = today? → send trial_day_12
 *     - trial_end has passed?          → send trial_day_13 (once)
 *
 * Duplicate send protection: nexus_email_log table is checked first.
 * Idempotent: safe to run multiple times, safe to call directly for testing.
 *
 * Env:
 *   SUPABASE_URL       — used for service-role RPC calls and DB writes
 *   SUPABASE_SERVICE_ROLE_KEY — required for cross-user writes (email_log)
 *   RESEND_API_KEY     — for direct Resend calls if edge function calls are
 *                        unavailable (pg_net HTTP calls from SQL are flaky)
 *
 * Deploy: supabase functions deploy email-scheduler
 * Crontab (Supabase SQL editor):
 *   SELECT cron.schedule(
 *     'nexus-daily-email-scheduler',
 *     '0 13 * * *',   -- every day at 1 PM UTC ≈ 9 AM ET
 *     $$
 *     SELECT net.http_post(
 *       url := '${SUPABASE_URL}/functions/v1/email-scheduler',
 *       headers := json_build_object(
 *         'Authorization', 'Bearer ${SERVICE_ROLE_KEY}',
 *         'Content-Type', 'application/json'
 *       ),
 *       body := json_build_object('run_type', 'scheduled')
 *     );
 *     $$
 *   );
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { isServiceRoleCaller } from '../_shared/caller-auth.ts';

// ── Env ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL       = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';
const APP_URL          = 'https://apps.apple.com/app/id6761865566';

// ── Types ───────────────────────────────────────────────────────────────────
interface NexusProfile {
  user_id:    string;
  email:      string;
  name:       string;
  trial_start: string;   // ISO timestamp
  trial_end:   string;   // ISO timestamp
  plan_type:  string;
  subscribed: boolean;
}

interface ScheduleResult {
  email_key: string;
  user_id:   string;
  email:     string;
  sent:      boolean;
  error?:    string;
}

// ── HTML builders (inlined so this file is self-contained) ──────────────────

function htmlDay3(p: { firstName: string; appUrl: string; trialDayLabel: string }): string {
  return `<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Day 3 — How's it going?</title></head><body style=\"margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\"><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#000;padding:40px 0;\"><tr><td align=\"center\"><table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;width:100%;\"><tr><td style=\"padding:0 0 40px;text-align:center;\"><p style=\"margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;\">N E X U S</p></td></tr><tr><td style=\"padding:0 0 32px;\"><p style=\"margin:0;color:#B0B0B0;font-size:13px;letter-spacing:0.5px;\">${p.trialDayLabel} of your trial</p></td></tr><tr><td style=\"padding:0 0 28px;\"><p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">Hey ${p.firstName},</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">Three days in. How's it going?</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">Nexus is built around one idea: your daily habits compound. Not next week — today. The score you're building right now is the clearest picture of who you are versus who you said you'd be.</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">If you've logged something, you already understand it. If you haven't — today is still a good day to start.</p><p style=\"margin:0;color:#B0B0B0;font-size:15px;line-height:26px;\">Either way, I'm here. Questions, feedback, things that feel off — I read every reply.</p></td></tr><tr><td style=\"padding:12px 0 40px;\" align=\"center\"><a href=\"${p.appUrl}\" style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">OPEN NEXUS</a></td></tr><tr><td style=\"text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;\"><p style=\"margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;\">Nexus · Built for the intentional</p></td></tr></table></td></tr></table></body></html>`;
}

function htmlDay7(p: { firstName: string; appUrl: string; streakDays: number }): string {
  const hasStreak = p.streakDays >= 1;
  return `<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>One week in — here's where you stand</title></head><body style=\"margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\"><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#000;padding:40px 0;\"><tr><td align=\"center\"><table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;width:100%;\"><tr><td style=\"padding:0 0 40px;text-align:center;\"><p style=\"margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;\">N E X U S</p></td></tr><tr><td style=\"padding:0 0 32px;\"><p style=\"margin:0;color:#B0B0B0;font-size:13px;letter-spacing:0.5px;\">One week in</p></td></tr><tr><td style=\"padding:0 0 28px;\"><p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">Hey ${p.firstName},</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">One week ago you decided to track your days differently. Most people don't make it that far.</p>${hasStreak ? `<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">You've built a ${p.streakDays}-day streak. That's not luck — that's repetition. The same decision, made ${p.streakDays} times. That's who you are right now.</p>` : `<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">You haven't started a streak yet — that's fine. The second week is where it gets real. Pick one habit and commit to it today.</p>`}<p style=\"margin:0;color:#B0B0B0;font-size:15px;line-height:26px;\">Nexus Pro removes the friction: unlimited habits, Apple Reminders sync, weekly summaries, and full data export. Your trial ends in 6 days — I'd love for you to keep going.</p></td></tr><tr><td style=\"padding:12px 0 40px;\" align=\"center\"><a href=\"${p.appUrl}\" style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">OPEN NEXUS</a></td></tr><tr><td style=\"text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;\"><p style=\"margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;\">Nexus · Built for the intentional</p></td></tr></table></td></tr></table></body></html>`;
}

function htmlDay12(p: { firstName: string; appUrl: string; streakDays: number; topHabit: string }): string {
  const hasStreak = p.streakDays >= 1;
  return `<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Your trial ends tomorrow</title></head><body style=\"margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\"><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#000;padding:40px 0;\"><tr><td align=\"center\"><table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;width:100%;\"><tr><td style=\"padding:0 0 40px;text-align:center;\"><p style=\"margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;\">N E X U S</p></td></tr><tr><td style=\"padding:0 0 32px;\"><p style=\"margin:0;color:#D4AF37;font-size:12px;font-weight:700;letter-spacing:1px;\">Your trial ends in 1 day</p></td></tr><tr><td style=\"padding:0 0 28px;\"><p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">Hey ${p.firstName},</p>${hasStreak ? `<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">You've held a ${p.streakDays}-day streak on <strong style=\"color:#F0F0F0;\">${p.topHabit}</strong>. That didn't happen by accident — it happened because you showed up.</p>` : `<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">Your Nexus trial ends tomorrow. You've built something here, even if it wasn't a streak yet.</p>`}<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">Nexus Pro is $9.99/month. No ads. No noise. Just a system that keeps measuring who you are against who you said you'd be.</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">If you've been on the fence — tomorrow's the day. I'm not going to push harder than that.</p><p style=\"margin:0;color:#B0B0B0;font-size:15px;line-height:26px;\">Either way, thanks for the time. I built this for people like you.</p></td></tr><tr><td style=\"padding:12px 0 40px;\" align=\"center\"><a href=\"${p.appUrl}\" style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">GO PRO — $9.99/mo</a></td></tr><tr><td style=\"text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;\"><p style=\"margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;\">Nexus · Built for the intentional</p></td></tr></table></td></tr></table></body></html>`;
}

function htmlDay13(p: { firstName: string; appUrl: string; streakDays: number; topHabit: string }): string {
  const hasStreak = p.streakDays >= 1;
  return `<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Your trial has ended — one offer</title></head><body style=\"margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\"><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#000;padding:40px 0;\"><tr><td align=\"center\"><table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;width:100%;\"><tr><td style=\"padding:0 0 40px;text-align:center;\"><p style=\"margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;\">N E X U S</p></td></tr><tr><td style=\"padding:0 0 28px;\"><p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">Hey ${p.firstName},</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">Your Nexus trial has ended.</p>${hasStreak ? `<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">You built a ${p.streakDays}-day streak on <strong style=\"color:#F0F0F0;\">${p.topHabit}</strong>. That's real. That didn't go anywhere — it's still yours.</p>` : `<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">You gave Nexus a real shot. Whether or not it clicked, I respect that.</p>`}<p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">If there's one thing I'd ask — it's to give it one more week. Habits take longer than 13 days to actually form. Nexus Pro is $9.99/month. No ads. No noise. Just your system, uninterrupted.</p><p style=\"margin:0;color:#B0B0B0;font-size:15px;line-height:26px;\">If it's not for you, totally fair. Unsubscribe from notifications and I'll stop reaching out. No hard feelings — I built this to help, not to pressure.</p></td></tr><tr><td style=\"padding:12px 0 40px;\" align=\"center\"><a href=\"${p.appUrl}\" style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">START PRO — $9.99/mo</a></td></tr><tr><td style=\"text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;\"><p style=\"margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;\">Nexus · Built for the intentional</p></td></tr></table></td></tr></table></body></html>`;
}

function htmlPostPurchase(p: { firstName: string; appUrl: string; plan: string; calendlyUrl: string }): string {
  const isAnnual = p.plan === 'annual';
  return `<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>You're in — welcome to Nexus Pro</title></head><body style=\"margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\"><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#000;padding:40px 0;\"><tr><td align=\"center\"><table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;width:100%;\"><tr><td style=\"padding:0 0 40px;text-align:center;\"><p style=\"margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;\">N E X U S</p></td></tr><tr><td style=\"padding:0 0 32px;\"><p style=\"margin:0;color:#B0B0B0;font-size:13px;letter-spacing:0.5px;\">${isAnnual ? 'Annual' : 'Monthly'} Pro · Activated</p></td></tr><tr><td style=\"padding:0 0 28px;\"><p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">Hey ${p.firstName},</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">You're in. Nexus Pro is now active — no ads, no friction, full access.</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">What you just did matters. You chose to invest in a system that measures your days against your standards. That's not a small decision — it's a identity-level one.</p>${isAnnual ? `<p style=\"margin:0 0 20px;color:#F0F0F0;font-size:15px;line-height:26px;font-weight:600;\">One more thing:</p><p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">I'm offering a 20-minute 1:1 call — no pitch, no sales. Just me walking through how to get the most out of Nexus Pro based on how you use it. Completely free and completely optional.</p><p style=\"margin:0 0 28px;color:#B0B0B0;font-size:15px;line-height:26px;\">If you're interested, book a time below. First 500 annual subscribers only.</p>` : `<p style=\"margin:0 0 28px;color:#B0B0B0;font-size:15px;line-height:26px;\">Everything you need is already in the app. Your history is preserved, your streaks remain intact. Go build on top of what you started.</p>`}</td></tr><tr><td style=\"padding:0 0 16px;\" align=\"center\"><a href=\"${p.appUrl}\" style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">OPEN NEXUS</a></td></tr>${isAnnual ? `<tr><td style=\"padding:0 0 40px;\" align=\"center\"><a href=\"${p.calendlyUrl}\" style=\"display:inline-block;border:1px solid #333;color:#888;font-size:12px;font-weight:600;letter-spacing:1px;padding:12px 32px;border-radius:30px;text-decoration:none;\">BOOK A 1:1 ONBOARDING CALL →</a></td></tr>` : `<tr><td style=\"height:40px;\"></td></tr>`}<tr><td style=\"text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;\"><p style=\"margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;\">Nexus · Built for the intentional</p></td></tr></table></td></tr></table></body></html>`;
}

// ── Resend send helper ────────────────────────────────────────────────────────

async function sendEmail(opts: {
  to:      string;
  subject: string;
  html:    string;
}): Promise<string> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to:   [opts.to],
      subject: opts.subject,
      html: opts.html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }

  const data = await res.json() as { id: string };
  return data.id;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getServiceRoleClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function getTrialUsers(): Promise<NexusProfile[]> {
  const sb = await getServiceRoleClient();
  const { data, error } = await sb
    .from('nexus_profiles')
    .select('user_id, email, name, trial_start, trial_end, plan_type, subscribed')
    .eq('subscribed', false)
    .not('trial_start', 'is', null);

  if (error) throw new Error(`Failed to fetch profiles: ${error.message}`);
  return (data ?? []) as NexusProfile[];
}

async function logEmailSent(userId: string, emailKey: string, messageId: string): Promise<void> {
  const sb = await getServiceRoleClient();
  await sb.from('nexus_email_log').upsert({
    user_id:    userId,
    email_key:  emailKey,
    sent_at:    new Date().toISOString(),
    message_id: messageId,
  }, { onConflict: 'user_id,email_key' });
}

async function alreadySent(userId: string, emailKey: string): Promise<boolean> {
  const sb = await getServiceRoleClient();
  const { data } = await sb
    .from('nexus_email_log')
    .select('id')
    .eq('user_id', userId)
    .eq('email_key', emailKey)
    .limit(1)
    .single();
  return !!data;
}

// ── Per-user streak lookup (stubbed from app state — needs app client data) ──
// For the scheduler, we pull from the persisted app state in AsyncStorage.
// Since we can't access RN AsyncStorage from an edge function, we use a
// reasonable default: the scheduler sends email without per-user streak data
// and the email templates handle the null case gracefully.
// In a future iteration, expose a /habits/summary endpoint in the app's API
// layer that the scheduler can call. For now, streakDays=0 is safe.

function getFirstName(name: string | null): string {
  return (name ?? '').split(' ')[0] || 'there';
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end   = new Date(endIso);
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Core dispatch ─────────────────────────────────────────────────────────────

async function processProfile(profile: NexusProfile): Promise<ScheduleResult[]> {
  const results: ScheduleResult[] = [];
  const now = new Date();
  const today = todayStr();

  const trialStart = profile.trial_start ? new Date(profile.trial_start) : null;
  const trialEnd   = profile.trial_end   ? new Date(profile.trial_end)   : null;

  if (!trialStart) return results;

  // ── Day 3 ─────────────────────────────────────────────────────────────────
  const day3Diff = daysBetween(profile.trial_start, todayStr() + 'T00:00:00Z');
  if (day3Diff >= 3 && !(await alreadySent(profile.user_id, 'trial_day_3'))) {
    try {
      const first = getFirstName(profile.name);
      const id = await sendEmail({
        to:      profile.email,
        subject: `Day 3 — How's it going, ${first}?`,
        html:    htmlDay3({ firstName: first, appUrl: APP_URL, trialDayLabel: 'Day 3 of 13' }),
      });
      await logEmailSent(profile.user_id, 'trial_day_3', id);
      results.push({ email_key: 'trial_day_3', user_id: profile.user_id, email: profile.email, sent: true });
    } catch (e: any) {
      results.push({ email_key: 'trial_day_3', user_id: profile.user_id, email: profile.email, sent: false, error: e.message });
    }
  }

  // ── Day 7 ─────────────────────────────────────────────────────────────────
  const day7Diff = daysBetween(profile.trial_start, todayStr() + 'T00:00:00Z');
  if (day7Diff >= 7 && !(await alreadySent(profile.user_id, 'trial_day_7'))) {
    try {
      const first = getFirstName(profile.name);
      const id = await sendEmail({
        to:      profile.email,
        subject: `One week in, ${first} — here's where you stand`,
        html:    htmlDay7({ firstName: first, appUrl: APP_URL, streakDays: 0 }),
      });
      await logEmailSent(profile.user_id, 'trial_day_7', id);
      results.push({ email_key: 'trial_day_7', user_id: profile.user_id, email: profile.email, sent: true });
    } catch (e: any) {
      results.push({ email_key: 'trial_day_7', user_id: profile.user_id, email: profile.email, sent: false, error: e.message });
    }
  }

  // ── Day 12 ────────────────────────────────────────────────────────────────
  // NEX-323: a user who received the lapsed win-back offer (a free month,
  // already granted) must not get the full-price ask below it (S19).
  const winbackOfferSent = await alreadySent(profile.user_id, 'winback-lapsed-offer');
  const day12Diff = daysBetween(profile.trial_start, todayStr() + 'T00:00:00Z');
  if (day12Diff >= 12 && !winbackOfferSent && !(await alreadySent(profile.user_id, 'trial_day_12'))) {
    try {
      const first = getFirstName(profile.name);
      const id = await sendEmail({
        to:      profile.email,
        subject: `Your trial ends tomorrow, ${first}`,
        html:    htmlDay12({ firstName: first, appUrl: APP_URL, streakDays: 0, topHabit: 'your habit' }),
      });
      await logEmailSent(profile.user_id, 'trial_day_12', id);
      results.push({ email_key: 'trial_day_12', user_id: profile.user_id, email: profile.email, sent: true });
    } catch (e: any) {
      results.push({ email_key: 'trial_day_12', user_id: profile.user_id, email: profile.email, sent: false, error: e.message });
    }
  }

  // ── Day 13 (trial ended) ──────────────────────────────────────────────────
  if (trialEnd && !profile.subscribed && !winbackOfferSent && !(await alreadySent(profile.user_id, 'trial_day_13'))) {
    const trialEndDate = trialEnd.toISOString().slice(0, 10);
    if (todayStr() >= trialEndDate) {
      try {
        const first = getFirstName(profile.name);
        const id = await sendEmail({
          to:      profile.email,
          subject: `Your trial ended — one offer, no pressure`,
          html:    htmlDay13({ firstName: first, appUrl: APP_URL, streakDays: 0, topHabit: 'your habit' }),
        });
        await logEmailSent(profile.user_id, 'trial_day_13', id);
        results.push({ email_key: 'trial_day_13', user_id: profile.user_id, email: profile.email, sent: true });
      } catch (e: any) {
        results.push({ email_key: 'trial_day_13', user_id: profile.user_id, email: profile.email, sent: false, error: e.message });
      }
    }
  }

  return results;
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    // 2026-10-18: only the pg_cron job (service-role key) may run the send.
    // Before this, anyone with the public app key could trigger it.
    if (!(await isServiceRoleCaller(req))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!RESEND_API_KEY) {
      console.error('[email-scheduler] RESEND_API_KEY not set');
      return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), { status: 500 });
    }

    if (!SERVICE_ROLE_KEY) {
      console.error('[email-scheduler] SUPABASE_SERVICE_ROLE_KEY not set');
      return new Response(JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }), { status: 500 });
    }

    // Run scheduler
    const profiles = await getTrialUsers();
    console.log(`[email-scheduler] Processing ${profiles.length} trial users`);

    const allResults: ScheduleResult[] = [];
    for (const profile of profiles) {
      try {
        const results = await processProfile(profile);
        allResults.push(...results);
      } catch (e: any) {
        console.error(`[email-scheduler] Error processing user ${profile.user_id}:`, e.message);
      }
    }

    const sent = allResults.filter(r => r.sent).length;
    const failed = allResults.filter(r => !r.sent).length;
    console.log(`[email-scheduler] Done. Sent: ${sent}, Failed: ${failed}`);

    return new Response(JSON.stringify({
      success: true,
      processed: profiles.length,
      sent,
      failed,
      // Per-user results (emails, user ids) stay in the logs, never the
      // response: this endpoint is reachable without auth (2026-10-18 fix).
      results: allResults.map(r => ({ email_key: r.email_key, sent: r.sent })),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[email-scheduler] Fatal error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});