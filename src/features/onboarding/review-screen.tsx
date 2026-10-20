// NEX-57 — Review screen, pool-with-tap pattern.
//
// One mandate at a time, horizontally paged. For each mandate, Pulse
// surfaces a POOL of 2-3 habit options + 2-3 downstream actions
// (recurring-todos + one-time-todos). The user taps ADD on what
// resonates; the rest stays unselected. On BEGIN, commitActivation
// sweeps only `added: true` items into canonical state. Per-mandate
// REGENERATE preserves the user's ADDed picks and swaps un-ADDed
// slots with a fresh pool from Pulse.
//
// Layout:
//   - Header: title + subtitle (static)
//   - Pager (horizontal, pagingEnabled): one MandatePage per mandate
//     - Each page: mandate hero + REGENERATE + 3 sections
//       (STRENGTHEN HABITS / RECURRING / THIS WEEK). Empty sections
//       are hidden.
//   - Footer: pagination dots + BEGIN (with ADDed count)
//
// All Pulse calls live in the parent (app/_layout.tsx). This component
// is presentational + interaction: reads from props.recommendations,
// fires callbacks on user input.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import tokens from '@/src/theme/tokens';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';
import { stripEmoji } from '@/src/utils/text';
import type {
  OnboardingRecommendations,
  OnboardingRecommendedHabit,
  OnboardingRecommendedMandate,
  OnboardingRecommendedRecurringTodo,
  OnboardingRecommendedTodo,
} from '@/src/state/app-state';
import { formatDaysOfWeek } from './format-days-of-week';
import { pageIndexForOffset, pagerOffsetFor } from './pager-offset';

// NOTE: no module-scope Dimensions.get('window') here — a static read never
// updates on rotation/resize. The pager measures itself (onLayout, seeded
// from useWindowDimensions) inside ReviewScreen below.

// ─── Visual register ─────────────────────────────────────────────────────────
// FIXME(nex-56): runtime alpha compositions (GOLD + '60', GOLD + '0D') below
// produce gold-tint strings at runtime. The base token migrates via the GOLD
// const; the alpha suffixes themselves are not hex literals and stay as-is.
// Surface-pass should propose gold-alpha tint tokens to replace these.

const GOLD = tokens.color.gold;
// v3 stellar: page background pure #000 → tokens.color.voidDeep.
const BG = tokens.color.voidDeep;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;
const DIVIDER = tokens.color.surfaceElevated;
const SURFACE = tokens.color.void;

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  recommendations: OnboardingRecommendations;
  /** User tapped BEGIN. Parent's commitActivation filters by `added: true`. */
  onAccept: (finalRecommendations: OnboardingRecommendations) => void;
  /** Tap to flip `added` on a habit. */
  onToggleAddedHabit: (slotId: string) => void;
  /** Tap to flip `added` on a recurring-todo. */
  onToggleAddedRecurringTodo: (slotId: string) => void;
  /** Tap to flip `added` on a one-time-todo. */
  onToggleAddedTodo: (slotId: string) => void;
  /** Fire a fresh Pulse pool for the mandate. Reducer preserves ADDed items. */
  onRegenerateMandate: (mandateId: string) => Promise<void>;
  /** When set, renders inline error under matching mandate. Format: 'mandate:<id>'. */
  refreshErrorFor?: string | null;
}

// ─── ReviewScreen ────────────────────────────────────────────────────────────

