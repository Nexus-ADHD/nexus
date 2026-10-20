import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet as RNStyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlurView } from 'expo-blur';
import tokens from '../../src/theme/tokens';
import { Sheet } from '@/src/components/ui/Sheet';
import { PrimaryPill } from '../../src/components/ui/PrimaryPill';

const TAB_GUIDE = [
  { icon: '🏠', tab: 'HOME', desc: 'Your daily anchor — score, intention, today\'s habits, and your next move.' },
  { icon: '🎙', tab: 'COMMAND', desc: 'Talk to Nexus. Capture anything by voice or text.' },
  { icon: '📅', tab: 'ORBIT', desc: 'Your day in motion — calendar, tasks, and habit system.' },
  { icon: '📥', tab: 'INBOX', desc: 'A place to park ideas and tasks for later.' },
  { icon: '🔺', tab: 'ALIGN', desc: 'Who you\'re becoming — your mandates and weekly reflection.' },
];

function TabTutorial({ onDismiss }: { onDismiss: () => void }) {
  const [step, setStep] = useState(0);
  const current = TAB_GUIDE[step];
  const isLast = step === TAB_GUIDE.length - 1;

  // Marks the tutorial seen and closes. Shared by the Skip link and by the
  // Android back button, which previously did nothing at all: the modal had no
  // onRequestClose, so back left the user stuck tapping through.
  const finish = () => {
    AsyncStorage.setItem('nexus_tutorial_seen', 'true');
    onDismiss();
  };

  return (
    <Sheet
      variant="center"
      // A first-run tutorial should not vanish on a stray tap beside it.
      dismissOnBackdropPress={false}
      onDismiss={finish}
      accessibilityLabel={`Tab tutorial, step ${step + 1} of ${TAB_GUIDE.length}`}
    >
      <Text style={tutStyles.icon}>{current.icon}</Text>
      <Text style={tutStyles.tab}>{current.tab}</Text>
      <Text style={tutStyles.desc}>{current.desc}</Text>
      <View style={tutStyles.dots}>
        {TAB_GUIDE.map((_, i) => (
          <View key={i} style={[tutStyles.dot, i === step && tutStyles.dotActive]} />
        ))}
      </View>
      <PrimaryPill
        fullWidth
        onPress={() => {
          if (isLast) {
            AsyncStorage.setItem('nexus_tutorial_seen', 'true');
            onDismiss();
          } else {
            setStep(step + 1);
          }
        }}
      >
        {isLast ? 'GET STARTED' : 'NEXT'}
      </PrimaryPill>
      {!isLast && (
        <Pressable onPress={finish} style={{ marginTop: tokens.spacing.sm }}>
          {/* v3 stellar: skip-tutorial gray #555 → tokens.color.textMuted. */}
          <Text style={{ color: tokens.color.textMuted, fontSize: 11 }}>Skip tutorial</Text>
        </Pressable>
      )}
    </Sheet>
  );
}

const tutStyles = RNStyleSheet.create({
  // v3 stellar: pure black scrim → cosmic vignette (CLAUDE.md §4.8).
  overlay: { flex: 1, backgroundColor: 'rgba(2,2,8,0.78)', justifyContent: 'center', alignItems: 'center', padding: tokens.spacing.xl },
  // v3 stellar: neutral border #222 → tokens.color.goldHairline (now white).
  card: { backgroundColor: tokens.color.surface, borderRadius: 20, padding: tokens.spacing.xl, alignItems: 'center', maxWidth: 340, width: '100%', borderWidth: 1, borderColor: tokens.color.goldHairline },
  // FIXME(nex-56): off-scale fontSize 40 (decorative emoji size), design review
  icon: { fontSize: 40, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale fontSize 14 + fontWeight '900' (tracked-caps but no token match) — design review
  tab: { color: tokens.color.gold, fontSize: 14, fontWeight: '900', letterSpacing: 4, marginBottom: tokens.spacing.sm },
  // v3 stellar: tutorial body gray #CCC → tokens.color.textSecondary.
  desc: { color: tokens.color.textSecondary, fontSize: 15, lineHeight: 24, textAlign: 'center', marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  dots: { flexDirection: 'row', gap: 6 /* FIXME(nex-56): off-scale spacing 6 — review */, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  // v3 stellar: dot gray #333 → tokens.color.textDisabled.
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.color.textDisabled },
  dotActive: { backgroundColor: tokens.color.gold, width: 18 },
});

export default function TabLayout() {
  const [showTutorial, setShowTutorial] = useState(false);
  // iPad (2026-08-26): the tab bar spans the FULL screen width on every
  // viewport. An earlier adaptive pass center-constrained it to the content
  // column and it read as janky; content stays center-constrained per-screen.

  useEffect(() => {
    AsyncStorage.getItem('nexus_tutorial_seen').then(val => {
      if (!val) setShowTutorial(true);
    });
  }, []);

  return (
    <>
    {showTutorial && <TabTutorial onDismiss={() => setShowTutorial(false)} />}
    <Tabs
      // NEX-204: Home is the deterministic landing tab. Backstop for the
      // post-onboarding nav now that a paywall can sit between onboarding-finish
      // and the Stack mounting — if the imperative pending-route flush is ever
      // lost, the app still lands on Home, not the default `index` (Command).
      initialRouteName="home"
      screenOptions={{
      headerShown: false,
      // NEX-43 v3: sceneStyle: transparent so the tab navigator's scene
      // wrapper doesn't paint a default light background between the
      // transparent tab screens and the void+StarField below them.
      sceneStyle: { backgroundColor: 'transparent' },
      // Designer pass (2026-06): testing a FROSTED tab bar (overrides the
      // prior solid-void decision). Transparent style + BlurView background
      // lets the cosmic field blur through the bar; faint white top hairline
      // gives the bar a defined edge.
      tabBarStyle: { backgroundColor: 'transparent', borderTopWidth: RNStyleSheet.hairlineWidth, borderTopColor: tokens.color.luminousEdgeSoft },
      tabBarBackground: () => (
        <BlurView tint="dark" intensity={75} style={RNStyleSheet.absoluteFill} />
      ),
      tabBarActiveTintColor: tokens.color.gold,
      // v3 stellar: inactive tint #444 → tokens.color.textDisabled.
      tabBarInactiveTintColor: tokens.color.textDisabled,
      // FIXME(nex-56): off-scale fontSize 9 + fontWeight '900' — design review
      // FIXME(nex-56): off-scale spacing paddingBottom 5 — review
      tabBarLabelStyle: { fontSize: 9, fontWeight: '900', letterSpacing: 1, paddingBottom: 5 }
    }}>
      <Tabs.Screen name="home" options={{ title: 'HOME', tabBarIcon: ({ color }) => <Ionicons name="home" size={20} color={color} /> }} />
      <Tabs.Screen name="index" options={{ title: 'COMMAND', tabBarIcon: ({ color }) => <Ionicons name="mic" size={20} color={color} /> }} />
      <Tabs.Screen name="orbit" options={{ title: 'ORBIT', tabBarIcon: ({ color }) => <Ionicons name="grid" size={20} color={color} /> }} />
      <Tabs.Screen name="inbox" options={{ title: 'INBOX', tabBarIcon: ({ color }) => <Ionicons name="list" size={20} color={color} /> }} />
      <Tabs.Screen name="align" options={{ title: 'ALIGN', tabBarIcon: ({ color }) => <Ionicons name="triangle" size={20} color={color} /> }} />
      
      {/* Explicitly nullify anything else */}
      <Tabs.Screen name="talk" options={{ href: null }} />
      <Tabs.Screen name="modal" options={{ href: null }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
    </>
  );
}
