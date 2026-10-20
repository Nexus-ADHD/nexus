// src/features/auth/auth-screen.tsx
// Sign in with Apple — works on both iPhone and iPad
// @ts-nocheck
import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert, Platform, Linking, ScrollView } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { supabase } from '../../services/supabase';
import { publicConfigValue } from '../../utils/public-config';
import { haptic } from '@/src/utils/haptics';
import { useRouter } from 'expo-router';
import tokens from '@/src/theme/tokens';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';

const BG = tokens.color.void;
const GOLD = tokens.color.gold;
const TEXT_COLOR = tokens.color.text;
// v3 stellar: muted gray #555 → tokens.color.textMuted (cool blue-gray).
const MUTED = tokens.color.textMuted;

// NEX-84 Greptile follow-up: render the Google button only when the same
// config that gates GoogleSignin.configure() in app/_layout.tsx resolves.
// Otherwise tapping the button would call into an unconfigured native
// module — a silent misconfiguration that reaches end users. Evaluated
// at module scope because EXPO_PUBLIC_* env vars are baked at build time
// and app.json extra is fixed per binary; neither changes at runtime.
const GOOGLE_SIGNIN_AVAILABLE = !!publicConfigValue(
  'EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID',
  process.env.EXPO_PUBLIC_GOOGLE_SIGNIN_IOS_CLIENT_ID,
);

