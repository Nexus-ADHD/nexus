import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { AdaptiveScreen } from '../../src/components/ui/AdaptiveScreen';
import { MandateStrengthenSheet, type MandateRef } from '../../src/components/mandate-strengthen-sheet';
import { PrimaryPill } from '../../src/components/ui/PrimaryPill';
import { isNewWeeklyReflection } from '../../src/features/align/weekly-reflection';
import {
  shouldShowVoiceReflection,
  VOICE_REFLECTION_BODY,
  VOICE_REFLECTION_DISMISS,
  VOICE_REFLECTION_FLAG,
  VOICE_REFLECTION_QUESTION,
} from '../../src/features/align/voice-reflection';
import { useAppState } from '../../src/state/app-state';
import { parseWeeklyReflectionFocus } from '../../src/state/selectors/this-week-summary';
import tokens, { spacing } from '../../src/theme/tokens';
import { haptic } from '../../src/utils/haptics';
import { countLinkedHabitsForPillar } from '../../src/utils/mandate-habit-links';
import { pushToMandateDetail } from '../../src/utils/mandate-navigation';

const PLACEHOLDER_COLOR_DARK = tokens.color.textDisabled;
const ALIGN_REFLECTION_SEEN_KEY = 'nexus_align_reflection_seen_date';
const ADD_CATEGORIES = ['BUSINESS', 'VISION', 'PERSONAL'] as const;
const UNDERSUPPORTED_THRESHOLD = 2;

type AddCategory = (typeof ADD_CATEGORIES)[number];

