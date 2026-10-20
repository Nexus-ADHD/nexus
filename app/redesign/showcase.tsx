import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlignmentScoreRing } from '@/src/components/ui/AlignmentScoreRing';
import { PaywallContentPreview } from '@/src/features/paywall/paywall-content-preview';
import { REPRESENTATIVE_DAY_SCORES, REPRESENTATIVE_SCORE } from '@/src/features/paywall/paywall-preview-data';
import { Card }               from '@/src/components/ui/Card';
import { HabitRow }           from '@/src/components/ui/HabitRow';
import { IconButton }         from '@/src/components/ui/IconButton';
import { PrimaryPill }        from '@/src/components/ui/PrimaryPill';
import { SecondaryButton }    from '@/src/components/ui/SecondaryButton';
import { Sheet }              from '@/src/components/ui/Sheet';
import ReflectionFlow         from '@/src/features/onboarding/reflection-flow';
import PreparingInterstitial  from '@/src/features/onboarding/preparing-interstitial';
import ReviewScreen           from '@/src/features/onboarding/review-screen';
import { StarField }          from '@/src/components/ui/StarField';
import { VoiceOrb }           from '../../components/VoiceOrb';
import type { ReflectionInput } from '@/src/services/pulse-recommendations';
import type {
  OnboardingRecommendations,
  OnboardingRecommendedHabit,
  OnboardingRecommendedMandate,
  OnboardingRecommendedTodo,
} from '@/src/state/app-state';
import tokens                 from '@/src/theme/tokens';

// ─── Placeholder icon node used across IconButton demos ──────────────────────
const XIcon = <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 18, color: tokens.color.text }}>×</Text>;