export default function ReviewScreen({
  recommendations,
  onAccept,
  onToggleAddedHabit,
  onToggleAddedRecurringTodo,
  onToggleAddedTodo,
  onRegenerateMandate,
  refreshErrorFor = null,
}: Props) {
  const pagerRef = useRef<ScrollView>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [loadingMandates, setLoadingMandates] = useState<Set<string>>(new Set());
  // Pager pages are sized to the pager's MEASURED width (onLayout, seeded
  // from the window width): under AdaptiveScreen the content column is
  // narrower than the window on wide viewports, and a static module-scope
  // Dimensions read would never update on rotation/resize.
  const { width: windowWidth } = useWindowDimensions();
  const [pagerWidth, setPagerWidth] = useState(windowWidth);

  // ── Rotation / resize re-anchor ──────────────────────────────────────────
  // Resizing the pages is not enough: the ScrollView keeps its OLD pixel
  // contentOffset, which is no longer a multiple of the new page width, so it
  // rests BETWEEN pages and pageIndexForOffset rounds to the wrong index —
  // the dots and the content disagree.
  //
  // But re-anchoring naively is its own bug: `currentPage` only advances on
  // momentum end, so a resize landing mid-drag would snap back to the PREVIOUS
  // settled page and fight the swipe in progress. So we anchor off the real
  // scroll position, and while the user is actually interacting we defer until
  // the gesture settles.
  const interactingRef = useRef(false);
  const pendingResizeRef = useRef(false);
  // Last settled offset, and the width it was measured at.
  const settledOffsetRef = useRef(0);
  const settledWidthRef = useRef(pagerWidth);

  const snapToPage = useCallback(
    (page: number, width: number) => {
      if (width <= 0) return;
      const x = pagerOffsetFor(page, width);
      settledOffsetRef.current = x;
      settledWidthRef.current = width;
      pagerRef.current?.scrollTo({ x, animated: false });
      setCurrentPage(page);
    },
    []
  );

  useEffect(() => {
    if (pagerWidth <= 0) return;
    if (interactingRef.current) {
      // Mid-gesture. The pages have already re-laid-out at the new width, so
      // the honest reading of "which page" is the native offset once the
      // gesture settles — not anything we could compute right now.
      pendingResizeRef.current = true;
      return;
    }
    // Idle: the last settled offset is still valid, but it was captured at the
    // PREVIOUS width, so resolve the page against that width before snapping.
    snapToPage(
      pageIndexForOffset(settledOffsetRef.current, settledWidthRef.current, mandates.length),
      pagerWidth
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resize only
  }, [pagerWidth]);

  const addedCount = useMemo(() => {
    return (
      recommendations.habits.filter((h) => h.added).length +
      recommendations.recurringTodos.filter((rt) => rt.added).length +
      recommendations.todos.filter((t) => t.added).length
    );
  }, [recommendations]);

  // Settle handler. The offset is produced at the CURRENT pagerWidth (the
  // pages re-lay-out as soon as the width state changes), so resolve against
  // that, not against the width the gesture began at.
  const handlePageScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    settledOffsetRef.current = x;
    settledWidthRef.current = pagerWidth;
    interactingRef.current = false;

    const idx = pageIndexForOffset(x, pagerWidth, mandates.length);
    if (idx !== currentPage) setCurrentPage(idx);

    // A resize arrived mid-gesture and was deferred. Now that the gesture has
    // settled, clear any between-pages rest it left behind.
    if (pendingResizeRef.current) {
      pendingResizeRef.current = false;
      snapToPage(idx, pagerWidth);
    }
  };

  const handleRegenerate = async (mandateId: string) => {
    haptic('dragDrop');
    setLoadingMandates((prev) => new Set(prev).add(mandateId));
    try {
      await onRegenerateMandate(mandateId);
    } finally {
      setLoadingMandates((prev) => {
        const next = new Set(prev);
        next.delete(mandateId);
        return next;
      });
    }
  };

  const handleBegin = useCallback(() => {
    if (addedCount === 0) return;
    onAccept(recommendations);
  }, [addedCount, onAccept, recommendations]);

  const handleToggleHabit = (slotId: string) => {
    haptic('buttonSecondary');
    onToggleAddedHabit(slotId);
  };
  const handleToggleRecurring = (slotId: string) => {
    haptic('buttonSecondary');
    onToggleAddedRecurringTodo(slotId);
  };
  const handleToggleTodo = (slotId: string) => {
    haptic('buttonSecondary');
    onToggleAddedTodo(slotId);
  };

  const mandates = recommendations.mandates;

  return (
    <View style={styles.root}>
      <AdaptiveScreen>
      {/* Header (static across pages) */}
      <View style={styles.header}>
        <Text style={styles.title}>Your practice</Text>
        <Text style={styles.subtitle}>
          Tap <Text style={styles.subtitleBold}>ADD</Text> on what resonates. Skip what doesn&apos;t.
        </Text>
      </View>

      {/* Horizontal pager — one page per mandate */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => {
          interactingRef.current = true;
        }}
        onMomentumScrollEnd={handlePageScroll}
        // A slow drag that stops without flinging never fires a momentum
        // event, so this is the other settle path — without it, interacting
        // would latch true and every later resize would be deferred forever.
        onScrollEndDrag={(e) => {
          if (e.nativeEvent.velocity && Math.abs(e.nativeEvent.velocity.x) > 0.01) return;
          handlePageScroll(e);
        }}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0 && w !== pagerWidth) setPagerWidth(w);
        }}
        style={styles.pager}
      >
        {mandates.map((mandate, mandateIndex) => {
          const habits = recommendations.habits.filter((h) => h.mandateId === mandate.id);
          const recurring = recommendations.recurringTodos.filter(
            (rt) => rt.mandateId === mandate.id,
          );
          const todos = recommendations.todos.filter((t) => t.mandateId === mandate.id);
          const isRegenerating = loadingMandates.has(mandate.id);
          const errorKey = `mandate:${mandate.id}`;
          return (
            <MandatePage
              key={mandate.id}
              mandate={mandate}
              habits={habits}
              recurring={recurring}
              todos={todos}
              isRegenerating={isRegenerating}
              hasError={refreshErrorFor === errorKey}
              onToggleHabit={handleToggleHabit}
              onToggleRecurring={handleToggleRecurring}
              onToggleTodo={handleToggleTodo}
              onRegenerate={() => handleRegenerate(mandate.id)}
              pageIndex={mandateIndex}
              pageTotal={mandates.length}
              pageWidth={pagerWidth}
            />
          );
        })}
      </ScrollView>

      {/* Footer: pagination dots + BEGIN */}
      <View style={styles.footer}>
        <PaginationDots total={mandates.length} current={currentPage} />
        <PrimaryPill
          fullWidth
          onPress={handleBegin}
          disabled={addedCount === 0}
        >
          {`BEGIN${addedCount > 0 ? ` (${addedCount})` : ''}`}
        </PrimaryPill>
      </View>
      </AdaptiveScreen>
    </View>
  );
}