function categoryLabel(category: unknown): string {
  const value = String(category ?? 'BUSINESS').toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function AlignScreen() {
  const {
    pillars,
    addPillarManual,
    userProfile,
    activateUser,
    weeklyReflection,
    weeklyReflectionDate,
    goalHabitMap,
    recurringRules,
  } = useAppState(
    useShallow((state: any) => ({
      pillars: state.pillars,
      addPillarManual: state.addPillarManual,
      userProfile: state.userProfile,
      activateUser: state.activateUser,
      weeklyReflection: state.weeklyReflection,
      weeklyReflectionDate: state.weeklyReflectionDate,
      goalHabitMap: state.goalHabitMap,
      recurringRules: state.recurringRules,
    })),
  );

  const router = useRouter();
  const safePillars: any[] = Array.isArray(pillars) ? pillars : [];
  const [showAddComposer, setShowAddComposer] = useState(false);
  const [addCategory, setAddCategory] = useState<AddCategory>('BUSINESS');
  const [inputText, setInputText] = useState('');
  const [strengthenTarget, setStrengthenTarget] = useState<MandateRef | null>(null);

  const anchor: string = userProfile?.anchor ?? '';
  const [editingAnchor, setEditingAnchor] = useState(false);
  const [anchorDraft, setAnchorDraft] = useState('');
  const [voiceReflectionSeen, setVoiceReflectionSeen] = useState<boolean | null>(null);
  const [reflectionHydrated, setReflectionHydrated] = useState(false);
  const [reflectionExpanded, setReflectionExpanded] = useState(false);
  const reflectionFocus = parseWeeklyReflectionFocus(weeklyReflection);

  useEffect(() => {
    AsyncStorage.getItem(VOICE_REFLECTION_FLAG)
      .then((value) => setVoiceReflectionSeen(value === 'true'))
      .catch(() => setVoiceReflectionSeen(true));
  }, []);

  useEffect(() => {
    let active = true;
    if (!reflectionFocus || !weeklyReflectionDate) {
      setReflectionExpanded(false);
      setReflectionHydrated(true);
      return () => {
        active = false;
      };
    }

    setReflectionHydrated(false);
    AsyncStorage.getItem(ALIGN_REFLECTION_SEEN_KEY)
      .then((lastSeenDate) => {
        if (!active) return;
        const isNew = isNewWeeklyReflection(weeklyReflectionDate, lastSeenDate);
        setReflectionExpanded(isNew);
        setReflectionHydrated(true);
        if (isNew) {
          AsyncStorage.setItem(ALIGN_REFLECTION_SEEN_KEY, weeklyReflectionDate).catch(() => {});
        }
      })
      .catch(() => {
        if (!active) return;
        setReflectionExpanded(false);
        setReflectionHydrated(true);
      });

    return () => {
      active = false;
    };
  }, [reflectionFocus, weeklyReflectionDate]);

  const dismissVoiceReflection = () => {
    setVoiceReflectionSeen(true);
    haptic('buttonSecondary');
    AsyncStorage.setItem(VOICE_REFLECTION_FLAG, 'true').catch(() => {});
  };

  const saveAnchor = () => {
    const nextAnchor = anchorDraft.trim();
    if (!nextAnchor) return;
    activateUser({ ...(userProfile || {}), anchor: nextAnchor });
    setEditingAnchor(false);
    haptic('voiceSuccess');
  };

  const openMandateDetail = (pillar: any) => {
    if (pushToMandateDetail(router, pillar.id)) haptic('tabChange');
  };

  const toggleAddComposer = () => {
    setShowAddComposer((visible) => !visible);
    setInputText('');
    haptic('buttonSecondary');
  };

  const handleAdd = () => {
    const title = inputText.trim();
    if (!title) return;
    const id = addPillarManual(title, '', addCategory);
    setInputText('');
    setShowAddComposer(false);
    setStrengthenTarget({ id, title, category: addCategory });
    haptic('voiceSuccess');
  };

  const renderMandateRow = (pillar: any) => {
    const linkedCount = countLinkedHabitsForPillar(
      String(pillar.id),
      Array.isArray(recurringRules) ? recurringRules : [],
      goalHabitMap,
    );
    const needsStrengthening = !pillar.completed && linkedCount < UNDERSUPPORTED_THRESHOLD;
    const title = String(pillar.title ?? '').trim() || 'Untitled mandate';
    const category = categoryLabel(pillar.category ?? pillar.subtext);

    return (
      <Pressable
        key={pillar.id}
        onPress={() => openMandateDetail(pillar)}
        style={({ pressed }) => [styles.mandateRow, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${category}${needsStrengthening ? ', strengthen' : ''}`}
        accessibilityHint="Opens mandate details"
        testID={`align-mandate-${pillar.id}`}
      >
        <View style={styles.mandateRowCopy}>
          <Text style={styles.mandateTitle}>{title}</Text>
          <View style={styles.mandateMetaRow}>
            <Text style={styles.mandateCategory}>{category}</Text>
            {needsStrengthening && <Text style={styles.strengthenLabel}>Strengthen</Text>}
          </View>
        </View>
        <Text style={styles.rowChevron} accessible={false}>›</Text>
      </Pressable>
    );
  };

  return (
    <>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <AdaptiveScreen>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            testID="align-screen"
          >
            <View style={styles.screenHeader}>
              <Text style={styles.screenTitle} accessibilityRole="header">Align</Text>
              <Text style={styles.screenSubtitle}>Come back to what matters.</Text>
            </View>

            <View style={styles.anchorSection}>
              <View style={styles.sectionTitleRow}>
                <Text style={styles.quietLabel} accessibilityRole="header">Your anchor</Text>
                {!editingAnchor && (
                  <Pressable
                    onPress={() => {
                      setAnchorDraft(anchor);
                      setEditingAnchor(true);
                    }}
                    style={styles.textAction}
                    accessibilityRole="button"
                    accessibilityLabel="Edit anchor"
                  >
                    <Text style={styles.textActionLabel}>Edit</Text>
                  </Pressable>
                )}
              </View>

              {editingAnchor ? (
                <View>
                  <TextInput
                    style={styles.anchorInput}
                    value={anchorDraft}
                    onChangeText={setAnchorDraft}
                    autoFocus
                    multiline
                    placeholder="What grounds you outside of work?"
                    placeholderTextColor={PLACEHOLDER_COLOR_DARK}
                    accessibilityLabel="Your anchor"
                    testID="align-anchor-input"
                  />
                  <View style={styles.anchorActions}>
                    <Pressable
                      onPress={() => setEditingAnchor(false)}
                      style={styles.secondaryAction}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel"
                    >
                      <Text style={styles.secondaryActionLabel}>Cancel</Text>
                    </Pressable>
                    <PrimaryPill size="compact" onPress={saveAnchor} accessibilityLabel="Save anchor">
                      Save
                    </PrimaryPill>
                  </View>
                </View>
              ) : (
                <Text style={styles.anchorText}>{anchor || 'Set the sentence that brings you back.'}</Text>
              )}
            </View>

            {shouldShowVoiceReflection(voiceReflectionSeen) && (
              <View style={styles.voicePrompt}>
                <Text style={styles.voicePromptQuestion}>{VOICE_REFLECTION_QUESTION}</Text>
                <Text style={styles.voicePromptBody}>{VOICE_REFLECTION_BODY}</Text>
                <Pressable
                  onPress={dismissVoiceReflection}
                  style={styles.voicePromptDismiss}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss the reflection"
                >
                  <Text style={styles.textActionLabel}>{VOICE_REFLECTION_DISMISS}</Text>
                </Pressable>
              </View>
            )}

            {reflectionHydrated && reflectionFocus.length > 0 && (
              <View style={styles.reflectionSection}>
                <Pressable
                  onPress={() => {
                    setReflectionExpanded((expanded) => !expanded);
                    haptic('buttonSecondary');
                  }}
                  style={styles.reflectionDisclosure}
                  accessibilityRole="button"
                  accessibilityLabel="This week's reflection"
                  accessibilityState={{ expanded: reflectionExpanded }}
                  testID="align-reflection-disclosure"
                >
                  <Text style={styles.reflectionLabel}>This week’s reflection</Text>
                  <Text style={styles.disclosureChevron} accessible={false}>
                    {reflectionExpanded ? '⌃' : '⌄'}
                  </Text>
                </Pressable>
                {reflectionExpanded && <Text style={styles.reflectionText}>{reflectionFocus}</Text>}
              </View>
            )}

            <View style={styles.mandatesSection}>
              <View style={styles.mandatesTitleRow}>
                <Text style={styles.mandatesTitle} accessibilityRole="header">Mandates</Text>
                <Pressable
                  onPress={toggleAddComposer}
                  style={styles.addAction}
                  accessibilityRole="button"
                  accessibilityLabel={showAddComposer ? 'Cancel adding mandate' : 'Add mandate'}
                  accessibilityState={{ expanded: showAddComposer }}
                  testID="align-add"
                >
                  <Text style={styles.addActionLabel}>{showAddComposer ? 'Cancel' : '+ Add'}</Text>
                </Pressable>
              </View>

              {showAddComposer && (
                <View style={styles.addComposer}>
                  <View style={styles.addCategoryRow} accessibilityRole="tablist">
                    {ADD_CATEGORIES.map((category) => (
                      <Pressable
                        key={category}
                        onPress={() => setAddCategory(category)}
                        style={[
                          styles.addCategoryAction,
                          addCategory === category && styles.addCategoryActionActive,
                        ]}
                        accessibilityRole="tab"
                        accessibilityLabel={`Add to ${categoryLabel(category)}`}
                        accessibilityState={{ selected: addCategory === category }}
                      >
                        <Text style={[
                          styles.addCategoryLabel,
                          addCategory === category && styles.addCategoryLabelActive,
                        ]}>
                          {categoryLabel(category)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <TextInput
                    style={styles.addInput}
                    placeholder="Write a mandate…"
                    placeholderTextColor={PLACEHOLDER_COLOR_DARK}
                    value={inputText}
                    onChangeText={setInputText}
                    onSubmitEditing={handleAdd}
                    returnKeyType="done"
                    autoFocus
                    accessibilityLabel={`New ${categoryLabel(addCategory)} mandate`}
                    testID="align-add-input"
                  />
                  <View style={styles.addComposerFooter}>
                    <PrimaryPill
                      size="compact"
                      onPress={handleAdd}
                      disabled={!inputText.trim()}
                      accessibilityLabel="Add mandate"
                    >
                      Add
                    </PrimaryPill>
                  </View>
                </View>
              )}

              {safePillars.length > 0 ? (
                <View style={styles.mandateList}>{safePillars.map(renderMandateRow)}</View>
              ) : !showAddComposer ? (
                <Text style={styles.emptyMandates}>No mandates yet.</Text>
              ) : null}
            </View>
          </ScrollView>
        </AdaptiveScreen>
      </KeyboardAvoidingView>
      <MandateStrengthenSheet
        visible={!!strengthenTarget}
        mandate={strengthenTarget}
        onClose={() => setStrengthenTarget(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  pressed: { opacity: 0.72 },
  content: {
    paddingTop: spacing.xxxl,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.huge,
  },
  screenHeader: { marginBottom: spacing.xxl },
  screenTitle: { color: tokens.color.text, fontSize: 22, lineHeight: 28, fontWeight: '700' },
  screenSubtitle: {
    color: tokens.color.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    marginTop: spacing.xxs,
  },
  anchorSection: { marginBottom: spacing.xl },
  sectionTitleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quietLabel: { color: tokens.color.gold, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  textAction: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  textActionLabel: { color: tokens.color.gold, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  anchorText: { color: tokens.color.text, fontSize: 18, lineHeight: 28, fontWeight: '500' },
  anchorInput: {
    minHeight: 72,
    borderRadius: 12,
    backgroundColor: tokens.color.surface,
    color: tokens.color.text,
    fontSize: 17,
    lineHeight: 24,
    padding: spacing.md,
  },
  anchorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  secondaryAction: {
    minHeight: 44,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionLabel: { color: tokens.color.textSecondary, fontSize: 15, fontWeight: '600' },
  voicePrompt: {
    paddingVertical: spacing.lg,
    marginBottom: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.color.goldHairline,
  },
  voicePromptQuestion: { ...tokens.type.poeticMd, color: tokens.color.text },
  voicePromptBody: {
    color: tokens.color.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    marginTop: spacing.xs,
  },
  voicePromptDismiss: {
    alignSelf: 'flex-end',
    minHeight: 44,
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  reflectionSection: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.color.goldHairline,
    marginBottom: spacing.lg,
  },
  reflectionDisclosure: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reflectionLabel: { color: tokens.color.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  disclosureChevron: { color: tokens.color.gold, fontSize: 18 },
  reflectionText: {
    color: tokens.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    paddingBottom: spacing.md,
  },
  mandatesSection: { marginTop: spacing.sm },
  mandatesTitleRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mandatesTitle: { color: tokens.color.gold, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  addAction: {
    minWidth: 64,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  addActionLabel: { color: tokens.color.gold, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  addComposer: {
    backgroundColor: tokens.color.surface,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  addCategoryRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  addCategoryAction: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  addCategoryActionActive: { backgroundColor: 'rgba(229,186,110,0.10)' },
  addCategoryLabel: { color: tokens.color.textMuted, fontSize: 13, fontWeight: '600' },
  addCategoryLabelActive: { color: tokens.color.gold },
  addInput: {
    minHeight: 52,
    color: tokens.color.text,
    fontSize: 17,
    lineHeight: 24,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.color.goldHairline,
  },
  addComposerFooter: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: spacing.xs,
  },
  mandateList: { marginTop: spacing.xxs },
  mandateRow: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.color.goldHairline,
  },
  mandateRowCopy: { flex: 1, paddingVertical: spacing.md },
  mandateTitle: { color: tokens.color.text, fontSize: 17, lineHeight: 24, fontWeight: '500' },
  mandateMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xxs,
  },
  mandateCategory: { color: tokens.color.textSecondary, fontSize: 13, lineHeight: 18 },
  strengthenLabel: { color: tokens.color.gold, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  rowChevron: { color: tokens.color.textMuted, fontSize: 22, marginLeft: spacing.sm },
  emptyMandates: {
    color: tokens.color.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    paddingVertical: spacing.xl,
  },
});
