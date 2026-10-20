import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ScrollView, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';
import type { CountryCode } from 'libphonenumber-js/min';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { Sheet } from '../../components/ui/Sheet';
import { useAppState } from '../../state/app-state';
import { supabase } from '../../services/supabase';
import { getLocalDateKey } from '../../utils/recurrence';
import { SMS_CONSENT_VERSION, SMS_CONSENT_BODY, SMS_CONSENT_DISCLOSURE } from './sms-consent';
import { shouldShowSmsAsk, SMS_ASK_DISMISSED_KEY } from './sms-ask-gating';
import { hasDemonstratedValue } from './review-prompt-gating';

const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;
const RED = tokens.color.stateError;

// 2-letter ISO code -> flag emoji (regional-indicator pair) for the phone picker.
const countryFlag = (cc: string) =>
  cc.replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));

/**
 * NEX-321 — in-app SMS opt-in ask, shown after demonstrated value.
 *
 * Self-gates (see sms-ask-gating.ts): only after demonstrated value and on a
 * later day than the separate email choice, never once dismissed, and never
 * while the server reports a live subscription ('pending' / 'confirmed').
 * Every read fails safe — a storage miss or failed status invoke stays hidden.
 *
 * With no phone on file the card collects it first (same country-flag picker
 * and E.164 validation as the Settings phone modal), upserts user_profile,
 * then fires the enable call in the same tap. With a number already on file,
 * a "Use a different number" link reopens the same editor prefilled. Consent
 * version and text go to the server verbatim as the consent audit-of-record.
 *
 * Styling mirrors AnalyticsConsentSheet (scrim, card, ambient glow, gold
 * primary). Copy is declarative. No em dashes, no exclamation points.
 */