// ─── MandatePage ─────────────────────────────────────────────────────────────

interface MandatePageProps {
  mandate: OnboardingRecommendedMandate;
  habits: OnboardingRecommendedHabit[];
  recurring: OnboardingRecommendedRecurringTodo[];
  todos: OnboardingRecommendedTodo[];
  isRegenerating: boolean;
  hasError: boolean;
  onToggleHabit: (slotId: string) => void;
  onToggleRecurring: (slotId: string) => void;
  onToggleTodo: (slotId: string) => void;
  onRegenerate: () => void;
  pageIndex: number;
  pageTotal: number;
  /** Measured pager width — pages snap one-width-per-page (see ReviewScreen). */
  pageWidth: number;
}

function MandatePage({
  mandate,
  habits,
  recurring,
  todos,
  isRegenerating,
  hasError,
  onToggleHabit,
  onToggleRecurring,
  onToggleTodo,
  onRegenerate,
  pageIndex,
  pageTotal,
  pageWidth,
}: MandatePageProps) {
  return (
    <View style={{ width: pageWidth }} accessibilityLabel={`Mandate ${pageIndex + 1} of ${pageTotal}`}>
      <ScrollView
        contentContainerStyle={styles.pageContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Mandate hero */}
        <View style={styles.heroBlock}>
          <Text style={styles.label}>MANDATE</Text>
          <Text style={styles.mandateTitle}>{mandate.title}</Text>
          {mandate.rationale && (
            <Text style={styles.mandateRationale}>{mandate.rationale}</Text>
          )}
          <View style={styles.regenRow}>
            <Pressable
              onPress={onRegenerate}
              disabled={isRegenerating}
              hitSlop={8}
              style={[styles.regenBtn, isRegenerating && styles.regenBtnLoading]}
              accessibilityRole="button"
              accessibilityLabel="Regenerate options"
            >
              {isRegenerating ? (
                <ActivityIndicator color={GOLD} size="small" />
              ) : (
                <Text style={styles.regenText}>↻ REGENERATE OPTIONS</Text>
              )}
            </Pressable>
          </View>
          {hasError && (
            <Text style={styles.errorMessage}>Couldn&apos;t regenerate. Try again.</Text>
          )}
        </View>

        {/* STRENGTHEN HABITS — always present (2-3 from generation) */}
        {habits.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.label}>STRENGTHEN HABITS</Text>
            {habits.map((h) => (
              <PoolCard
                key={h.slotId}
                title={stripEmoji(h.title)}
                meta={formatDaysOfWeek(h.daysOfWeek)}
                rationale={h.rationale}
                added={h.added}
                disabled={isRegenerating}
                onToggle={() => onToggleHabit(h.slotId)}
              />
            ))}
          </View>
        )}

        {/* RECURRING — hidden when empty */}
        {recurring.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.label}>RECURRING</Text>
            {recurring.map((rt) => (
              <PoolCard
                key={rt.slotId}
                title={rt.title}
                meta={formatDaysOfWeek(rt.daysOfWeek)}
                rationale={rt.rationale}
                added={rt.added}
                disabled={isRegenerating}
                onToggle={() => onToggleRecurring(rt.slotId)}
              />
            ))}
          </View>
        )}

        {/* THIS WEEK — hidden when empty */}
        {todos.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.label}>THIS WEEK</Text>
            {todos.map((t) => (
              <PoolCard
                key={t.slotId}
                title={t.title}
                meta={t.dueDate ? `Due ${t.dueDate}` : null}
                rationale={t.rationale}
                added={t.added}
                disabled={isRegenerating}
                onToggle={() => onToggleTodo(t.slotId)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── PoolCard ────────────────────────────────────────────────────────────────

interface PoolCardProps {
  title: string;
  meta: string | null;
  rationale: string;
  added: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function PoolCard({ title, meta, rationale, added, disabled, onToggle }: PoolCardProps) {
  return (
    <View style={[styles.card, added && styles.cardAdded]}>
      <View style={styles.cardMainRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{title}</Text>
          {meta && <Text style={styles.cardMeta}>{meta}</Text>}
        </View>
        <Pressable
          onPress={onToggle}
          disabled={disabled}
          hitSlop={8}
          style={[
            styles.addBtn,
            added && styles.addBtnAdded,
            disabled && styles.addBtnDisabled,
          ]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: added, disabled }}
          accessibilityLabel={added ? `Added: ${title}` : `Add ${title}`}
        >
          <Text style={[styles.addText, added && styles.addTextAdded]}>
            {added ? 'ADDED ✓' : 'ADD +'}
          </Text>
        </Pressable>
      </View>
      <Text style={styles.cardRationale}>{rationale}</Text>
    </View>
  );
}

// ─── PaginationDots ──────────────────────────────────────────────────────────

interface PaginationDotsProps {
  total: number;
  current: number;
}

function PaginationDots({ total, current }: PaginationDotsProps) {
  return (
    <View style={styles.dots}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[styles.dot, i === current ? styles.dotActive : styles.dotInactive]}
        />
      ))}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Transparent so the global StarField (app/_layout.tsx) shows through.
  // styles.footer below deliberately keeps opaque BG: scroll content slides
  // under the absolute footer; frosted-glass treatment is a flagged follow-up.
  root: { flex: 1, backgroundColor: 'transparent' },

  header: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: 60 /* FIXME(nex-56): off-scale spacing 60 — between xxl(48) and xxxl(72), review */,
    paddingBottom: tokens.spacing.lg,
  },
  title: {
    color: TEXT,
    // FIXME(nex-56): off-scale fontSize 32 (Fraunces-style italic display), design review
    fontSize: 32,
    fontStyle: 'italic',
    fontWeight: '300',
    lineHeight: 38,
    marginBottom: tokens.spacing.xs,
  },
  subtitle: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    lineHeight: 20,
  },
  subtitleBold: {
    color: GOLD,
    fontWeight: '700',
  },

  pager: { flex: 1 },
  // Page width is dynamic (measured pager width) — see MandatePage.
  pageContent: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.xs,
    paddingBottom: 140 /* FIXME(nex-56): off-scale spacing 140 — clears footer, design review */,
  },

  // Mandate hero
  heroBlock: {
    marginBottom: tokens.spacing.xl,
    paddingBottom: tokens.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: DIVIDER,
  },
  label: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 10, design review
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: tokens.spacing.xs,
  },
  mandateTitle: {
    color: TEXT,
    // FIXME(nex-56): fontSize 22 matches titleSection/poeticMd size but fontWeight '300' diverges from token defaults — design review
    fontSize: 22,
    fontStyle: 'italic',
    fontWeight: '300',
    lineHeight: 28,
    marginBottom: tokens.spacing.xs,
  },
  mandateRationale: {
    color: MUTED,
    // FIXME(nex-56): fontSize 13 matches caption size but fontWeight default ≠ token '500'; lineHeight 18 token match — design review
    fontSize: 13,
    lineHeight: 18,
    marginBottom: tokens.spacing.md,
  },
  regenRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  regenBtn: {
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    borderRadius: 16,
    borderWidth: 1,
    // FIXME(nex-56): runtime gold-alpha composition (GOLD + '60'); see visual-register FIXME above
    borderColor: GOLD + '60',
    minHeight: 34,
    minWidth: 180,
    justifyContent: 'center',
    alignItems: 'center',
  },
  regenBtnLoading: {
    opacity: 0.7,
  },
  regenText: {
    color: GOLD,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  errorMessage: {
    // v3 stellar: salmon-red error → tokens.color.stateError (warm-shifted).
    color: tokens.color.stateError,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
  },

  // Section
  section: { marginBottom: 28 /* FIXME(nex-56): off-scale spacing 28 — review */ },

  // Pool card
  card: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: DIVIDER,
    padding: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
  },
  cardAdded: {
    borderColor: GOLD,
    // FIXME(nex-56): runtime gold-alpha composition (GOLD + '0D'); see visual-register FIXME above
    backgroundColor: GOLD + '0D',
  },
  cardMainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
    marginBottom: tokens.spacing.xs,
  },
  cardTitle: {
    color: TEXT,
    // FIXME(nex-56): fontSize 15 matches bodyMd size but fontWeight '500' ≠ token '400' (matches bodyMdEmphasis weight); lineHeight 21 ≠ token 22 — design review
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 21,
  },
  cardMeta: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    marginTop: 2 /* FIXME(nex-56): off-scale spacing 2 — review */,
    letterSpacing: 0.3,
  },
  cardRationale: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 12, design review
    fontSize: 12,
    lineHeight: 17,
  },

  // ADD / ADDED toggle button
  addBtn: {
    paddingVertical: 6 /* FIXME(nex-56): off-scale spacing 6 — review */,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GOLD,
    minHeight: 28,
    minWidth: 76,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addBtnAdded: {
    backgroundColor: GOLD,
  },
  addBtnDisabled: {
    opacity: 0.4,
  },
  addText: {
    color: GOLD,
    // FIXME(nex-56): off-scale fontSize 10, design review
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
  },
  addTextAdded: {
    color: tokens.color.textInverse,
  },

  // Footer
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: BG,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.md,
    paddingBottom: 36 /* FIXME(nex-56): off-scale spacing 36 — review */,
    borderTopWidth: 1,
    borderTopColor: DIVIDER,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6 /* FIXME(nex-56): off-scale spacing 6 — review */,
    marginBottom: tokens.spacing.md,
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    width: 24,
    backgroundColor: GOLD,
  },
  dotInactive: {
    width: 6,
    // FIXME(nex-56): 333 off-scale gray (inactive pagination dot) — design review
    backgroundColor: tokens.color.textDisabled,
  },
});
