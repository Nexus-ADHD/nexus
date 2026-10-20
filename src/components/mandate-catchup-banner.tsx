/**
 * Mandate catch-up banner — Align tab.
 *
 * One-time, dismissible banner that surfaces existing mandates with
 * fewer than 2 linked habits ("weak mandates") so the user can run
 * the Strengthen sheet across them in one sitting. Designed for the
 * existing-user case: someone who created mandates before the
 * Strengthen flow shipped and now has identity statements without
 * supporting practice.
 *
 * Visibility logic (all must be true):
 *   - hasSeenTutorial === true
 *   - strengthenBannerDismissed === false
 *   - pillars.length >= 1
 *   - At least one weak mandate (< 2 linked habits in goalHabitMap)
 *
 * Tap chevron / body → opens a small picker listing the weak
 * mandates. Tapping a row opens the existing MandateStrengthenSheet
 * for that mandate. Picker auto-recomputes the weak list on every
 * render of itself, so a mandate that just got 2+ habits drops off
 * immediately. When the list empties, the picker closes and the
 * banner self-hides for the rest of the session.
 *
 * Tap × → setStrengthenBannerDismissed(true). Banner never returns,
 * even if new weak mandates appear later (per-brief intent: this is
 * a catch-up, not a recurring nag).
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { haptic } from '@/src/utils/haptics';
import { useAppState } from '../state/app-state';
import {
  MandateStrengthenSheet,
  type MandateRef,
} from './mandate-strengthen-sheet';
import { normalize } from '../utils/text';
import tokens from '@/src/theme/tokens';
import { Sheet } from '@/src/components/ui/Sheet';
import { ambientGlowSoft } from '@/src/theme/glow';

const GOLD = tokens.color.gold;
const TEXT_COLOR = tokens.color.text;
// v3 stellar follow-up: banner body text was textMuted (#9AA3B5) — too dim
// against the cosmic backdrop. Bumped to textSecondary so the body line
// has real contrast inside the strengthen card.
const MUTED = tokens.color.textSecondary;
// v3 stellar follow-up: banner bg was surfaceSunken (rgba 0.50) — too
// translucent, the cosmic backdrop drowned out the body text inside.
// Bumped to surface (rgba 0.68) for stronger occlusion. The banner's own
// border moved to luminousEdge in NEX-161; BORDER now only feeds the
// strengthen-picker sheet dividers, which stay quiet on surfaceElevated.
const SURFACE = tokens.color.surface;
const BORDER = tokens.color.surfaceElevated;

const WEAK_THRESHOLD = 2;

interface WeakMandate extends MandateRef {
  linkedCount: number;
}

function computeWeakMandates(
  pillars: any[],
  goalHabitMap: Record<string, string[]>,
): WeakMandate[] {
  if (!Array.isArray(pillars) || pillars.length === 0) return [];
  // Build pillarId → linked habit count by walking the goalHabitMap
  // once. Map keys are normalized habit titles; values are arrays of
  // pillar ids each habit is linked to.
  const counts: Record<string, number> = {};
  for (const key of Object.keys(goalHabitMap ?? {})) {
    const ids = goalHabitMap[key] ?? [];
    for (const id of ids) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  const weak: WeakMandate[] = [];
  for (const p of pillars) {
    if (!p?.id || !p?.title) continue;
    const linkedCount = counts[String(p.id)] ?? 0;
    if (linkedCount < WEAK_THRESHOLD) {
      weak.push({
        id: String(p.id),
        title: String(p.title),
        category: String(p.category ?? 'BUSINESS').toUpperCase(),
        linkedCount,
      });
    }
  }
  return weak;
}

export function MandateCatchupBanner() {
  // Subscribe to the slices we care about so the weak list
  // recomputes automatically as habits are added / linked.
  const hasSeenTutorial = useAppState((s) => s.hasSeenTutorial);
  const dismissed = useAppState((s) => s.strengthenBannerDismissed);
  const setDismissed = useAppState((s) => s.setStrengthenBannerDismissed);
  const pillars = useAppState((s) => s.pillars);
  const goalHabitMap = useAppState((s) => s.goalHabitMap);

  // Single state machine — only one Modal mounted at a time. The
  // prior dual-Modal layout (picker AND strengthen sheet both
  // mounted, with picker visible=false while strengthen was open)
  // left an iOS scrim layer alive that captured all touches on
  // Align after the user closed both sheets. Symptom: tabs, input,
  // and mandate cards became unresponsive until reload. Collapsing
  // to one Modal-or-none-at-a-time eliminates the overlap entirely.
  type SheetState =
    | { kind: 'none' }
    | { kind: 'picker' }
    | { kind: 'strengthen'; mandate: MandateRef };
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });

  const weak = useMemo(
    () => computeWeakMandates(pillars ?? [], goalHabitMap ?? {}),
    [pillars, goalHabitMap],
  );

  // Auto-collapse picker → none when the weak list empties (user
  // just strengthened the last weak mandate). Banner also auto-
  // hides because shouldShow drops with weak.length.
  React.useEffect(() => {
    if (sheet.kind === 'picker' && weak.length === 0) {
      setSheet({ kind: 'none' });
    }
  }, [weak.length, sheet.kind]);

  const shouldShow =
    hasSeenTutorial === true &&
    dismissed !== true &&
    Array.isArray(pillars) &&
    pillars.length >= 1 &&
    weak.length > 0;

  const handleOpen = useCallback(() => {
    haptic('tabChange');
    setSheet({ kind: 'picker' });
  }, []);

  const handleDismiss = useCallback(() => {
    haptic('buttonSecondary');
    setDismissed(true);
  }, [setDismissed]);

  const handlePickerClose = useCallback(() => {
    haptic('tabChange');
    setSheet({ kind: 'none' });
  }, []);

  const handlePickRow = useCallback((m: WeakMandate) => {
    haptic('tabChange');
    // Transition picker → strengthen by replacing the state.
    // Picker Modal unmounts before strengthen Modal mounts because
    // we render exactly one based on sheet.kind below.
    setSheet({
      kind: 'strengthen',
      mandate: { id: m.id, title: m.title, category: m.category },
    });
  }, []);

  // Read the latest weak length when strengthen closes — the
  // user may have just added habits to the only remaining weak
  // mandate, in which case we go to none. Otherwise return to
  // the picker so they can continue.
  const handleStrengthenClose = useCallback(() => {
    setSheet(weak.length > 0 ? { kind: 'picker' } : { kind: 'none' });
  }, [weak.length]);

  // Render the banner only when applicable. The strengthen sheet
  // is allowed to continue rendering even when shouldShow flips
  // to false mid-flight (e.g. user just strengthened the last
  // weak mandate) — yanking it would interrupt the user's flow.
  const showBanner = shouldShow;
  const showPicker = sheet.kind === 'picker';
  const showStrengthen = sheet.kind === 'strengthen';

  if (!showBanner && !showPicker && !showStrengthen) {
    return null;
  }

  return (
    <>
      {showBanner && (
        <View style={styles.banner}>
          <Pressable
            onPress={handleOpen}
            style={({ pressed }) => [
              styles.bannerBody,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.eyebrow}>STRENGTHEN</Text>
            <Text style={styles.headline}>These mandates have no practice yet.</Text>
            <Text style={styles.body}>
              {weak.length} of your mandates {weak.length === 1 ? "isn't" : "aren't"} connected to habits yet.
            </Text>
          </Pressable>
          <View style={styles.actions}>
            <Pressable
              onPress={handleOpen}
              hitSlop={8}
              style={({ pressed }) => [
                styles.chevronBtn,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.chevronText}>→</Text>
            </Pressable>
            <Pressable
              onPress={handleDismiss}
              hitSlop={10}
              style={({ pressed }) => [
                styles.dismissBtn,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.dismissText}>×</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Picker — only mounted when sheet.kind === 'picker'. Tap
          a row → setSheet({kind: 'strengthen'}), which unmounts
          this Modal and mounts the Strengthen sheet. No overlap. */}
      {showPicker && (
      <Sheet onDismiss={handlePickerClose} accessibilityLabel="Pick a weak mandate">
    <View style={styles.pickerHeader}>
          <Text style={styles.pickerEyebrow}>WEAK MANDATES</Text>
          <Text style={styles.pickerHint}>
            Pick one to strengthen.
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: tokens.spacing.sm }}>
          {weak.map((m) => (
            <Pressable
              key={`weak-${m.id}-${normalize(m.title)}`}
              onPress={() => handlePickRow(m)}
              style={({ pressed }) => [
                styles.row,
                pressed && { opacity: 0.6 },
              ]}
            >
              <View style={{ flex: 1, paddingRight: tokens.spacing.sm }}>
                <Text style={styles.rowTitle} numberOfLines={2}>{m.title}</Text>
                <Text style={styles.rowMeta}>
                  {m.category} · {m.linkedCount === 0 ? 'no habits' : `${m.linkedCount} habit${m.linkedCount === 1 ? '' : 's'}`}
                </Text>
              </View>
              <Text style={styles.rowChevron}>→</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable style={styles.doneBtn} onPress={handlePickerClose}>
          <Text style={styles.doneBtnText}>DONE</Text>
        </Pressable>
      </Sheet>
      )}

      {/* Strengthen sheet — only mounted when sheet.kind === 'strengthen'.
          onClose returns to the picker if any weak mandates remain,
          else dismisses entirely. The component is fully unmounted
          when not active so its Modal scrim cannot leak. */}
      {showStrengthen && (
        <MandateStrengthenSheet
          visible
          mandate={(sheet as { kind: 'strengthen'; mandate: MandateRef }).mandate}
          onClose={handleStrengthenClose}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // FIXME(nex-56): off-scale 22pt horiz margin + 14pt vert + 6pt — design review
  // NEX-161b: radius 14 → 16 + ambientGlowSoft — the banner sits directly above
  // the Align mandate cards in Library mode and was the one card-shaped
  // surface there without the halo.
  banner: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: SURFACE,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    marginHorizontal: 22,
    marginTop: 14,
    marginBottom: tokens.spacing.xs,
    paddingVertical: 14,
    paddingLeft: tokens.spacing.md,
    paddingRight: tokens.spacing.xs,
    ...ambientGlowSoft,
  },
  bannerBody: { flex: 1, paddingRight: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 9pt fontSize + 6pt margin — design review
  eyebrow: {
    color: GOLD,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 3,
    marginBottom: 6,
    fontFamily: 'IBMPlexMono-Medium',
  },
  // FIXME(nex-56): off-scale 17pt fontSize (matches bodyLg 17pt) but italic + Fraunces family + 22pt lineHeight don't match any token cleanly — design review
  headline: {
    color: TEXT_COLOR,
    fontSize: 17,
    lineHeight: 22,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    marginBottom: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale 13pt fontSize (matches caption but lineHeight 18 differs) — design review
  body: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter-Regular',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.xxs,
    paddingLeft: tokens.spacing.xxs,
  },
  chevronBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // FIXME(nex-56): off-scale 22pt fontSize (chevron glyph) — design review
  chevronText: {
    color: GOLD,
    fontSize: 22,
    fontWeight: '300',
  },
  dismissBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // FIXME(nex-56): off-scale 22pt fontSize (× glyph) — design review
  dismissText: {
    color: MUTED,
    fontSize: 22,
    fontWeight: '300',
    lineHeight: 24,
  },

  // Picker sheet
  // FIXME(nex-56): off-scale 22pt horiz padding — design review
  // FIXME(nex-56): off-scale 18pt + 14pt margins — design review
  pickerHeader: {
    paddingTop: tokens.spacing.xs,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    marginBottom: 14,
  },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  pickerEyebrow: {
    color: GOLD,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 4,
    marginBottom: tokens.spacing.xs,
  },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  pickerHint: {
    color: MUTED,
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },

  // FIXME(nex-56): off-scale 14pt paddingVertical — design review
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    paddingVertical: 14,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: tokens.spacing.xs,
  },
  // FIXME(nex-56): off-scale 15pt fontSize (matches bodyMd but weight 600 differs from token 400/500) — design review
  rowTitle: {
    color: TEXT_COLOR,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale 11pt fontSize (matches labelTrackedSm size but no uppercase) — design review
  rowMeta: {
    color: MUTED,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  // FIXME(nex-56): off-scale 20pt fontSize (chevron glyph) — design review
  rowChevron: {
    color: GOLD,
    fontSize: 20,
    fontWeight: '300',
  },

  // FIXME(nex-56): off-scale negative margins -22/-12 (full-bleed override) — design review
  doneBtn: {
    backgroundColor: SURFACE,
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingVertical: tokens.spacing.md,
    alignItems: 'center',
    marginHorizontal: -22,
    marginBottom: -12,
  },
  // FIXME(nex-56): off-scale 12pt fontSize — design review
  doneBtnText: {
    color: TEXT_COLOR,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 3,
  },
});
