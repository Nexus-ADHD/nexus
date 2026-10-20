/**
 * Connect AI (nexus-mcp): link ChatGPT or Claude to this Nexus account.
 *
 * The screen mints one-time connection codes (plaintext shown ONCE, only
 * the sha-256 hash reaches Supabase, 10-minute TTL enforced server-side),
 * walks the user through adding the connector in ChatGPT / Claude, and
 * lists + revokes live connections via the worker's /connections routes.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Share } from 'react-native';
import { Card } from '@/src/components/ui/Card';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getCurrentUser } from '@/src/services/supabase';
import {
  MCP_SERVER_URL,
  listConnections,
  mintConnectionCode,
  revokeConnection,
  type AiConnection,
} from '@/src/services/connect-ai';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';

const BG = tokens.color.void;
const GOLD = tokens.color.gold;
const TEAL = tokens.color.teal;
const RED = tokens.color.stateError;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;

const CODE_TTL_SECONDS = 600;

export default function ConnectAiScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [code, setCode] = React.useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [connections, setConnections] = React.useState<AiConnection[] | null>(null);

  const refreshConnections = React.useCallback(async () => {
    try {
      setConnections(await listConnections());
    } catch {
      setConnections([]); // offline or pre-migration — show empty, not an error wall
    }
  }, []);

  React.useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  // 10:00 countdown after minting. The plaintext stays only in component
  // state and only while the timer is live (codeActive gates the display) —
  // it can never be read back (only the hash is stored).
  const codeActive = secondsLeft > 0;
  React.useEffect(() => {
    if (!codeActive) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [codeActive]);

  const generate = async () => {
    haptic('buttonSecondary');
    setBusy(true);
    setError(null);
    try {
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      setCode(await mintConnectionCode(user.id));
      setSecondsLeft(CODE_TTL_SECONDS);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = () => {
    haptic('buttonSecondary');
    void Share.share({ message: MCP_SERVER_URL });
  };

  const disconnect = async (id: string) => {
    haptic('buttonSecondary');
    try {
      await revokeConnection(id);
      await refreshConnections();
    } catch (e: any) {
      setError(e?.message ?? 'Could not disconnect');
    }
  };

  const mm = String(Math.floor(secondsLeft / 60));
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{ title: 'Connect AI', headerStyle: { backgroundColor: BG }, headerTintColor: TEXT }}
      />
      <AdaptiveScreen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + tokens.spacing.md }]}
        showsVerticalScrollIndicator={false}
      >
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.backText}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.title}>CONNECT AI</Text>
        <Text style={styles.subtitle}>
          Link ChatGPT or Claude to your Nexus account. Your AI coach can then read your journal,
          habits, and mandates, and it can log entries or queue changes that land the next time the app
          syncs.
        </Text>

        {/* ── Step 1: the server address ─────────────────────────────────── */}
        <Card style={styles.card}>
          <Text style={styles.step}>STEP 1: ADD THE CONNECTOR</Text>
          <Text style={styles.body}>
            In ChatGPT: Settings → Apps → Advanced → Developer mode → add a connector.{'\n'}
            In Claude: Settings → Connectors → Add custom connector.{'\n'}
            Paste this address:
          </Text>
          <Text style={styles.url} selectable>
            {MCP_SERVER_URL}
          </Text>
          <View style={styles.actions}>
            <Pressable hitSlop={8} style={[styles.btn, { borderColor: TEAL }]} onPress={shareUrl}>
              <Text style={[styles.btnText, { color: TEAL }]}>SHARE / COPY</Text>
            </Pressable>
          </View>
        </Card>

        {/* ── Step 2: the one-time code ──────────────────────────────────── */}
        <Card style={styles.card}>
          <Text style={styles.step}>STEP 2: ENTER YOUR CODE</Text>
          <Text style={styles.body}>
            When the Nexus consent page opens, it asks for a connection code. Generate one here.
            It works once, for ten minutes.
          </Text>
          {codeActive && code ? (
            <>
              <Text style={styles.code} selectable>
                {code}
              </Text>
              <Text style={styles.countdown}>
                expires in {mm}:{ss}
              </Text>
            </>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              hitSlop={8}
              disabled={busy}
              style={[styles.btn, { borderColor: GOLD, opacity: busy ? 0.5 : 1 }]}
              onPress={generate}
            >
              <Text style={[styles.btnText, { color: GOLD }]}>
                {codeActive ? 'REGENERATE' : 'GENERATE CODE'}
              </Text>
            </Pressable>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </Card>

        {/* ── Live connections ───────────────────────────────────────────── */}
        <Card style={styles.card}>
          <Text style={styles.step}>CONNECTIONS</Text>
          {connections === null ? (
            <Text style={styles.body}>Loading…</Text>
          ) : connections.length === 0 ? (
            <Text style={styles.body}>No AI apps connected yet.</Text>
          ) : (
            connections.map((c) => (
              <View key={c.id} style={styles.connectionRow}>
                <Text style={styles.connectionName}>{c.client}</Text>
                <Pressable hitSlop={8} onPress={() => disconnect(c.id)}>
                  <Text style={[styles.btnText, { color: RED }]}>DISCONNECT</Text>
                </Pressable>
              </View>
            ))
          )}
        </Card>
      </ScrollView>
      </AdaptiveScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: tokens.spacing.lg, paddingBottom: 80 },
  back: { paddingVertical: tokens.spacing.xs, marginBottom: tokens.spacing.xs },
  backText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  title: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4, marginBottom: tokens.spacing.sm },
  subtitle: { color: MUTED, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  card: { marginTop: tokens.spacing.sm },
  step: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xs },
  body: { color: MUTED, fontSize: 13, lineHeight: 19 },
  url: { color: TEAL, fontSize: 13, marginTop: tokens.spacing.sm },
  code: {
    color: TEXT,
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 8,
    textAlign: 'center',
    marginTop: tokens.spacing.md,
  },
  countdown: { color: MUTED, fontSize: 12, textAlign: 'center', marginTop: tokens.spacing.xs },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: tokens.spacing.md },
  btn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 9999, borderWidth: 1 },
  btnText: { fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  error: { color: RED, fontSize: 13, marginTop: tokens.spacing.sm },
  connectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: tokens.spacing.xs,
  },
  connectionName: { color: TEXT, fontSize: 15, fontWeight: '700' },
});