export default function SmsOptInSheet() {
  const isActivated = useAppState((s) => s.isActivated);
  const phoneNumber = useAppState((s) => s.userProfile?.phoneNumber);
  const setPhoneNumber = useAppState((s) => s.setPhoneNumber);
  const habitLog = useAppState((s) => s.habitLog);
  const emailConsent = useAppState((s) => s.weeklyEmailConsent);
  const emailConsentUpdatedAt = useAppState((s) => s.weeklyEmailConsentUpdatedAt);
  const router = useRouter();

  // Hide until every gate input has landed (fail safe on any read failure).
  const [dismissed, setDismissed] = useState(true);
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [gateLoaded, setGateLoaded] = useState(false);

  const [phoneCountry, setPhoneCountry] = useState('US');
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneError, setPhoneError] = useState('');
  // Greptile P1 (rounds 5-6): true while the phone editor is active. Set after
  // an in-session validate + upsert, and by the "Use a different number" link.
  // Keeps the phone step active until enable succeeds, so a failed enable
  // (e.g. 409 phone_in_use) leaves the input visible and a retry re-validates,
  // re-upserts, and re-invokes instead of silently reusing the persisted
  // number — including after an app restart, where only the persisted number
  // survives and the link is the way back into the editor.
  const [phoneEditing, setPhoneEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dismissedRaw = await AsyncStorage.getItem(SMS_ASK_DISMISSED_KEY);
        if (cancelled) return;
        setDismissed(dismissedRaw === 'true');
        // Server status. An invoke failure must NOT open the ask, so a throw
        // here skips setGateLoaded and the sheet stays hidden.
        const { data, error } = await supabase.functions.invoke('sms-opt-in', {
          body: { action: 'status' },
        });
        if (cancelled || error) return;
        setServerStatus(data?.optIn?.opt_in_status ?? null);
        setGateLoaded(true);
      } catch {
        /* fail safe: leave gateLoaded false so the sheet never shows */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Same common-countries-first ordering as the Settings phone modal.
  const countryCodes = useMemo(() => {
    const COMMON = ['US', 'CA', 'GB', 'AU', 'IE', 'NZ', 'IN'];
    const all = getCountries();
    const common = COMMON.filter((c) => all.includes(c as CountryCode));
    return [...common, ...all.filter((c) => !common.includes(c))];
  }, []);

  const visible =
    gateLoaded &&
    shouldShowSmsAsk({
      isActivated,
      demonstratedValue: hasDemonstratedValue(habitLog ?? []),
      dismissed,
      emailConsent,
      emailDecisionDayKey: emailConsentUpdatedAt
        ? getLocalDateKey(new Date(emailConsentUpdatedAt))
        : null,
      todayKey: getLocalDateKey(new Date()),
      serverStatus,
    });

  const markDismissed = () => {
    AsyncStorage.setItem(SMS_ASK_DISMISSED_KEY, 'true').catch(() => {});
    setDismissed(true);
  };

  const dismiss = () => {
    haptic('buttonSecondary');
    markDismissed();
  };

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!useAppState.getState().userProfile?.phoneNumber || phoneEditing) {
        const parsed = parsePhoneNumberFromString(phoneInput.trim(), phoneCountry as CountryCode);
        if (!parsed?.isValid()) {
          setPhoneError('That number looks invalid. Please check and try again.');
          return;
        }
        const e164 = parsed.number;
        const { data: { user } } = await supabase.auth.getUser();
        // Greptile P1: a failed (or unauthenticated) phone write must surface
        // inline and stop the flow. Saving to app state anyway would hide the
        // phone input on retry, locking the user out of correcting the number.
        if (!user?.id) {
          setPhoneError('Could not save your number. Check your connection and try again.');
          return;
        }
        const { error: upsertError } = await supabase
          .from('user_profile')
          .upsert({ user_id: user.id, phone_number: e164 }, { onConflict: 'user_id' });
        if (upsertError) {
          setPhoneError('Could not save your number. Check your connection and try again.');
          return;
        }
        setPhoneNumber(e164);
        setPhoneEditing(true);
      }
      const { data, error } = await supabase.functions.invoke('sms-opt-in', {
        // NEX-181: report the exact disclosure the user saw so the server can record
        // the consent audit trail (version is server-validated; text stored verbatim).
        body: { action: 'enable', consentVersion: SMS_CONSENT_VERSION, consentText: SMS_CONSENT_DISCLOSURE },
      });
      if (error) throw error;
      // A successful enable permanently retires the ask.
      markDismissed();
      if (data?.optIn?.opt_in_status === 'pending') {
        Alert.alert('Check your texts', 'We sent a confirmation. Reply YES to finish signing up.');
      }
    } catch (e: any) {
      // NEX-321: a 409 phone_in_use means another account holds the live
      // subscription on this number. The generic e.message ("Edge Function
      // returned a non-2xx status code") would leave the user stuck, so read
      // the response body for the specific case and say how to resolve it.
      // Mirrors settings-screen.tsx's toggleSms.
      let message = e?.message || 'Could not update SMS settings. Try again.';
      try {
        const body = await e?.context?.json();
        if (body?.error === 'phone_in_use') {
          message =
            'This number is subscribed from another account. If the number is yours, text STOP from that phone first, then try again.';
        }
      } catch { /* keep the generic message */ }
      Alert.alert('SMS Updates', message);
    } finally {
      setBusy(false);
    }
  };

  // Reveal the phone editor over a persisted number, prefilled from the stored
  // E.164 the same way the Settings phone modal re-derives country + national
  // input (settings-screen.tsx openPhoneModal). This is the durable edit path:
  // a number rejected by a past enable attempt stays on file across restarts,
  // so the sheet must offer a way to replace it.
  const revealPhoneEditor = () => {
    const stored = useAppState.getState().userProfile?.phoneNumber;
    if (stored) {
      const parsed = parsePhoneNumberFromString(stored);
      setPhoneCountry((parsed?.country as string) ?? 'US');
      setPhoneInput(parsed?.nationalNumber || stored);
    }
    setPhoneError('');
    setPhoneEditing(true);
  };

  // Mirror the Settings disclosure links (gold, underlined, route to /legal).
  // The sheet hides locally so the legal page is not stuck under the modal;
  // the dismissed key is NOT set, so the ask can return on a later launch.
  const openLegal = (type: 'privacy' | 'terms') => {
    setDismissed(true);
    setTimeout(() => router.push(`/legal?type=${type}`), 350);
  };

  return (
    <Sheet
      visible={visible}
      variant="center"
      onDismiss={dismiss}
      dismissOnBackdropPress={false}
      accessibilityLabel="Text updates opt in"
    >
      <Text style={styles.eyebrow}>TEXT UPDATES</Text>
      <Text style={styles.body}>
        Your wins and reflections can arrive by text. One message when it matters, never a feed.
      </Text>

      {(!phoneNumber || phoneEditing) && (
        <View style={styles.phoneBlock}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.countryRow}>
            {countryCodes.map((country) => (
              <Pressable
                key={country}
                onPress={() => setPhoneCountry(country)}
                style={[
                  styles.countryChip,
                  { borderColor: phoneCountry === country ? GOLD : BORDER },
                ]}
              >
                <Text style={{ color: phoneCountry === country ? GOLD : TEXT }}>
                  {countryFlag(country)} {country} +{getCountryCallingCode(country as CountryCode)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <TextInput
            value={phoneInput}
            onChangeText={(v) => { setPhoneInput(v); setPhoneError(''); }}
            style={styles.phoneInput}
            placeholder="Phone number"
            placeholderTextColor={MUTED}
            keyboardType="phone-pad"
          />
          {!!phoneError && <Text style={styles.phoneError}>{phoneError}</Text>}
        </View>
      )}

      <Text style={styles.disclosure}>
        {SMS_CONSENT_BODY} See our{' '}
        <Text style={styles.disclosureLink} onPress={() => openLegal('privacy')}>
          Privacy Policy
        </Text>
        {' '}and{' '}
        <Text style={styles.disclosureLink} onPress={() => openLegal('terms')}>
          Terms
        </Text>
        .
      </Text>

      <PrimaryPill fullWidth disabled={busy} onPress={enable} style={{ marginBottom: tokens.spacing.xs }}>
        Turn on text updates
      </PrimaryPill>

      {phoneNumber && !phoneEditing && (
        <Pressable
          onPress={revealPhoneEditor}
          accessibilityRole="button"
          accessibilityLabel="Use a different number"
        >
          <Text style={styles.editLink}>Use a different number</Text>
        </Pressable>
      )}

      <Pressable style={styles.secondary} onPress={dismiss}>
        <Text style={styles.secondaryText}>Not now</Text>
      </Pressable>

      <Text style={styles.footnote}>Manage this anytime in Settings.</Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  eyebrow: { ...tokens.type.labelTrackedLg, color: GOLD, marginBottom: tokens.spacing.sm },
  body: { ...tokens.type.bodyMd, color: MUTED, marginBottom: tokens.spacing.md },
  phoneBlock: { marginBottom: tokens.spacing.md },
  countryRow: { marginBottom: tokens.spacing.sm },
  countryChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 10,
    marginRight: 8,
  },
  phoneInput: {
    ...tokens.type.bodyMd,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    padding: 10,
    color: TEXT,
  },
  phoneError: { color: RED, marginTop: tokens.spacing.sm },
  disclosure: {
    ...tokens.type.caption,
    color: MUTED,
    marginBottom: tokens.spacing.md,
  },
  disclosureLink: { color: GOLD, textDecorationLine: 'underline' },
  editLink: {
    ...tokens.type.caption,
    color: MUTED,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginBottom: tokens.spacing.xs,
  },
  secondary: {
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: tokens.radii.md,
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
  },
  secondaryText: { ...tokens.type.buttonPrimary, color: MUTED },
  footnote: {
    ...tokens.type.caption,
    color: MUTED,
    textAlign: 'center',
    marginTop: tokens.spacing.sm,
  },
});
