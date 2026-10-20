// @ts-nocheck
import React from 'react';
import {
  Modal, View, Text, StyleSheet, ScrollView, Pressable, Linking,
} from 'react-native';
import tokens from '@/src/theme/tokens';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
// FIXME(nex-56): neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline)
const BORDER = tokens.color.goldHairline;
const TEXT = tokens.color.text;
// FIXME(nex-56): off-scale gray; consider textMuted or design review
const MUTED = tokens.color.textMuted;
const GOLD = tokens.color.gold;

interface EventDetail {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  notes?: string | null;
  location?: string | null;
  url?: string | null;
  cal?: string;
}

interface Props {
  event: EventDetail | null;
  onDismiss: () => void;
  onOpenCalendar: (event: EventDetail) => void;
  // NEX-162: dumb trigger — orbit.tsx owns the create flow and lifts the state.
  onNeedsAdvanceAction?: (event: EventDetail) => void;
}

function formatDateRange(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const sameDay = s.toDateString() === e.toDateString();
    const dateStr = s.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const startTime = s.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endTime = e.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `${dateStr}  ·  ${startTime} – ${endTime}`;
    return `${dateStr}  ·  ${startTime}`;
  } catch {
    return '';
  }
}

function getDuration(start: string, end: string): string {
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  } catch {
    return '';
  }
}

export function EventDetailSheet({ event, onDismiss, onOpenCalendar, onNeedsAdvanceAction }: Props) {
  if (!event) return null;

  const duration = getDuration(event.startDate, event.endDate);
  const timeStr = formatDateRange(event.startDate, event.endDate);
  const hasNotes = event.notes && event.notes.trim().length > 0;
  const hasLocation = event.location && event.location.trim().length > 0;
  const hasUrl = event.url && event.url.trim().length > 0;

  // Strip ORBIT_RULE_ID tags from notes
  const cleanNotes = hasNotes
    ? event.notes!.replace(/\[ORBIT_RULE_ID:[^\]]+\]/g, '').trim()
    : null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onDismiss}
    >
      <View style={styles.container}>
        {/* Handle */}
        <View style={styles.handleRow}>
          <View style={styles.handle} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={true}
        >
          {/* Header */}
          <Text style={styles.calLabel}>CALENDAR EVENT</Text>
          <Text style={styles.title}>{event.title}</Text>

          {/* Time */}
          <View style={styles.metaRow}>
            <Text style={styles.metaIcon}>🕐</Text>
            <View style={styles.metaContent}>
              <Text style={styles.metaText}>{timeStr}</Text>
              {duration ? <Text style={styles.metaSub}>{duration}</Text> : null}
            </View>
          </View>

          {/* Location */}
          {hasLocation && (
            <View style={styles.metaRow}>
              <Text style={styles.metaIcon}>📍</Text>
              <Text style={styles.metaText}>{event.location}</Text>
            </View>
          )}

          {/* URL */}
          {hasUrl && (
            <Pressable
              style={styles.metaRow}
              onPress={() => Linking.openURL(event.url!).catch(() => {})}
            >
              <Text style={styles.metaIcon}>🔗</Text>
              <Text style={[styles.metaText, styles.link]} numberOfLines={1}>{event.url}</Text>
            </Pressable>
          )}

          {/* Description / Notes */}
          {cleanNotes ? (
            <View style={styles.notesCard}>
              <Text style={styles.notesLabel}>DESCRIPTION</Text>
              <Text style={styles.notesText}>{cleanNotes}</Text>
            </View>
          ) : (
            <View style={styles.notesCard}>
              <Text style={styles.noNotesText}>No description added to this event.</Text>
            </View>
          )}

          {/* Actions */}
          {onNeedsAdvanceAction && (
            <Pressable style={styles.leadTimeBtn} onPress={() => onNeedsAdvanceAction(event)}>
              <Text style={styles.leadTimeBtnText}>NEEDS ADVANCE ACTION</Text>
            </Pressable>
          )}

          <PrimaryPill fullWidth style={{ marginBottom: tokens.spacing.sm }} onPress={() => onOpenCalendar(event)}>
            OPEN IN CALENDAR →
          </PrimaryPill>

          <Pressable style={styles.dismissBtn} onPress={onDismiss}>
            <Text style={styles.dismissBtnText}>CLOSE</Text>
          </Pressable>

        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  // FIXME(nex-56): off-scale 14pt paddingTop + 4pt paddingBottom — design review
  handleRow: { alignItems: 'center', paddingTop: 14, paddingBottom: tokens.spacing.xxs },
  // FIXME(nex-56): neutral gray handle #333, no token — design review
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: tokens.color.textDisabled },
  // FIXME(nex-56): off-scale 60pt paddingBottom — design review
  scroll: { padding: tokens.spacing.lg, paddingBottom: 60 },
  // FIXME(nex-56): off-scale 10pt fontSize + 10pt margin — design review
  calLabel: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginBottom: 10 },
  // FIXME(nex-56): off-scale 26pt fontSize + 32pt lineHeight — design review (nearest titleScreen 28pt)
  title: { color: TEXT, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginBottom: tokens.spacing.lg, lineHeight: 32 },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: tokens.spacing.md, gap: tokens.spacing.sm },
  // FIXME(nex-56): off-scale 16pt fontSize + 1pt margin — design review
  metaIcon: { fontSize: 16, marginTop: 1 },
  metaContent: { flex: 1 },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  metaText: { color: TEXT, fontSize: 14, lineHeight: 20, flex: 1 },
  // FIXME(nex-56): off-scale 12pt fontSize + 2pt margin — design review
  metaSub: { color: MUTED, fontSize: 12, marginTop: 2 },
  // FIXME(nex-56): off-spec blue #44AAFF (link), no token — design review (CLAUDE.md stateInfo or design system blue not picked)
  link: { color: tokens.color.stateInfo, textDecorationLine: 'underline' },
  // FIXME(nex-56): off-scale 18pt padding — design review
  notesCard: {
    backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1,
    borderColor: BORDER, padding: 18, marginTop: tokens.spacing.xs, marginBottom: tokens.spacing.lg,
  },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  notesLabel: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  notesText: { color: TEXT, fontSize: 14, lineHeight: 22 },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  noNotesText: { color: MUTED, fontSize: 13, lineHeight: 20, fontStyle: 'italic' },
  // NEX-162: outlined-gold affordance (earned/attention register, §10.6).
  leadTimeBtn: {
    borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: tokens.spacing.sm,
    borderWidth: 1, borderColor: GOLD, backgroundColor: 'transparent',
  },
  leadTimeBtnText: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 2 },
  dismissBtn: { alignItems: 'center', paddingVertical: tokens.spacing.sm },
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  dismissBtnText: { color: MUTED, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
});