// ─── Color swatch row ─────────────────────────────────────────────────────────
function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.swatchRow}>
      <View style={[styles.swatchBox, { backgroundColor: color }]} />
      <Text style={styles.swatchLabel}>{label}</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function ShowcaseScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Controlled state so HabitRow completion demos work live
  const [h1Done, setH1Done] = useState(false);
  const [h2Done, setH2Done] = useState(false);
  const [h4Done, setH4Done] = useState(false);

  // NEX-26 phase B — dev entry point for the reflection flow.
  const [reflectionOpen, setReflectionOpen] = useState(false);
  const handleReflectionComplete = (reflection: ReflectionInput) => {
    // eslint-disable-next-line no-console
    console.log('[reflection-flow] onComplete payload:', reflection);
    const body = [
      'Best version of you:',
      reflection.bestVersion || '(skipped)',
      '',
      'What to stop:',
      reflection.stop || '(skipped)',
      '',
      'What to continue:',
      reflection.continue || '(skipped)',
      '',
      'What to focus on:',
      reflection.focus || '(skipped)',
    ].join('\n');
    Alert.alert('Reflection complete', body);
    setReflectionOpen(false);
  };

  // NEX-26 phase C — dev entry point for the preparing interstitial.
  // Modal auto-dismisses after 3 seconds so the visual register is
  // verifiable without manually killing the surface.
  const [interstitialOpen, setInterstitialOpen] = useState(false);
  const [sheetBottomOpen, setSheetBottomOpen] = useState(false);
  const [sheetCenterOpen, setSheetCenterOpen] = useState(false);
  React.useEffect(() => {
    if (!interstitialOpen) return;
    const t = setTimeout(() => setInterstitialOpen(false), 3000);
    return () => clearTimeout(t);
  }, [interstitialOpen]);

  // NEX-26 phase D — dev entry point for the review screen.
  // Mocks the Pulse layer: simulated delays + variant titles cycle in
  // on each refresh, so the cap-reached UX is exercisable without
  // hitting the real proxy.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mockRecs, setMockRecs] = useState<OnboardingRecommendations | null>(null);
  const [orbTaps, setOrbTaps] = useState(0);
  const [orbState, setOrbState] = useState<'idle' | 'listening'>('idle');
  // Reset the mock dataset every time the modal opens so a fresh
  // walkthrough always starts from refreshCount=0 across all slots.
  React.useEffect(() => {
    if (reviewOpen) {
      setMockRecs(buildMockReviewDataset());
    }
  }, [reviewOpen]);

  const handleReviewAccept = (final: OnboardingRecommendations) => {
    // eslint-disable-next-line no-console
    console.log('[review-screen] onAccept final payload:', final);
    const mandateLines = final.mandates
      .map((m, i) => {
        const habit = final.habits.find((h) => h.mandateId === m.id);
        const todos = final.todos.filter((t) => t.mandateId === m.id);
        return [
          `${i + 1}. ${m.title}  (refresh ${m.refreshCount}/8)`,
          habit ? `   habit: ${habit.title}  (refresh ${habit.refreshCount}/8)` : '',
          ...todos.map((t) => `   todo: ${t.title}  (refresh ${t.refreshCount}/8)`),
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
    Alert.alert('Review accepted', mandateLines || '(empty)');
    setReviewOpen(false);
  };

  // Simulated Pulse delays. Real wiring lives in phase E.
  const simulateDelay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // NEX-57: showcase mock for the pool-with-tap review screen.
  // Toggle handlers flip `added` on mock state; regenerate preserves
  // ADDed items for the mandate and appends a fresh fake pool.

  const handleToggleHabit = (slotId: string) => {
    setMockRecs((prev) => {
      if (!prev) return prev;
      const idx = prev.habits.findIndex((h) => h.slotId === slotId);
      if (idx === -1) return prev;
      const next = [...prev.habits];
      next[idx] = { ...next[idx], added: !next[idx].added };
      return { ...prev, habits: next };
    });
  };

  const handleToggleRecurring = (slotId: string) => {
    setMockRecs((prev) => {
      if (!prev) return prev;
      const idx = prev.recurringTodos.findIndex((rt) => rt.slotId === slotId);
      if (idx === -1) return prev;
      const next = [...prev.recurringTodos];
      next[idx] = { ...next[idx], added: !next[idx].added };
      return { ...prev, recurringTodos: next };
    });
  };

  const handleToggleTodo = (slotId: string) => {
    setMockRecs((prev) => {
      if (!prev) return prev;
      const idx = prev.todos.findIndex((t) => t.slotId === slotId);
      if (idx === -1) return prev;
      const next = [...prev.todos];
      next[idx] = { ...next[idx], added: !next[idx].added };
      return { ...prev, todos: next };
    });
  };

  const handleRegenerateMandate = async (mandateId: string) => {
    await simulateDelay(800);
    setMockRecs((prev) => {
      if (!prev) return prev;
      // Preserve ADDed items + items from other mandates. Drop un-ADDed.
      const keptHabits = prev.habits.filter((h) => h.mandateId !== mandateId || h.added);
      const keptRecurring = prev.recurringTodos.filter(
        (rt) => rt.mandateId !== mandateId || rt.added,
      );
      const keptTodos = prev.todos.filter((t) => t.mandateId !== mandateId || t.added);
      const now = Date.now();
      return {
        ...prev,
        habits: [
          ...keptHabits,
          {
            slotId: `h-cascade-${now}-1`,
            title: 'Fresh habit, first option',
            daysOfWeek: [1, 2, 3, 4, 5],
            mandateId,
            rationale: 'Operationalizes the mandate one weekday at a time, quietly.',
            added: false,
            refreshCount: 0,
          },
          {
            slotId: `h-cascade-${now}-2`,
            title: 'Fresh habit, second option',
            daysOfWeek: [0, 6],
            mandateId,
            rationale: 'A weekend angle on the same mandate, when the week eases up.',
            added: false,
            refreshCount: 0,
          },
        ],
        recurringTodos: [
          ...keptRecurring,
          {
            slotId: `rt-cascade-${now}`,
            title: 'Fresh recurring intention',
            daysOfWeek: [1, 3, 5],
            mandateId,
            rationale: 'A recurring intention without streak pressure but with cadence.',
            added: false,
            refreshCount: 0,
          },
        ],
        todos: [
          ...keptTodos,
          {
            slotId: `t-cascade-${now}`,
            title: 'Fresh one-time action this week',
            mandateId,
            rationale: 'A concrete one-time move the new mandate framing is asking for.',
            added: false,
            refreshCount: 0,
          },
        ],
      };
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.color.void }}>
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={{ position: 'absolute', top: insets.top + 12, left: 16, zIndex: 10, paddingHorizontal: 12, paddingVertical: 8 }}
      >
        <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ color: tokens.color.gold, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 }}>← BACK</Text>
      </Pressable>
      <ScrollView
        style={[styles.root, { backgroundColor: tokens.color.void }]}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 48, paddingBottom: 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >

      {/* ─── DEV ENTRY: Button Lab (button ↔ background marriage) ────────── */}
      <Text style={styles.sectionHeader}>Button lab: pick a treatment</Text>
      <View style={styles.sectionBody}>
        <Pressable
          onPress={() => router.push('/redesign/button-lab')}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderWidth: 1,
            borderColor: tokens.color.gold,
            borderRadius: 14,
            alignSelf: 'flex-start',
          }}
        >
          <Text
            style={{
              fontFamily: tokens.font.interMedium,
              color: tokens.color.gold,
              // FIXME(nex-56): inline fontSize literal — design review
              fontSize: 13,
              letterSpacing: 0.14 * 13,
              textTransform: 'uppercase',
            }}
          >
            → BUTTON LAB (A/B/C/C-TEAL/D)
          </Text>
        </Pressable>
      </View>

      {/* ─── DEV ENTRY: Reflection Flow (NEX-26 phase B) ─────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>NEX-26 reflection flow</Text>
      <View style={styles.sectionBody}>
        <Pressable
          onPress={() => setReflectionOpen(true)}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderWidth: 1,
            borderColor: tokens.color.gold,
            borderRadius: 14,
            alignSelf: 'flex-start',
          }}
        >
          <Text
            style={{
              fontFamily: tokens.font.interMedium,
              color: tokens.color.gold,
              // FIXME(nex-56): inline fontSize literal — design review
              fontSize: 13,
              letterSpacing: 0.14 * 13,
              textTransform: 'uppercase',
            }}
          >
            → REFLECTION FLOW
          </Text>
        </Pressable>
      </View>

      {/* ─── DEV ENTRY: Preparing Interstitial (NEX-26 phase C) ──────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>NEX-26 preparing interstitial</Text>
      <View style={styles.sectionBody}>
        <Pressable
          onPress={() => setInterstitialOpen(true)}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderWidth: 1,
            borderColor: tokens.color.gold,
            borderRadius: 14,
            alignSelf: 'flex-start',
          }}
        >
          <Text
            style={{
              fontFamily: tokens.font.interMedium,
              color: tokens.color.gold,
              // FIXME(nex-56): inline fontSize literal — design review
              fontSize: 13,
              letterSpacing: 0.14 * 13,
              textTransform: 'uppercase',
            }}
          >
            → INTERSTITIAL
          </Text>
        </Pressable>
      </View>

      {/* ─── DEV ENTRY: Review Screen (NEX-26 phase D) ───────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>NEX-26 review screen</Text>
      <View style={styles.sectionBody}>
        <Pressable
          onPress={() => setReviewOpen(true)}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderWidth: 1,
            borderColor: tokens.color.gold,
            borderRadius: 14,
            alignSelf: 'flex-start',
          }}
        >
          <Text
            style={{
              fontFamily: tokens.font.interMedium,
              color: tokens.color.gold,
              // FIXME(nex-56): inline fontSize literal — design review
              fontSize: 13,
              letterSpacing: 0.14 * 13,
              textTransform: 'uppercase',
            }}
          >
            → REVIEW SCREEN
          </Text>
        </Pressable>
      </View>

      {/* ─── DEV ENTRY: VoiceOrb (expo-video transparent) ────────────────── */}
      {/* NEX-?: contrasting teal background so alpha leakage is obvious —
          any non-transparent edge around the orb reads loud against
          tokens.color.teal. */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>VoiceOrb</Text>
      <View style={styles.sectionBody}>
        <View
          style={{
            backgroundColor: tokens.color.teal,
            padding: 16,
            borderRadius: 16,
            alignItems: 'center',
          }}
        >
          <VoiceOrb
            width={300}
            state={orbState}
            onPress={() => {
              setOrbTaps((n) => n + 1);
              setOrbState((s) => (s === 'idle' ? 'listening' : 'idle'));
            }}
          />
        </View>
        <Text style={styles.sectionHeader}>{`Orb taps: ${orbTaps} — state: ${orbState}`}</Text>
      </View>

      {/* ─── SECTION 0: AlignmentScoreRing ───────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>AlignmentScoreRing</Text>
      <View style={[styles.sectionBody, styles.ringStack]}>
        <View style={styles.ringRow}>
          <AlignmentScoreRing score={76} size={180} />
        </View>

        <View style={styles.ringRow}>
          <AlignmentScoreRing score={92} size={180} />
        </View>

        <View style={styles.ringRow}>
          <AlignmentScoreRing score={52} size={180} />
        </View>

        <View style={styles.ringRow}>
          <AlignmentScoreRing score={100} size={180} milestone />
        </View>

        <View style={styles.ringRow}>
          <AlignmentScoreRing
            score={76}
            size={180}
            onPress={() => Alert.alert('ring pressed')}
          />
        </View>
      </View>

      {/* ─── NEX-121: PaywallContentPreview ──────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>NEX-121 paywall as content</Text>
      <View style={styles.sectionBody}>
        {/* Representative (new-user) shape — clearly framed as "what's ahead". */}
        <PaywallContentPreview
          statsOverride={{
            dayScores: REPRESENTATIVE_DAY_SCORES.map((s, i) => ({ key: `rep-${i}`, score: s })),
            score: REPRESENTATIVE_SCORE,
            isRepresentative: true,
          }}
        />
        <View style={{ height: 16 }} />
        {/* Real-data shape (forced) — "your insight, in focus". */}
        <PaywallContentPreview
          statsOverride={{
            dayScores: [
              { key: 'r0', score: 64 }, { key: 'r1', score: 71 }, { key: 'r2', score: null },
              { key: 'r3', score: 58 }, { key: 'r4', score: 83 }, { key: 'r5', score: 90 },
              { key: 'r6', score: 77 },
            ],
            score: 77,
            isRepresentative: false,
          }}
        />
      </View>

      {/* ─── SECTION 1: Card ─────────────────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>Card</Text>
      <View style={styles.sectionBody}>
        <Card>
          <Text style={styles.demoText}>Default card content</Text>
        </Card>

        <View style={styles.gap} />
        <Card variant="elevated">
          <Text style={styles.demoText}>Elevated card content</Text>
        </Card>

        <View style={styles.gap} />
        <Card onPress={() => console.log('pressed')}>
          <Text style={styles.demoText}>Pressable card — tap me</Text>
        </Card>

        <View style={styles.gap} />
        <Card accentBar="gold">
          <Text style={styles.demoText}>Gold accent</Text>
        </Card>

        <View style={styles.gap} />
        <Card accentBar="teal">
          <Text style={styles.demoText}>Teal accent</Text>
        </Card>

        <View style={styles.gap} />
        <Card accentBar="amber">
          <Text style={styles.demoText}>Amber accent</Text>
        </Card>

        {/* NEX-158 — opt-in corner glows on primary cards */}
        <View style={styles.gap} />
        <Card cornerGlow>
          <Text style={styles.demoText}>Corner glow (luminous accents)</Text>
        </Card>

        <View style={styles.gap} />
        <Card cornerGlow accentBar="gold">
          <Text style={styles.demoText}>Corner glow + gold accent (left suppressed)</Text>
        </Card>

        <View style={styles.gap} />
        <Card cornerGlow onPress={() => console.log('pressed')}>
          <Text style={styles.demoText}>Corner glow + pressable (tap for border lift)</Text>
        </Card>
      </View>

      {/* ─── SECTION 2: HabitRow ─────────────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>HabitRow</Text>
      <View style={styles.sectionBody}>
        <Card>
          <HabitRow
            title="Meditation"
            meta="DAILY"
            streak={18}
            completed={h1Done}
            onComplete={() => setH1Done(true)}
          />
          <HabitRow
            title="Clean eating"
            meta="DAILY · 2X/DAY"
            emoji="🥗"
            streak={12}
            completed={h2Done}
            onComplete={() => setH2Done(true)}
          />
          <HabitRow
            title="Workout"
            emoji="🏋️"
            streak={0}
            completed={true}
            onComplete={() => {}}
          />
          <HabitRow
            title="Hair Medicine"
            meta="DAILY · 2X/DAY"
            streak={13}
            completed={h4Done}
            showBottomDivider={false}
            onComplete={() => setH4Done(true)}
          />
        </Card>
      </View>

      {/* ─── SECTION 3: PrimaryPill ──────────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>PrimaryPill</Text>
      <View style={styles.sectionBody}>
        <PrimaryPill variant="cream" onPress={() => Alert.alert('cream')}>
          Tap to talk
        </PrimaryPill>

        <View style={styles.gap} />
        <PrimaryPill variant="gold" onPress={() => Alert.alert('gold')}>
          Begin
        </PrimaryPill>

        <View style={styles.gap} />
        <PrimaryPill variant="cream" disabled onPress={() => {}}>
          Disabled
        </PrimaryPill>

        <View style={styles.gap} />
        <PrimaryPill variant="cream" loading onPress={() => {}}>
          Loading
        </PrimaryPill>
      </View>

      {/* ─── SECTION 4: SecondaryButton ──────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>SecondaryButton</Text>
      <View style={styles.sectionBody}>
        <SecondaryButton variant="outline" onPress={() => Alert.alert('outline')}>
          Edit
        </SecondaryButton>

        <View style={styles.gap} />
        <SecondaryButton variant="gold-outline" onPress={() => Alert.alert('gold')}>
          + Add Item
        </SecondaryButton>

        <View style={styles.gap} />
        <SecondaryButton variant="outline" compact onPress={() => Alert.alert('compact')}>
          Cancel
        </SecondaryButton>

        <View style={styles.gap} />
        <SecondaryButton variant="outline" disabled onPress={() => {}}>
          Disabled
        </SecondaryButton>
      </View>

      {/* ─── SECTION 5: IconButton ───────────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>IconButton</Text>
      <View style={[styles.sectionBody, styles.iconRow]}>
        <IconButton
          icon={XIcon}
          size="sm"
          onPress={() => {}}
          accessibilityLabel="close small"
        />
        <IconButton
          icon={XIcon}
          size="md"
          onPress={() => {}}
          accessibilityLabel="close medium"
        />
        <IconButton
          icon={XIcon}
          size="lg"
          onPress={() => {}}
          accessibilityLabel="close large"
        />
        <IconButton
          icon={XIcon}
          size="md"
          variant="ghost"
          onPress={() => {}}
          accessibilityLabel="close ghost"
        />
        <IconButton
          icon={XIcon}
          size="md"
          disabled
          onPress={() => {}}
          accessibilityLabel="close disabled"
        />
      </View>

      {/* ─── SECTION 6: Color swatches ───────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>Color tokens</Text>
      <View style={styles.sectionBody}>
        <Swatch color={tokens.color.void}    label="color.void" />
        <View style={styles.gap} />
        <Swatch color={tokens.color.surface} label="color.surface" />
        <View style={styles.gap} />
        <Swatch color={tokens.color.gold}    label="color.gold" />
        <View style={styles.gap} />
        <Swatch color={tokens.color.teal}    label="color.teal" />
        <View style={styles.gap} />
        <Swatch color={tokens.color.amber}   label="color.amber" />
        <View style={styles.gap} />
        <Swatch color={tokens.color.text}    label="color.text" />
      </View>

      {/* ─── SECTION 7: Sheet ────────────────────────────────────────────── */}
      <View style={styles.sectionDivider} />
      <Text style={styles.sectionHeader}>Sheet</Text>
      <View style={styles.sectionBody}>
        <SecondaryButton onPress={() => setSheetBottomOpen(true)}>
          Bottom sheet
        </SecondaryButton>
        <View style={styles.gap} />
        <SecondaryButton onPress={() => setSheetCenterOpen(true)}>
          Centred dialog (backdrop does not dismiss)
        </SecondaryButton>
      </View>

      </ScrollView>

      {/* Sheet — the transparent-overlay primitive. Both variants live here so
          the scrim, handle, focus trap and keyboard behaviour can be exercised
          without hunting for a screen that happens to open one. */}
      <Sheet
        visible={sheetBottomOpen}
        onDismiss={() => setSheetBottomOpen(false)}
        accessibilityLabel="Bottom sheet demo"
      >
        <Text style={styles.demoText}>
          Bottom variant. Tap the scrim to dismiss, or press the Android back button.
        </Text>
        <View style={styles.gap} />
        <SecondaryButton onPress={() => setSheetBottomOpen(false)}>Close</SecondaryButton>
      </Sheet>

      <Sheet
        visible={sheetCenterOpen}
        variant="center"
        dismissOnBackdropPress={false}
        onDismiss={() => setSheetCenterOpen(false)}
        accessibilityLabel="Centred dialog demo"
      >
        <Text style={styles.demoText}>
          Centred variant with the backdrop tap disabled, the shape a consent dialog needs.
          Only the button below closes it.
        </Text>
        <View style={styles.gap} />
        <SecondaryButton onPress={() => setSheetCenterOpen(false)}>Close</SecondaryButton>
      </Sheet>

      {/* NEX-26 phase B — full-screen modal for the reflection flow. */}
      <Modal
        visible={reflectionOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setReflectionOpen(false)}
      >
        {/* Native fullScreen Modals render above the global StarField
            (app/_layout.tsx), so each modal mounts its own cosmic
            backdrop for the transparent flow screens to sit on. */}
        <View style={{ flex: 1, backgroundColor: tokens.color.void }}>
          <StarField />
          <View style={StyleSheet.absoluteFill}>
            <ReflectionFlow
              onComplete={handleReflectionComplete}
              onCancel={() => setReflectionOpen(false)}
            />
          </View>
        </View>
      </Modal>

      {/* NEX-26 phase C — full-screen modal for the preparing
          interstitial. Auto-dismisses after 3s via the useEffect above
          so the visual register is verifiable without manual close. */}
      <Modal
        visible={interstitialOpen}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => setInterstitialOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: tokens.color.void }}>
          <StarField />
          <View style={StyleSheet.absoluteFill}>
            <PreparingInterstitial
              onMinimumElapsed={() => {
                // eslint-disable-next-line no-console
                console.log('[preparing-interstitial] onMinimumElapsed fired at 1500ms');
              }}
            />
          </View>
        </View>
      </Modal>

      {/* NEX-26 phase D — full-screen modal for the review screen.
          Mock state lives in this parent; refresh callbacks simulate
          ~600-800ms Pulse delays and cycle variant titles. */}
      <Modal
        visible={reviewOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setReviewOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: tokens.color.void }}>
          <StarField />
          <View style={StyleSheet.absoluteFill}>
            {mockRecs && (
              <ReviewScreen
                recommendations={mockRecs}
                onAccept={handleReviewAccept}
                onToggleAddedHabit={handleToggleHabit}
                onToggleAddedRecurringTodo={handleToggleRecurring}
                onToggleAddedTodo={handleToggleTodo}
                onRegenerateMandate={handleRegenerateMandate}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── NEX-26 phase D — mock review-screen dataset + per-slot variants ────────
//
// Variants are keyed PER SLOT (mandate id, habit slotId, todo slotId)
// so refresh stays mandate-coherent. Production refresh in phase E
// will pass the parent mandate to Pulse so this scoping happens
// service-side; the mock just simulates the same constraint here.

const MANDATE_VARIANTS_BY_ID: Record<string, string[]> = {
  'm-mock0001': [
    'Be present with my family',
    'Show up for my family',
    'Be the parent my kids remember',
    'Hold space for the people at home',
  ],
  'm-mock0002': [
    'Master the writing craft',
    'Build the writing practice daily',
    'Take the craft seriously',
    'Earn your writing voice',
  ],
  'm-mock0003': [
    'Take care of my body',
    'Honor my body daily',
    'Stay strong and well',
    'Treat my body with respect',
  ],
  'm-mock0004': [
    'Lead my team with care',
    'Show up for my team',
    'Be the leader my team deserves',
    'Lead with deliberate intention',
  ],
};

type VariantPair = { title: string; rationale: string };

const HABIT_VARIANTS_BY_SLOT: Record<string, VariantPair[]> = {
  // Mandate 1 — Be present with my family
  'h-1': [
    { title: 'Phone-free dinners',         rationale: 'Removes the device that quietly pulls attention from the room each evening.' },
    { title: 'Saturday family ritual',     rationale: 'Reserves one weekly anchor for the people you most want to see clearly.' },
    { title: 'Evening device-down hour',   rationale: 'Carves an hour from the feed and gives it back to the room around you.' },
  ],
  // Mandate 2 — Master the writing craft
  'h-2': [
    { title: 'Daily writing, 30 min',      rationale: 'One weekday session at a time, building before context fragments through the day.' },
    { title: 'Morning pages',              rationale: 'Empties the mind onto the page before email and noise crowd the morning.' },
    { title: 'Weekly editing pass',        rationale: "One pass over the week's work, the part most writers skip and regret." },
  ],
  // Mandate 3 — Take care of my body
  'h-3': [
    { title: 'Zone-2 cardio, 40 min',      rationale: "Three weekday sessions a week without burning recovery or stealing tomorrow's energy." },
    { title: 'Morning walk, 20 min',       rationale: 'A daily move that costs nothing, resets attention, and warms the body up.' },
    { title: 'Strength training, 30 min',  rationale: 'Builds the resilience that aging without practice quietly takes away each year.' },
  ],
  // Mandate 4 — Lead my team with care
  'h-4': [
    { title: 'Daily 1:1 check-in',         rationale: 'One short conversation at a time, before issues compound into friction across the team.' },
    { title: 'Weekly team review',         rationale: 'Names what is happening on the team so you stop being surprised on Mondays.' },
    { title: 'Office hours block',         rationale: 'Reserved time the team can use, which removes guessing about when to bring things up.' },
  ],
};

const TODO_VARIANTS_BY_SLOT: Record<string, VariantPair[]> = {
  // Mandate 1 — first to-do
  't-1a': [
    { title: 'Plan one weekend activity with the kids',  rationale: 'Turns presence into a deliberate choice on the calendar rather than a quiet wish.' },
    { title: 'Schedule one-on-one time with each kid',   rationale: 'Names each child by name on the calendar so attention does not collapse into a blur.' },
    { title: 'Plan a phone-free Saturday this month',    rationale: 'Sets one experimental day to feel what attention without the device actually returns to you.' },
  ],
  // Mandate 1 — second to-do
  't-1b': [
    { title: 'Call your parents Sunday evening',         rationale: 'Closes a recurring family loop you have been carrying silently for weeks now.' },
    { title: 'Write a thank-you note to your spouse',    rationale: 'Names what is working at home before the loud problems crowd out the quiet ones.' },
    { title: 'Set up a family dinner this Friday',       rationale: 'Reserves a place at the table before the week fills the time with other things.' },
  ],
  // Mandate 2 — single to-do
  't-2': [
    { title: 'Outline the next chapter of your novel',   rationale: 'Turns the writing into a concrete artifact you can actually finish this week.' },
    { title: 'Submit one essay to a publication',        rationale: 'Names an external deadline so the practice has something pulling it forward into the world.' },
    { title: 'Read one chapter of a craft book',         rationale: 'Returns input to a practice that easily becomes too internal too quickly.' },
  ],
  // Mandate 3 — first to-do
  't-3a': [
    { title: 'Book your overdue physical this week',     rationale: 'Closes a long-pending body item you have been quietly carrying for months.' },
    { title: 'Schedule a dental cleaning this month',    rationale: 'Names a small body item on the calendar before it grows into a bigger one.' },
    { title: 'Order the blood panel you keep postponing', rationale: 'Replaces guessing about your numbers with the actual data the body has been signaling.' },
  ],
  // Mandate 3 — second to-do
  't-3b': [
    { title: 'Schedule three workouts on the calendar',  rationale: 'Reserves the time before the week fills with meetings and other obligations.' },
    { title: 'Plan one full rest day this week',         rationale: 'Names recovery as a deliberate practice rather than a thing that happens to you.' },
    { title: 'Prep your gym bag the night before',       rationale: 'Removes the small morning decision that quietly kills the workout half the time.' },
  ],
  // Mandate 4 — single to-do
  't-4': [
    { title: 'Send a check-in note to each report',      rationale: 'Names what is actually happening so you stop being surprised on Mondays.' },
    { title: 'Schedule one mentoring conversation this week', rationale: 'Reserves time for the slow work that compounds across quarters, not just sprints.' },
    { title: 'Block time to write team feedback',        rationale: 'Names the work that easily gets crowded out by the work that interrupts.' },
  ],
};

/** Cycle a string within a fixed pool. Falls back to the first entry on no match. */
function nextTitleInPool(current: string, pool: readonly string[]): string {
  const idx = pool.indexOf(current);
  if (idx < 0) return pool[0];
  return pool[(idx + 1) % pool.length];
}

/** Cycle a (title, rationale) variant within a fixed pool, keyed by current title. */
function nextVariantInPool(currentTitle: string, pool: readonly VariantPair[]): VariantPair {
  const idx = pool.findIndex((v) => v.title === currentTitle);
  if (idx < 0) return pool[0];
  return pool[(idx + 1) % pool.length];
}

function buildMockReviewDataset(): OnboardingRecommendations {
  const m1 = 'm-mock0001';
  const m2 = 'm-mock0002';
  const m3 = 'm-mock0003';
  const m4 = 'm-mock0004';
  // Initial titles match each pool's index 0 so nextTitleInPool cycles
  // predictably from refresh #1 onward.
  const mandates: OnboardingRecommendedMandate[] = [
    {
      id: m1, slotId: m1,
      title: 'Be present with my family',
      category: 'PERSONAL',
      rationaleSource: 'bestVersion',
      rationale: 'Names the family commitment you led with when you described who you want to become.',
      refreshCount: 0,
    },
    {
      id: m2, slotId: m2,
      title: 'Master the writing craft',
      category: 'BUSINESS',
      rationaleSource: 'continue',
      rationale: 'Names the writing thread that ran through your reflection on what you want to continue.',
      refreshCount: 0,
    },
    {
      id: m3, slotId: m3,
      title: 'Take care of my body',
      category: 'PERSONAL',
      rationaleSource: 'focus',
      rationale: 'Names the body item you flagged when you talked about what to focus on next.',
      refreshCount: 0,
    },
    {
      id: m4, slotId: m4,
      title: 'Lead my team with care',
      category: 'BUSINESS',
      rationaleSource: 'bestVersion',
      rationale: 'Names the leadership thread you returned to when describing the version of you that matters.',
      refreshCount: 0,
    },
  ];
  // NEX-57: 2 habits per mandate to match the pool-with-tap pattern.
  // Variant pool maps below are vestigial (refresh cycling is gone)
  // but we reuse their index-0 and index-1 entries here as the two
  // distinct habit options per mandate.
  const habits: OnboardingRecommendedHabit[] = [
    // M1
    { slotId: 'h-1a', mandateId: m1, daysOfWeek: [0,1,2,3,4,5,6], ...HABIT_VARIANTS_BY_SLOT['h-1'][0], added: false, refreshCount: 0 },
    { slotId: 'h-1b', mandateId: m1, daysOfWeek: [6],             ...HABIT_VARIANTS_BY_SLOT['h-1'][1], added: false, refreshCount: 0 },
    // M2
    { slotId: 'h-2a', mandateId: m2, daysOfWeek: [1,2,3,4,5],     ...HABIT_VARIANTS_BY_SLOT['h-2'][0], added: false, refreshCount: 0 },
    { slotId: 'h-2b', mandateId: m2, daysOfWeek: [0,1,2,3,4,5,6], ...HABIT_VARIANTS_BY_SLOT['h-2'][1], added: false, refreshCount: 0 },
    // M3
    { slotId: 'h-3a', mandateId: m3, daysOfWeek: [1,3,5],         ...HABIT_VARIANTS_BY_SLOT['h-3'][0], added: false, refreshCount: 0 },
    { slotId: 'h-3b', mandateId: m3, daysOfWeek: [0,2,4,6],       ...HABIT_VARIANTS_BY_SLOT['h-3'][1], added: false, refreshCount: 0 },
    // M4
    { slotId: 'h-4a', mandateId: m4, daysOfWeek: [1,2,3,4,5],     ...HABIT_VARIANTS_BY_SLOT['h-4'][0], added: false, refreshCount: 0 },
    { slotId: 'h-4b', mandateId: m4, daysOfWeek: [5],             ...HABIT_VARIANTS_BY_SLOT['h-4'][1], added: false, refreshCount: 0 },
  ];
  const todos: OnboardingRecommendedTodo[] = [
    // Mandate 1: 2 todos
    { slotId: 't-1a', mandateId: m1, ...TODO_VARIANTS_BY_SLOT['t-1a'][0], added: false, refreshCount: 0 },
    { slotId: 't-1b', mandateId: m1, ...TODO_VARIANTS_BY_SLOT['t-1b'][0], added: false, refreshCount: 0 },
    // Mandate 2: 1 todo
    { slotId: 't-2',  mandateId: m2, ...TODO_VARIANTS_BY_SLOT['t-2'][0],  added: false, refreshCount: 0 },
    // Mandate 3: 2 todos
    { slotId: 't-3a', mandateId: m3, ...TODO_VARIANTS_BY_SLOT['t-3a'][0], added: false, refreshCount: 0 },
    { slotId: 't-3b', mandateId: m3, ...TODO_VARIANTS_BY_SLOT['t-3b'][0], added: false, refreshCount: 0 },
    // Mandate 4: 1 todo
    { slotId: 't-4',  mandateId: m4, ...TODO_VARIANTS_BY_SLOT['t-4'][0],  added: false, refreshCount: 0 },
  ];
  return {
    generatedAt: Date.now(),
    mandates,
    habits,
    recurringTodos: [],
    todos,
    disambiguation: null,
  };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },

  content: {
    paddingHorizontal: tokens.spacing.lg, // 24pt
  },

  sectionHeader: {
    fontFamily: tokens.font.interSemiBold,
    // FIXME(nex-56): inline fontSize literal — design review
    fontSize:   15,
    color:      tokens.color.text,
  },

  sectionBody: {
    marginTop: 16,
  },

  sectionDivider: {
    height: 48,
  },

  gap: {
    height: 12,
  },

  ringStack: {
    gap: 48, // vertical spacing between rings — clears 180pt height + ambient glow
  },

  ringRow: {
    alignItems: 'center',
  },

  demoText: {
    fontFamily: tokens.font.interRegular,
    // FIXME(nex-56): inline fontSize literal — design review
    fontSize:   17,
    color:      tokens.color.text,
  },

  iconRow: {
    flexDirection: 'row',
    alignItems:    'center',
    flexWrap:      'wrap',
    gap:           12,
  },

  swatchRow: {
    flexDirection: 'row',
    alignItems:    'center',
  },

  swatchBox: {
    width:        32,
    height:       32,
    borderRadius: tokens.radii.sm,
    borderWidth:  StyleSheet.hairlineWidth,
    borderColor:  tokens.color.goldHairline,
  },

  swatchLabel: {
    fontFamily: tokens.font.interRegular,
    // FIXME(nex-56): inline fontSize literal — design review
    fontSize:   13,
    color:      tokens.color.text,
    marginLeft: 12,
  },
});
