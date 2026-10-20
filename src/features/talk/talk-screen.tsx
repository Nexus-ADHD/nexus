// @ts-nocheck
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { IconButton } from '@/src/components/ui/IconButton';
import { ListRow } from '@/src/components/ui/ListRow';
import { ScreenShell } from '@/src/components/screen-shell';
import { SectionCard } from '@/src/components/section-card';
import { parseInput } from '@/src/features/talk/parser-service';
// parser-schema never existed — the types live in parser-service (pre-existing
// broken import, fixed while migrating this screen off the deleted stubs).
import type { ParsedCommandAction, ParsedInputSuccess } from '@/src/features/talk/parser-service';
import { useAppState } from '@/src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import tokens from '@/src/theme/tokens';

const starterPrompts = [
  'log workout',
  'I worked out today',
  'meditated at 6am today',
  'I meditated today',
  'did yoga this morning',
  'I did yoga today',
  'journaled this morning',
  'I journaled today',
  'read for 20 minutes',
  'worked out at 7am',
  'donated $100 to Lebanon relief',
  'gave away 2 hoodies',
  'add school pickup tomorrow at 4 PM',
  'what matters next?',
  'This morning I meditated at 6, did yoga for 20 minutes, and donated 100 to Lebanon relief.',
];

function formatFieldLabel(key: string) {
  if (key === 'habitTitle') return 'Habit name';
  if (key === 'durationMinutes') return 'Duration';

  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function formatFieldValue(key: string, value: string | number) {
  if (key === 'durationMinutes') return `${value} minutes`;
  return String(value);
}

export function TalkScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const colors = {
    accent:      tokens.color.gold,
    accentSoft:  tokens.color.goldWash,
    text:        tokens.color.text,
    mutedText:   tokens.color.textMuted,
    surfaceMuted:tokens.color.surface,
    border:      tokens.color.goldHairline,
    surface:     tokens.color.surface,
    danger:      tokens.color.stateError,
  };
  const hasApiKey = true; // proxy handles auth
  const {
  commandHistory = [],
  latestGuidance = 'No guidance yet.',
  saveParsedCommands,
} = useAppState(
  useShallow((s: any) => ({
    commandHistory: s.commandHistory,
    latestGuidance: s.latestGuidance,
    saveParsedCommands: s.saveParsedCommands,
  })),
);
  const [command, setCommand] = useState('');
  const [reviewResult, setReviewResult] = useState<ParsedInputSuccess | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleReview() {
    const result = await parseInput(command, new Date().toISOString().slice(0, 10));

    if (result.kind === 'error') {
      setReviewResult(null);
      setErrorMessage(result.message);
      return;
    }

    setReviewResult(result);
    setErrorMessage(null);
    setFeedback(null);
  }

  function handleConfirm() {
    if (!reviewResult) return;

    const result = saveParsedCommands
  ? saveParsedCommands(reviewResult.commands)
  : { message: 'Saved locally.' };
    setFeedback(result.message);
    setErrorMessage(null);
    setReviewResult(null);
  }

  function handleReset() {
    setCommand('');
    setReviewResult(null);
    setFeedback(null);
    setErrorMessage(null);
  }

  return (
    <ScreenShell
      eyebrow="Voice-first capture"
      title="Talk"
      description="Type natural commands for now and confirm the parsed intent before it updates your system."
      rightSlot={
        // Kit IconButton replaces the deleted SettingsLink stub. Targets the
        // '/settings' index route added in generic-list-row PR 2 (settings
        // otherwise opens modally from Home only).
        <IconButton
          icon={
            <SymbolView
              name="gearshape"
              size={tokens.icon.size.md}
              tintColor={tokens.color.text}
              weight={tokens.icon.weight.default}
            />
          }
          onPress={() => router.push('/settings')}
          accessibilityLabel="Open settings"
        />
      }>
      <SectionCard title="Command input" subtitle="This is the V1 text stand-in for voice capture.">
        {/* FIXME(nex-56): off-scale fontSize 18 (debug indicator), design review */}
        <Text style={{ fontSize: 18, fontWeight: '700', color: hasApiKey ? 'green' : 'red' }}>
          API key loaded: {hasApiKey ? 'YES' : 'NO'}
        </Text>
        <View style={[styles.micButton, { backgroundColor: colors.accentSoft }]}>
          <Text style={[styles.micText, { color: colors.accent }]}>Mic placeholder</Text>
        </View>
        <TextInput
          multiline
          placeholder="Try a freeform message like: This morning I meditated at 6, did yoga for 20 minutes, and donated 100 to Lebanon relief."
          placeholderTextColor={colors.mutedText}
          value={command}
          onChangeText={setCommand}
          style={[
            styles.input,
            {
              backgroundColor: colors.surfaceMuted,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
        />
        <View style={styles.actions}>
          <Pressable
            onPress={handleReview}
            style={[
              styles.actionButton,
              {
                backgroundColor: colors.surfaceMuted,
                borderColor: colors.border,
              },
            ]}>
            <Text style={[styles.actionLabel, { color: colors.text }]}>Review command TEST</Text>
          </Pressable>
          <Pressable
            onPress={handleReset}
            style={[
              styles.actionButton,
              {
                backgroundColor: colors.surfaceMuted,
                borderColor: colors.border,
              },
            ]}>
            <Text style={[styles.actionLabel, { color: colors.text }]}>Reset</Text>
          </Pressable>
        </View>
        {errorMessage ? <Text style={[styles.message, { color: colors.danger }]}>{errorMessage}</Text> : null}
        {feedback ? <Text style={[styles.message, { color: colors.accent }]}>{feedback}</Text> : null}
      </SectionCard>

      {reviewResult ? (
        <SectionCard
          title="Review detected commands"
          subtitle={`${reviewResult.commands.length} extracted for review`}>
          <View
            style={[
              styles.sourceBadge,
              {
                backgroundColor:
                  reviewResult.source === 'ai' ? colors.accentSoft : colors.surfaceMuted,
              },
            ]}>
            <Text style={[styles.sourceBadgeLabel, { color: colors.text }]}>
              {reviewResult.source === 'ai' ? 'AI' : 'Rules fallback'}
            </Text>
          </View>

          {reviewResult.commands.map((parsedCommand: ParsedCommandAction, index) => (
            <View
              key={`${parsedCommand.intent}-${index}`}
              style={[
                styles.reviewCard,
                {
                  backgroundColor: colors.surfaceMuted,
                  borderColor: colors.border,
                },
              ]}>
              <Text style={[styles.reviewCardTitle, { color: colors.text }]}>
                Action {index + 1}: {parsedCommand.intent}
              </Text>
              <Text style={[styles.reviewCardSummary, { color: colors.mutedText }]}>
                {parsedCommand.summary}
              </Text>
              {Object.entries(parsedCommand.fields).map(([key, value]) => (
                <ListRow
                  key={`${parsedCommand.intent}-${index}-${key}`}
                  title={formatFieldLabel(key)}
                  trailing="value"
                  value={formatFieldValue(key, value)}
                />
              ))}
            </View>
          ))}

          <View style={styles.actions}>
            <Pressable
              onPress={handleConfirm}
              style={[
                styles.primaryButton,
                {
                  backgroundColor: colors.accent,
                  borderColor: colors.accent,
                },
              ]}>
              <Text style={[styles.primaryLabel, { color: colors.surface }]}>
                Confirm {reviewResult.commands.length > 1 ? 'All' : ''}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleReset}
              style={[
                styles.actionButton,
                {
                  backgroundColor: colors.surfaceMuted,
                  borderColor: colors.border,
                },
              ]}>
              <Text style={[styles.actionLabel, { color: colors.text }]}>Edit / Reset</Text>
            </Pressable>
          </View>
        </SectionCard>
      ) : null}

      <SectionCard title="Supported commands" subtitle="Tap one to load it into the text input.">
        {starterPrompts.map((prompt) => (
          <Pressable
            key={prompt}
            onPress={() => {
              setCommand(prompt);
              setReviewResult(null);
              setErrorMessage(null);
              setFeedback(null);
            }}
            style={[styles.promptChip, { backgroundColor: colors.surfaceMuted }]}>
            <Text style={[styles.promptText, { color: colors.text }]}>{prompt}</Text>
          </Pressable>
        ))}
      </SectionCard>

      <SectionCard title="Latest guidance" subtitle="Saved output from the ask_what_matters_next intent.">
        <Text style={[styles.promptText, { color: colors.text }]}>{latestGuidance}</Text>
      </SectionCard>

      <SectionCard title="Recent saved commands" subtitle="Local in-app history only.">
        {(commandHistory ?? []).length === 0 ? (
          <Text style={[styles.promptText, { color: colors.mutedText }]}>No commands confirmed yet.</Text>
        ) : (
          (commandHistory ?? []).slice(0, 4).map((entry) => (
            <ListRow
              key={entry.id}
              title={entry.summary}
              subtitle={entry.rawInput}
              trailing="value"
              value={entry.intent}
            />
          ))
        )}
      </SectionCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  micButton: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 96,
  },
  micText: {
    // FIXME(nex-56): fontSize 16 matches buttonPrimary size but fontWeight '600' (token match) + no fontFamily set (default ≠ Inter-SemiBold) — design review
    fontSize: 16,
    fontWeight: '600',
  },
  input: {
    borderRadius: 16,
    borderWidth: 1,
    // FIXME(nex-56): fontSize 15 matches bodyMd size but no fontFamily set (default ≠ Inter-Regular); lineHeight 22 token match — design review
    fontSize: 15,
    lineHeight: 22,
    minHeight: 130,
    padding: tokens.spacing.md,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    gap: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
  },
  actionButton: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
  },
  actionLabel: {
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    fontWeight: '600',
  },
  primaryButton: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
  },
  primaryLabel: {
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    fontWeight: '700',
  },
  promptChip: {
    borderRadius: 16,
    padding: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
  },
  sourceBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 6 /* FIXME(nex-56): off-scale spacing 6 — review */,
  },
  sourceBadgeLabel: {
    // FIXME(nex-56): off-scale fontSize 12, design review
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  reviewCard: {
    borderRadius: 16,
    borderWidth: 1,
    gap: tokens.spacing.xs,
    padding: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
  },
  reviewCardTitle: {
    // FIXME(nex-56): fontSize 15 matches bodyMd size but fontWeight '700' ≠ token '400' — design review
    fontSize: 15,
    fontWeight: '700',
  },
  reviewCardSummary: {
    // FIXME(nex-56): fontSize 13 matches caption size but no fontFamily set (default ≠ Inter-Medium); lineHeight 18 token match — design review
    fontSize: 13,
    lineHeight: 18,
  },
  promptText: {
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    lineHeight: 20,
  },
  message: {
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    lineHeight: 20,
  },
});