// App Review 4.0 (2026-07-02 rejection): Apple/Google already provide the
// user's name at sign-in, so onboarding must not re-ask for it. Persist it
// to Supabase auth user metadata here — Apple returns fullName ONLY on the
// FIRST authorization for an Apple ID, so this write is the one chance to
// capture it (it must survive app kill/reinstall before onboarding commits).
// Reads the POST-sign-in user (the pre-link user may be the anonymous
// session) and never overwrites a name a returning user already has. A
// metadata failure must never block sign-in — onboarding falls back to the
// manual name step when no name is known.
async function persistProviderName(
  user: { user_metadata?: Record<string, any> } | null | undefined,
  fullName: string | null | undefined,
  givenName?: string | null,
) {
  try {
    const name = (fullName ?? '').trim();
    if (!name || !user) return;
    const meta = user.user_metadata ?? {};
    if (meta.given_name || meta.full_name || meta.name) return;
    const given = (givenName ?? '').trim();
    // Time-boxed: the write should normally land before onboarding reads
    // it, but a hung request must never strand the user on the auth screen.
    // Onboarding re-checks metadata on every phase change, so a write that
    // lands after the timeout is still picked up.
    await Promise.race([
      supabase.auth.updateUser({
        data: { full_name: name, ...(given ? { given_name: given } : {}) },
      }),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  } catch (e: any) {
    console.log('[Auth] name metadata write failed:', e?.message);
  }
}

interface Props {
  onSignedIn: () => void;
  // Dev-only escape hatch (see handleDevSkipAuth in app/_layout.tsx):
  // OAuth fails on device dev clients, so this skips straight past auth.
  // Only ever passed under __DEV__; release builds receive undefined.
  onDevSkip?: () => void;
}

export function AuthScreen({ onSignedIn, onDevSkip }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');


  const handleGoogleSignIn = async () => {
    if (loading) return;
    setErrorMsg('');
    try {
      setLoading(true);
      haptic('dragDrop');

      // NEX-84 Greptile fix: hasPlayServices is Android-only. This auth
      // screen renders on iOS only (Apple sign-in is also iOS-gated above),
      // so the check is dead code at best and a stray reject at worst.
      const userInfo = await GoogleSignin.signIn();

      // NEX-84 Greptile fix: v15 returns { type: 'cancelled', data: null }
      // on user dismiss instead of throwing. Without this guard, the
      // !idToken branch below throws a plain Error with no .code, which
      // bypasses every cancel check in the catch block — every cancel
      // would surface "Sign in with Google failed" to the user.
      if ((userInfo as any)?.type === 'cancelled') {
        return;
      }

      const idToken = userInfo?.data?.idToken ?? (userInfo as any)?.idToken;

      if (!idToken) {
        throw new Error('No ID token received from Google');
      }

      // ONE path — see the Apple handler below for the full rationale.
      const result = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });

      const { data, error } = result;
      if (error) throw new Error(error.message || 'Authentication failed');
      if (!data?.session) throw new Error('No session created');

      // Symmetric with Apple: persist the Google-provided name so
      // onboarding never re-asks for it (v15 shape, with legacy fallback).
      const gUser = userInfo?.data?.user ?? (userInfo as any)?.user;
      const googleName =
        gUser?.name || [gUser?.givenName, gUser?.familyName].filter(Boolean).join(' ');
      await persistProviderName(data.user, googleName, gUser?.givenName);

      haptic('voiceSuccess');
      setTimeout(() => onSignedIn(), 300);
    } catch (e: any) {
      if (e?.code === 'SIGN_IN_CANCELLED' || e?.code === '12501' || e?.code === 'ERR_CANCELED') {
        return;
      }
      console.log('[Auth] Google Error:', e?.code, e?.message);
      setErrorMsg(e?.message || 'Sign in with Google failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    if (loading) return;
    setErrorMsg('');
    try {
      setLoading(true);
      haptic('dragDrop');

      // Sign in with Apple — works on both iPhone and iPad
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken) {
        throw new Error('No identity token received from Apple');
      }

      // ONE path: sign in with the identity. Never link it onto the
      // anonymous session. (Owner-approved 2026-08-27 — supersedes NEX-64's
      // anonymous-linking, which is deleted rather than repaired.)
      //
      // The old flow was: if the session is anonymous, LINK this identity to
      // it so the anon user_id (and its pre-signin analytics) carries over;
      // if that link errors AND the message contains "already" or "identity",
      // fall back to signInWithIdToken. Two ways that lost people their data:
      //
      //  1. THE SILENT FORK. The link only fails when this identity is
      //     already attached to a real account. If the user's account was
      //     created with the OTHER provider — signed up with Google, now
      //     signing in with Apple on a new device — nothing is attached, so
      //     the link SUCCEEDS and they are now the anonymous uuid: a brand
      //     new user with an empty user_state. Their real account still
      //     exists, just unreachable from this device. It reads as "all my
      //     data is gone".
      //
      //  2. MATCHING ERROR PROSE. The recovery hinged on substring-matching
      //     a human-readable message. A Supabase error phrased any other way
      //     ("Manual linking is disabled", a localized string, any rewording
      //     upstream) skips the fallback entirely and sign-in just fails.
      //
      // signInWithIdToken resolves the identity to the SAME user every time,
      // on every device, across reinstalls. Existing account -> you land in
      // it. No account -> one is created keyed to the identity. There is no
      // branch left in which a returning user can silently become a new one.
      //
      // Cost: none, as it turns out. This comment used to say the change cost
      // pre-signin analytics attribution, and that the anonymous session was
      // "load-bearing" for ai-proxy and nexus_events. BOTH WERE WRONG, in the
      // same way: they were inherited from a code comment rather than checked
      // against the data. Anonymous sign-ins are disabled on the project, so
      // no anonymous session has ever existed (zero auth.identities rows with
      // provider 'anonymous', across 177 users since April) — meaning there
      // were never any pre-signin events to lose, and nothing was leaning on
      // it. The dead call was removed 2026-08-28.
      //
      // App DATA is unaffected either way: while signed out the app renders
      // only AuthScreen, so there is no pre-signin local data to strand.
      const result = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
      });

      const { data, error } = result;

      if (error) {
        console.log('[Auth] Supabase error:', error.message);
        throw new Error(error.message || 'Authentication failed');
      }

      if (!data?.session) {
        throw new Error('No session created');
      }

      // Capture the Apple-provided name before transitioning (awaited so
      // onboarding's metadata read sees it; formatFullName is locale-aware
      // but throws when the native module is missing, hence the fallback).
      let appleName = '';
      if (credential.fullName) {
        try {
          appleName = AppleAuthentication.formatFullName(credential.fullName) ?? '';
        } catch {
          appleName = '';
        }
        if (!appleName.trim()) {
          appleName = [credential.fullName.givenName, credential.fullName.familyName]
            .filter(Boolean)
            .join(' ');
        }
      }
      await persistProviderName(data.user, appleName, credential.fullName?.givenName);

      haptic('voiceSuccess');

      // Small delay to let auth state propagate before transitioning
      setTimeout(() => {
        onSignedIn();
      }, 300);

    } catch (e: any) {
      console.log('[Auth] Error:', e.code, e.message);
      if (e.code === 'ERR_REQUEST_CANCELED' || e.code === 'ERR_CANCELED') {
        // User cancelled — do nothing
        return;
      }
      setErrorMsg(e.message || 'Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <AdaptiveScreen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Brand */}
        <Text style={styles.logo}>N E X U S</Text>
        <Text style={styles.tagline}>REMEMBER WHO YOU ARE</Text>

        {/* Value prop */}
        <View style={[styles.features, styles.centeredColumn]}>
          <Text style={styles.featureText}>◆  Track habits that shape your identity</Text>
          <Text style={styles.featureText}>◆  AI-powered weekly debriefs</Text>
          <Text style={styles.featureText}>◆  Connect daily actions to your life vision</Text>
          <Text style={styles.featureText}>◆  Intelligent daily planning with calendar sync</Text>
        </View>

        {/* Sign in */}
        <View style={[styles.authSection, styles.centeredColumn]}>
          {Platform.OS === 'ios' && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={14}
              style={styles.appleBtn}
              onPress={handleAppleSignIn}
            />
          )}

          {Platform.OS === 'ios' && GOOGLE_SIGNIN_AVAILABLE && (
            <Pressable
              style={({ pressed }) => [styles.googleBtn, pressed && { opacity: 0.85 }]}
              onPress={handleGoogleSignIn}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Sign in with Google"
            >
              <Text style={styles.googleBtnText}>Sign in with Google</Text>
            </Pressable>
          )}

          {loading && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: tokens.spacing.md, gap: tokens.spacing.xs }}>
              <ActivityIndicator color={GOLD} size="small" />
              {/* FIXME(nex-56): off-scale 12pt fontSize — design review */}
              <Text style={{ color: MUTED, fontSize: 12 }}>Signing in...</Text>
            </View>
          )}

          {errorMsg ? (
            // FIXME(nex-56): error red #FF5252 has no token (CLAUDE.md stateError #C6523A warm-muted is closest) + off-scale 12pt fontSize — design review
            <Text style={{ color: tokens.color.stateError, fontSize: 12, marginTop: tokens.spacing.sm, textAlign: 'center' }}>{errorMsg}</Text>
          ) : null}

          <Text style={styles.disclaimer}>
            By continuing, you agree to our{' '}
            <Text
              style={{ textDecorationLine: 'underline', color: MUTED }}
              onPress={() => router.push('/legal?type=terms')}
              accessibilityRole="link"
              accessibilityLabel="Terms of Service"
            >
              Terms of Service
            </Text>
            {' '}and{' '}
            <Text
              style={{ textDecorationLine: 'underline', color: MUTED }}
              onPress={() => router.push('/legal?type=privacy')}
              accessibilityRole="link"
              accessibilityLabel="Privacy Policy"
            >
              Privacy Policy
            </Text>
          </Text>

          {__DEV__ && onDevSkip ? (
            <Pressable
              onPress={onDevSkip}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Skip sign-in, development only"
            >
              <Text style={styles.devSkip}>SKIP SIGN-IN (DEV)</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      </AdaptiveScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  // FIXME(nex-56): off-scale 60pt paddingVertical — design review
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: tokens.spacing.xl, paddingVertical: 60, alignItems: 'center' },
  // FIXME(nex-56): off-scale 28pt fontSize (matches titleScreen 28pt but weight 900 differs) — design review
  logo: { color: GOLD, fontSize: 28, fontWeight: '900', letterSpacing: 12, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 9pt fontSize + 60pt margin — design review
  tagline: { color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 4, marginBottom: 60 },
  // FIXME(nex-56): off-scale 14pt gap + 60pt margin — design review
  features: { alignSelf: 'stretch', gap: 14, marginBottom: 60 },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  featureText: { color: TEXT_COLOR, fontSize: 14, fontWeight: '500', lineHeight: 22, opacity: 0.8 },
  centeredColumn: { alignSelf: 'center', maxWidth: 400, width: '100%' },
  authSection: { alignItems: 'center' },
  appleBtn: { width: '100%', height: 54 },
  googleBtn: { width: '100%', height: 54, borderRadius: 14, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', marginTop: tokens.spacing.sm },
  googleBtnText: { color: '#000', fontSize: 17, fontWeight: '600' },
  // FIXME(nex-56): off-scale gray #333 + 10pt fontSize + 20pt margin — design review
  disclaimer: { color: tokens.color.textDisabled, fontSize: 10, textAlign: 'center', marginTop: 20, lineHeight: 16 },
  // Dev-only skip button — label.tracked.sm, muted, deliberately quiet.
  devSkip: {
    fontFamily: tokens.type.labelTrackedSm.fontFamily,
    fontSize: tokens.type.labelTrackedSm.fontSize,
    lineHeight: tokens.type.labelTrackedSm.lineHeight,
    letterSpacing: tokens.type.labelTrackedSm.fontSize * tokens.type.labelTrackedSm.letterSpacing,
    color: MUTED,
    opacity: 0.6,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: tokens.spacing.md,
  },
});
