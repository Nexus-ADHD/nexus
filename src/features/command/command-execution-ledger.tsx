/**
 * command-execution-ledger.tsx
 *
 * Renders the execution results after a proposal has been committed.
 * Shows success / partial / failed states and a retry button for
 * Apple Calendar sync failures.
 *
 * Retry logic stays in the Command screen (it touches React state and
 * native Calendar callbacks). This component receives `onRetryItem`
 * as a callback.
 *
 * Auto-dismiss: panel fades after `autoDismissMs` (default 4s).
 * Timer is ref-stabilized so parent re-renders don't reset it; it
 * re-arms only when the ledger's semantic signature changes (e.g.
 * a retry flips a partial → success). Tapping the header dismisses
 * immediately.
 *
 * Refs #4.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import tokens from '../../theme/tokens';
import { ambientGlowSoft } from '../../theme/glow';
import { LedgerItem } from './command-executor';
import { useAppState } from '../../state/app-state';
import { haptic } from '../../utils/haptics';
import { stripEmoji } from '../../utils/text';
import { locationLine, type CaptureSurface } from './confirmation-copy';
import type { TimeBlock } from '../../utils/recurrence';
import {
  initialOfferState,
  reduceOffer,
  type OfferState,
} from './time-block-offer-reducer';
import {
  initialBreakdownOfferState,
  reduceBreakdownOffer,
  type BreakdownOfferState,
} from './breakdown-offer-reducer';
import { GRAIN_ORDER, DEFAULT_GRAIN, type BreakdownGrain } from './breakdown';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CommandExecutionLedgerProps {
  ledger: LedgerItem[];
  retryingLedgerKeys: string[];
  onRetryItem: (item: LedgerItem, index: number) => void;
  onDismiss?: () => void;
  /** Auto-dismiss delay in ms. Pass 0 to disable. Default 4000. */
  autoDismissMs?: number;
  // NEX-195: one-tap undo/jump on the captured item. Optional so the
  // component stays usable without the wiring (e.g. error-only ledgers).
  onUndoItem?: (item: LedgerItem, index: number) => void;
  onJumpItem?: (item: LedgerItem, index: number) => void;
  // NEX-206 (Or-3): accept a suggested time block for a bare time-less habit.
  // Resolves `true` when the block was applied AND its Apple Calendar event
  // synced (atomic); `false` when nothing was applied (calendar denied / rule
  // gone) so the offer returns for a retry. `onUndoTimeBlock` reverts a just-
  // accepted block (clears it + deletes the event).
  onAcceptTimeBlock?: (item: LedgerItem, block: TimeBlock) => Promise<boolean>;
  onUndoTimeBlock?: (item: LedgerItem) => void;
  // NEX-210 (C-5): offer to break a vague/large inbox capture into steps. The
  // accept runs the AI breakdown AND lands the steps as inbox one-offs, then
  // resolves the created step titles + their inbox ids ({steps:[],ids:[]} on any
  // failure — the offer shows a no-blame retry). `onUndoBreakdown` deletes the
  // just-created steps (the original capture is left untouched). `breakdownGrain`
  // is the user's remembered preference, highlighted as the primary chip.
  onAcceptBreakdown?: (
    item: LedgerItem,
    grain: BreakdownGrain,
  ) => Promise<{ steps: string[]; ids: string[] }>;
  onUndoBreakdown?: (item: LedgerItem, stepIds: string[]) => void;
  breakdownGrain?: BreakdownGrain;
}

// NEX-195: which surfaces support a one-tap undo (a Nexus entity exists to
// remove). `calendar` is jump-only — a raw Apple event has no Nexus entity and
// deleting the user's real calendar event on an undo tap is a §1.5 Law E
// unrecoverable mistake.
const UNDOABLE_SURFACES: CaptureSurface[] = ['home_today', 'inbox', 'orbit', 'align'];

function canUndo(item: LedgerItem): boolean {
  return (
    !!item.entityId &&
    !!item.surface &&
    UNDOABLE_SURFACES.includes(item.surface as CaptureSurface)
  );
}

function canJump(item: LedgerItem): boolean {
  // Any item that landed on a known surface can be jumped to.
  return !!item.surface;
}

// ─── Copy helpers ─────────────────────────────────────────────────────────────

const DESTINATION_LABELS: Record<string, string> = {
  inbox_add: 'Inbox',
  todo_add: 'Tasks',
  recurring_todo_add: 'Recurring Tasks',
  recurring_add: 'Habits',
  calendar_add: 'Calendar',
  align: 'Goals',
};

function summarize(ledger: LedgerItem[]): string {
  const total = ledger.length;
  if (total === 0) return '';
  const successCount = ledger.filter((i) => i.status === 'success').length;
  const partialCount = ledger.filter((i) => i.status === 'partial').length;
  const failedCount = ledger.filter((i) => i.status === 'failed').length;

  // All failed.
  if (failedCount === total) {
    return total === 1
      ? "Couldn't do that. Try again?"
      : `Couldn't save ${total} actions. Try again?`;
  }

  // Any partial — surface that as the headline. No em dash in the user-facing
  // string (§18.1); a period keeps the same calm cadence.
  if (partialCount > 0) {
    return `Mostly done. ${partialCount} needed clarification.`;
  }

  // All success.
  if (successCount === total) {
    if (total === 1) {
      // NEX-195 (§1.5 Law A): a single capture gets the present-tense,
      // location-bearing headline ("On your Home, under Today.") instead of
      // a bare "Done." The per-item card below still carries the item's own
      // detail (e.g. the today-only default note), so the headline stays clean.
      const only = ledger[0];
      const loc = locationLine(only.surface, { category: only.category });
      if (loc) return loc;
      const detail = (only.detail || '').trim();
      if (!detail) return 'Done.';
      return `Done. ${detail}${detail.endsWith('.') ? '' : '.'}`;
    }
    return `Done. ${total} added.`;
  }

  // Mixed success + failed.
  return `Done. ${successCount} added · ${failedCount} couldn't save.`;
}

function itemHeaderLabel(item: LedgerItem): string {
  const dest = DESTINATION_LABELS[item.type];
  if (!dest) {
    // System / unknown types don't have a clean destination.
    if (item.status === 'success') return '✓ Done';
    if (item.status === 'partial') return '~ Partial';
    return "✕ Couldn't complete";
  }
  if (item.status === 'success') return `✓ Added to ${dest}`;
  if (item.status === 'partial') return `~ Partially added to ${dest}`;
  return `✕ Couldn't add to ${dest}`;
}

// NEX-206 (Or-3): time-block offer copy. The four wide blocks, the primary one
// (current daypart) first so it reads as "right now's" suggestion.
const TIME_BLOCK_ORDER: TimeBlock[] = ['morning', 'afternoon', 'evening', 'night'];

function blockTitle(block: TimeBlock): string {
  return block.charAt(0).toUpperCase() + block.slice(1);
}

/** Chip labels for the offer row: the suggested block first, then the rest. */
function orderedBlocks(suggested: TimeBlock): TimeBlock[] {
  return [suggested, ...TIME_BLOCK_ORDER.filter((b) => b !== suggested)];
}

// NEX-210 (C-5): grain chip copy. Fixed order (coarse → fine, GRAIN_ORDER); the
// remembered grain is highlighted as primary rather than reordered (jumping
// chips read worse than a steady row, per the time-block primary-chip pattern).
const GRAIN_LABELS: Record<BreakdownGrain, string> = {
  few: 'A few',
  several: 'Several',
  fine: 'Fine',
};

function breakdownCountLine(n: number): string {
  return n === 1 ? '1 step in your Inbox.' : `${n} steps in your Inbox.`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CommandExecutionLedger({
  ledger,
  retryingLedgerKeys,
  onRetryItem,
  onDismiss,
  autoDismissMs = 4000,
  onUndoItem,
  onJumpItem,
  onAcceptTimeBlock,
  onUndoTimeBlock,
  onAcceptBreakdown,
  onUndoBreakdown,
  breakdownGrain = DEFAULT_GRAIN,
}: CommandExecutionLedgerProps) {
  // Stash the latest onDismiss in a ref so the timer effect doesn't reset
  // every parent render (the parent passes a fresh inline lambda each time).
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const entranceFrom = useEntranceFrom(-8);

  // NEX-195: keys the user has undone — render "Removed." for those and then
  // close the panel shortly after (the reversal is itself a confirmation).
  const [undoneKeys, setUndoneKeys] = useState<string[]>([]);

  // NEX-206 (Or-3): per-item time-block offer state, keyed by ledger item key.
  // Lazily seeded for items carrying a suggestion. Ephemeral — it lives only as
  // long as this ledger is mounted (the offer "dies with the ledger"; no nag).
  const [offers, setOffers] = useState<Record<string, OfferState>>(() => {
    const seed: Record<string, OfferState> = {};
    for (const i of ledger) if (i.suggestTimeBlock) seed[i.key] = initialOfferState(null);
    return seed;
  });
  // Synchronous in-flight claim so a rapid double-tap can't fire two calendar
  // creates before the async accept resolves (claim-before-await, per LEARNINGS).
  const acceptingRef = useRef<Set<string>>(new Set());

  const dispatchOffer = (key: string, action: Parameters<typeof reduceOffer>[1]) =>
    setOffers((prev) => {
      const current = prev[key] ?? initialOfferState(null);
      const next = reduceOffer(current, action);
      return next === current ? prev : { ...prev, [key]: next };
    });

  const handleAcceptTimeBlock = async (item: LedgerItem, block: TimeBlock) => {
    if (!onAcceptTimeBlock || !item.suggestTimeBlock) return;
    if (acceptingRef.current.has(item.key)) return; // double-tap guard
    const current = offers[item.key];
    if (current && current.phase !== 'offered') return;
    acceptingRef.current.add(item.key);
    dispatchOffer(item.key, { type: 'accept', block });
    let ok = false;
    try {
      ok = await onAcceptTimeBlock(item, block);
    } catch {
      ok = false;
    } finally {
      acceptingRef.current.delete(item.key);
    }
    dispatchOffer(item.key, { type: ok ? 'accept_resolved' : 'accept_failed' });
  };

  const handleUndoTimeBlock = (item: LedgerItem) => {
    dispatchOffer(item.key, { type: 'undo' });
    onUndoTimeBlock?.(item);
  };

  // NEX-210 (C-5): per-item "break into steps" offer state, keyed by ledger key.
  // Seeded for inbox captures the heuristic flagged. Ephemeral — dies with the
  // ledger (no nag) once settled; while GENERATING it suspends the auto-dismiss
  // (below) so the call can't unmount us mid-flight.
  const [breakdowns, setBreakdowns] = useState<Record<string, BreakdownOfferState>>(() => {
    const seed: Record<string, BreakdownOfferState> = {};
    for (const i of ledger) if (i.suggestBreakdown) seed[i.key] = initialBreakdownOfferState();
    return seed;
  });
  // Synchronous in-flight claim so a rapid double-tap can't fire two AI breakdowns
  // (claim-before-await, mirroring acceptingRef / per LEARNINGS).
  const generatingRef = useRef<Set<string>>(new Set());
  // Drop a resolve that lands after unmount (manual dismiss / navigation during
  // the call): the steps still landed in the Inbox — the canonical surface, so
  // not silent (Law A) — we just must not setState on an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on mount too (not just the initial ref value) so a StrictMode
    // mount→unmount→remount in dev doesn't leave it false forever.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dispatchBreakdown = (
    key: string,
    action: Parameters<typeof reduceBreakdownOffer>[1],
  ) =>
    setBreakdowns((prev) => {
      const current = prev[key] ?? initialBreakdownOfferState();
      const next = reduceBreakdownOffer(current, action);
      return next === current ? prev : { ...prev, [key]: next };
    });

  const handleGenerateBreakdown = async (item: LedgerItem, grain: BreakdownGrain) => {
    if (!onAcceptBreakdown || !item.suggestBreakdown) return;
    if (generatingRef.current.has(item.key)) return; // double-tap guard
    const current = breakdowns[item.key];
    if (current && current.phase !== 'offered') return;
    generatingRef.current.add(item.key);
    dispatchBreakdown(item.key, { type: 'generate', grain });
    let steps: string[] = [];
    let ids: string[] = [];
    try {
      const res = await onAcceptBreakdown(item, grain);
      steps = res?.steps ?? [];
      ids = res?.ids ?? [];
    } catch {
      steps = [];
      ids = [];
    } finally {
      generatingRef.current.delete(item.key);
    }
    if (!mountedRef.current) return; // dismissed mid-call; steps are in the Inbox
    dispatchBreakdown(
      item.key,
      ids.length > 0
        ? { type: 'generate_resolved', steps, stepIds: ids }
        : { type: 'generate_failed' },
    );
  };

  const handleUndoBreakdown = (item: LedgerItem) => {
    const stepIds = breakdowns[item.key]?.stepIds ?? [];
    dispatchBreakdown(item.key, { type: 'undo' });
    if (stepIds.length) onUndoBreakdown?.(item, stepIds);
  };

  // Re-arm the timer only when the ledger's content semantically changes.
  // A retry flipping partial → success should restart the 4s window so
  // the user sees the new state. Mere reference changes shouldn't.
  const ledgerSig = ledger.map((i) => `${i.key}:${i.status}`).join('|');

  // NEX-195: while the user still has an undo to make, SUSPEND the auto-dismiss
  // so the trust window isn't lost (an undoable destructive action must not
  // vanish on a timer). Suspension is keyed on undoable items STILL PENDING —
  // in a multi-item ledger, undoing one must not close the panel while another
  // is still undoable. Once every undoable item is resolved, show "Removed."
  // briefly then close. Error-only / calendar-only ledgers keep the 4s window.
  const undoableKeys = onUndoItem ? ledger.filter((i) => canUndo(i)).map((i) => i.key) : [];
  const pendingUndoableCount = undoableKeys.filter((k) => !undoneKeys.includes(k)).length;
  const hasUndone = undoneKeys.length > 0;

  // NEX-210: while a breakdown is in flight, SUSPEND the auto-dismiss so the
  // ledger can't unmount mid-call (which would land the steps with no result
  // line / no undo). Once every breakdown settles, the offer dies with the
  // ledger like any other (a settled `generated` row does not hold the panel).
  const generatingCount = Object.values(breakdowns).filter((b) => b.phase === 'generating').length;

  useEffect(() => {
    if (!onDismissRef.current || autoDismissMs <= 0) return;
    if (pendingUndoableCount > 0) return; // wait for the user to act on the rest
    if (generatingCount > 0) return; // a breakdown is resolving — keep us mounted
    const delay = hasUndone ? 1100 : autoDismissMs;
    const t = setTimeout(() => onDismissRef.current?.(), delay);
    return () => clearTimeout(t);
  }, [autoDismissMs, ledgerSig, pendingUndoableCount, hasUndone, generatingCount]);

  const handleUndo = (item: LedgerItem, idx: number) => {
    if (undoneKeys.includes(item.key)) return;
    setUndoneKeys((prev) => [...prev, item.key]);
    onUndoItem?.(item, idx);
  };

  const summary = summarize(ledger);
  const hasFailed = ledger.some((i) => i.status === 'failed');
  const hasPartial = ledger.some((i) => i.status === 'partial');
  // FIXME(nex-56): ledger-status header palette — 3 semantic colors (red failed / yellow partial / green success),
  // part of the broader ledger-status palette FIXME at the StyleSheet block below (and tonal-variants in itemTypeFailed,
  // itemTypePartial, itemDetailFailed, itemDetailPartial). See StyleSheet for the full palette FIXME block.
  const headerColor = hasFailed ? tokens.color.stateError : hasPartial ? tokens.color.gold : tokens.color.teal;

  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: 1, translateY: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'timing', duration: 220 }}
      style={styles.container}
    >
      <Pressable onPress={onDismiss} style={styles.headerPressable} hitSlop={8}>
        <Text style={[styles.header, { color: headerColor }]}>{summary}</Text>
        {onDismiss && <Text style={styles.dismissHint}>TAP TO DISMISS</Text>}
      </Pressable>

      {ledger.map((item, idx) => {
        const isRetrying = retryingLedgerKeys.includes(item.key);
        const isUndone = undoneKeys.includes(item.key);
        const showUndo = !!onUndoItem && canUndo(item);
        const showJump = !!onJumpItem && canJump(item);

        return (
          <View
            key={`${item.type}-${idx}`}
            style={[
              styles.item,
              item.status === 'failed'  && styles.itemFailed,
              item.status === 'partial' && styles.itemPartial,
            ]}
          >
            {/* Friendly status + destination */}
            <Text
              style={[
                styles.itemType,
                item.status === 'failed'  && styles.itemTypeFailed,
                item.status === 'partial' && styles.itemTypePartial,
              ]}
            >
              {isUndone ? 'Removed' : itemHeaderLabel(item)}
            </Text>

            {/* Title */}
            <Text style={styles.itemTitle}>
              {item.type === 'recurring_add' ? stripEmoji(item.title) : item.title}
            </Text>

            {/* Detail — hidden once removed; the reversal is the message */}
            {!isUndone && (
              <Text
                style={[
                  styles.itemDetail,
                  item.status === 'failed'  && styles.itemDetailFailed,
                  item.status === 'partial' && styles.itemDetailPartial,
                ]}
              >
                {item.detail}
              </Text>
            )}

            {/* Retry button — only for Apple Calendar sync failures */}
            {!isUndone && (item.status === 'partial' || item.status === 'failed') &&
              item.retryType === 'recurring_apple_sync' && (
                <Pressable
                  onPress={() => onRetryItem(item, idx)}
                  disabled={isRetrying}
                  style={[styles.retryBtn, isRetrying && styles.retryBtnRetrying]}
                  accessibilityLabel={isRetrying ? 'Retrying Apple Calendar sync' : 'Retry Apple Calendar sync'}
                  accessibilityRole="button"
                >
                  <Text style={styles.retryBtnText}>
                    {isRetrying ? 'RETRYING APPLE SYNC...' : 'RETRY APPLE SYNC'}
                  </Text>
                </Pressable>
              )}

            {/* NEX-195: one-tap JUMP (go to the surfaced item) + UNDO. */}
            {!isUndone && (showJump || showUndo) && (
              <View style={styles.actionRow}>
                {showJump && (
                  <Pressable
                    onPress={() => onJumpItem?.(item, idx)}
                    style={[styles.actionBtn, styles.jumpBtn]}
                    accessibilityLabel="Go to the item you just added"
                    accessibilityRole="button"
                  >
                    <Text style={[styles.actionBtnText, styles.jumpBtnText]}>TAKE ME THERE</Text>
                  </Pressable>
                )}
                {showUndo && (
                  <Pressable
                    onPress={() => handleUndo(item, idx)}
                    style={[styles.actionBtn, styles.undoBtn]}
                    hitSlop={tokens.icon.hitTarget.linkSlopTight}
                    accessibilityLabel="Undo. Remove the item you just added"
                    accessibilityRole="button"
                  >
                    <Text style={[styles.actionBtnText, styles.undoBtnText]}>UNDO</Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* NEX-206 (Or-3): offer a one-tap suggested time block for a bare
                time-less habit. Hidden once the habit itself is undone (the
                whole row is gone) and once the time-block is reverted. */}
            {(() => {
              if (isUndone || !item.suggestTimeBlock) return null;
              const offer = offers[item.key] ?? initialOfferState(null);
              const suggested = item.suggestTimeBlock.suggestedBlock;
              if (offer.phase === 'reverted') return null;
              if (offer.phase === 'accepted') {
                // The reducer guarantees `block` is non-null in `accepted`;
                // fall back to the suggested block so a future invariant break
                // can never render "Set to s." (Greptile #192).
                const acceptedBlock = offer.block ?? suggested;
                return (
                  <View style={styles.offerBlock}>
                    <Text style={styles.offerConfirm}>Set to {acceptedBlock}s.</Text>
                    <Pressable
                      onPress={() => handleUndoTimeBlock(item)}
                      style={[styles.actionBtn, styles.undoBtn]}
                      hitSlop={tokens.icon.hitTarget.linkSlopTight}
                      accessibilityLabel="Undo the time you just set"
                      accessibilityRole="button"
                    >
                      <Text style={[styles.actionBtnText, styles.undoBtnText]}>UNDO TIME</Text>
                    </Pressable>
                  </View>
                );
              }
              const busy = offer.phase === 'accepting';
              return (
                <View style={styles.offerBlock}>
                  <Text style={styles.offerPrompt}>
                    {offer.error
                      ? 'Calendar was unavailable. Tap a time to try again.'
                      : `Suggested: ${blockTitle(suggested)}.`}
                  </Text>
                  <View style={styles.offerChips}>
                    {orderedBlocks(suggested).map((b) => {
                      const isPrimary = b === suggested;
                      return (
                        <Pressable
                          key={b}
                          onPress={() => handleAcceptTimeBlock(item, b)}
                          disabled={busy}
                          style={[
                            styles.blockChip,
                            isPrimary && styles.blockChipPrimary,
                            busy && styles.blockChipDisabled,
                          ]}
                          accessibilityLabel={`Set this habit to ${b}`}
                          accessibilityRole="button"
                        >
                          <Text
                            style={[styles.blockChipText, isPrimary && styles.blockChipTextPrimary]}
                          >
                            {blockTitle(b)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })()}

            {/* NEX-210 (C-5): offer to break a vague/large inbox capture into
                steps. Offer-only (never auto-breaks); gated on the accept handler
                so the Home ledger (no handler) stays out — its offer is a
                follow-up. Hidden once the capture itself is undone. The original
                capture is left in place; accept lands N inbox one-offs. */}
            {(() => {
              if (isUndone || !item.suggestBreakdown || !onAcceptBreakdown) return null;
              if (item.status !== 'success') return null;
              const bd = breakdowns[item.key] ?? initialBreakdownOfferState();
              if (bd.phase === 'reverted') return null;
              if (bd.phase === 'generated') {
                return (
                  <View style={styles.offerBlock}>
                    <Text style={styles.offerConfirm}>{breakdownCountLine(bd.stepIds.length)}</Text>
                    <Pressable
                      onPress={() => handleUndoBreakdown(item)}
                      style={[styles.actionBtn, styles.undoBtn]}
                      hitSlop={tokens.icon.hitTarget.linkSlopTight}
                      accessibilityLabel="Undo. Remove the steps you just added"
                      accessibilityRole="button"
                    >
                      <Text style={[styles.actionBtnText, styles.undoBtnText]}>UNDO STEPS</Text>
                    </Pressable>
                  </View>
                );
              }
              const busy = bd.phase === 'generating';
              return (
                <View style={styles.offerBlock}>
                  <Text style={styles.offerPrompt}>
                    {busy
                      ? 'Breaking it down.'
                      : bd.error
                        ? "Couldn't break that down. Tap to try again."
                        : 'Break this into steps?'}
                  </Text>
                  <View style={styles.offerChips}>
                    {GRAIN_ORDER.map((g) => {
                      const isPrimary = g === breakdownGrain;
                      return (
                        <Pressable
                          key={g}
                          onPress={() => handleGenerateBreakdown(item, g)}
                          disabled={busy}
                          style={[
                            styles.blockChip,
                            isPrimary && styles.blockChipPrimary,
                            busy && styles.blockChipDisabled,
                          ]}
                          accessibilityLabel={`Break into ${GRAIN_LABELS[g].toLowerCase()} steps`}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: busy }}
                        >
                          <Text
                            style={[styles.blockChipText, isPrimary && styles.blockChipTextPrimary]}
                          >
                            {GRAIN_LABELS[g]}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })()}

            {/* NEX-259 (N-2): opt-in "keep nudging" for a timed reminder. Its own
                component so it subscribes to ONLY this row's dueDate/keepNudging
                primitives (not the whole inbox array) — the ledger doesn't
                re-render on an unrelated inbox write (e.g. Apple sync) in its 4s
                window. Works from both the Orb and Home ledgers (reads the store). */}
            {!isUndone && item.surface === 'inbox' && item.entityId && (
              <KeepNudgingToggle entityId={item.entityId} />
            )}
          </View>
        );
      })}
    </MotiView>
  );
}

// ─── Keep-nudging toggle (NEX-259 N-2) ─────────────────────────────────────────
// Per-row so it subscribes to ONLY this reminder's dueDate/keepNudging PRIMITIVES
// (zustand Object.is) — an unrelated inbox write (Apple sync, another task) won't
// re-render it or the parent ledger. Shows only for a timed reminder (a dueDate
// is present); a date-only reminder qualifies, an undated inbox_add does not.
function KeepNudgingToggle({ entityId }: { entityId: string }) {
  const dueDate = useAppState((s) => s.inbox.find((t) => t.id === entityId)?.dueDate);
  const on = useAppState((s) => !!s.inbox.find((t) => t.id === entityId)?.keepNudging);
  const setInboxKeepNudging = useAppState((s) => s.setInboxKeepNudging);
  if (!dueDate) return null; // only a timed reminder can keep nudging
  return (
    <Pressable
      onPress={() => {
        setInboxKeepNudging(entityId, !on);
        haptic('buttonSecondary');
      }}
      style={styles.offerBlock}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Keep nudging until done"
      accessibilityHint={
        on ? 'Double tap to stop the gentle nudges' : 'Double tap to keep nudging until done'
      }
    >
      <Text style={styles.offerPrompt}>
        {on ? 'Keeping nudging until done.' : 'Keep nudging until done?'}
      </Text>
    </Pressable>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

// FIXME(nex-56): ledger-status palette — 3 semantic states (success/partial/failed),
// each with text + border + background tonal variants. Total of ~12 distinct hex
// values (green/yellow/red base + dark-tint variants for backgrounds and borders).
// Design review needed (CLAUDE.md doesn't define a ledger-status color system).
// Reviewing this palette piecewise is worse than reviewing it whole — surface-pass
// ticket should propose ledger.statusSuccess/Partial/Failed (+ Bg + Border variants)
// tokens. Precedent: orb state palette in tabs/index.tsx, inbox status palette,
// align mandate category palette, command-review confidence palette.
// Per-site FIXMEs below satisfy the canonical 3-line proximity gate.
const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: tokens.color.surface,
    borderRadius: 24,
    padding: 20 /* FIXME(nex-56): off-scale spacing 20 — review */,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    marginTop: 18 /* FIXME(nex-56): off-scale spacing 18 — between md(16) and lg(24), review */,
    marginBottom: tokens.spacing.xs,
    ...ambientGlowSoft,
  },
  headerPressable: {
    marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    alignItems: 'center',
  },
  header: {
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 20,
  },
  dismissHint: {
    // FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review
    color: tokens.color.textDisabled,
    // FIXME(nex-56): off-scale fontSize 8, design review
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.8,
    marginTop: 6 /* FIXME(nex-56): off-scale spacing 6 — review */,
  },

  // Item base
  // Note: 111 close to surface (111113, delta 1 digit, established precedent)
  item: {
    backgroundColor: tokens.color.surface,
    borderRadius: 12,
    borderWidth: 1,
    // FIXME(nex-56): ledger-palette success-tint border (green-dark) — see palette block above
    borderColor: tokens.color.tealWash,
    padding: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
  },
  itemFailed: {
    // FIXME(nex-56): ledger-palette failed-tint border (red-dark) — see palette block above
    borderColor: 'rgba(229,91,69,0.35)',
    // FIXME(nex-56): ledger-palette failed-tint background (red-dark) — see palette block above
    backgroundColor: 'rgba(229,91,69,0.10)',
  },
  itemPartial: {
    // FIXME(nex-56): ledger-palette partial-tint border (yellow-dark) — see palette block above
    borderColor: 'rgba(229,186,110,0.35)',
    // FIXME(nex-56): ledger-palette partial-tint background (yellow-dark) — see palette block above
    backgroundColor: tokens.color.goldWash,
  },

  // Type label
  itemType: {
    // FIXME(nex-56): ledger-palette success-text (green) — see palette block above
    color: tokens.color.teal,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 5 /* FIXME(nex-56): off-scale spacing 5 — review */,
  },
  itemTypeFailed: {
    // FIXME(nex-56): ledger-palette failed-text (red) — see palette block above
    color: tokens.color.stateError,
  },
  itemTypePartial: {
    // FIXME(nex-56): ledger-palette partial-text (yellow) — see palette block above
    color: tokens.color.gold,
  },

  // Title
  itemTitle: {
    // FIXME(nex-56): tokens.color.text off-scale neutral white — design review
    color: tokens.color.text,
    // FIXME(nex-56): fontSize 13 matches caption size but fontWeight '700' ≠ token '500' — design review
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */,
  },

  // Detail
  itemDetail: {
    color: tokens.color.textMuted,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    lineHeight: 16,
  },
  itemDetailFailed: {
    // FIXME(nex-56): ledger-palette failed-detail-text (red-tonal-variant) — see palette block above
    color: tokens.color.stateError,
  },
  itemDetailPartial: {
    // FIXME(nex-56): ledger-palette partial-detail-text (yellow-tonal-variant) — see palette block above
    color: tokens.color.goldBright,
  },

  // Retry button
  retryBtn: {
    marginTop: tokens.spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.gold,
    // FIXME(nex-56): tokens.color.goldWash gold-dark tint background, no token — design review
    backgroundColor: tokens.color.goldWash,
  },
  retryBtnRetrying: {
    // FIXME(nex-56): tokens.color.goldWash gold-dark tint (retrying state, slightly brighter), no token — design review
    backgroundColor: tokens.color.goldWash,
    opacity: 0.7,
  },
  retryBtnText: {
    color: tokens.color.gold,
    // FIXME(nex-56): off-scale fontSize 10, design review
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.4,
  },

  // NEX-195: jump + undo action row on a captured item.
  actionRow: {
    flexDirection: 'row',
    marginTop: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  actionBtn: {
    paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — matches retryBtn */,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — matches retryBtn */,
    borderRadius: 999,
    borderWidth: 1,
  },
  actionBtnText: {
    // FIXME(nex-56): off-scale fontSize 10 — matches retryBtnText
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  // JUMP — teal sacred-active (§4.5): the primary "take me there" move.
  jumpBtn: {
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.tealWash,
  },
  jumpBtnText: {
    color: tokens.color.teal,
  },
  // UNDO — quiet neutral outline; a reversal, not an accent (§4 white carries neutral).
  undoBtn: {
    borderColor: tokens.color.luminousEdge,
    backgroundColor: 'transparent',
  },
  undoBtnText: {
    color: tokens.color.textSecondary,
  },

  // NEX-206 (Or-3): time-block offer row.
  offerBlock: {
    marginTop: tokens.spacing.sm,
  },
  offerPrompt: {
    color: tokens.color.textSecondary,
    // FIXME(nex-56): off-scale fontSize 11 — matches itemDetail, design review
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 8 /* FIXME(nex-56): off-scale spacing 8 — review */,
  },
  offerConfirm: {
    // Teal sacred-active (§4.5): a completed/applied state, like a check.
    color: tokens.color.teal,
    // FIXME(nex-56): off-scale fontSize 11 — matches itemDetail, design review
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 8 /* FIXME(nex-56): off-scale spacing 8 — review */,
  },
  offerChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.xs,
  },
  // Alternate blocks: quiet neutral outline (white carries neutral, §4).
  blockChip: {
    paddingVertical: 8 /* FIXME(nex-56): off-scale spacing 8 — review */,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — matches retryBtn */,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    backgroundColor: 'transparent',
  },
  // Primary (current daypart): teal sacred-active — the suggested one-tap path.
  blockChipPrimary: {
    borderColor: tokens.color.teal,
    backgroundColor: tokens.color.tealWash,
  },
  blockChipDisabled: {
    opacity: 0.5,
  },
  blockChipText: {
    color: tokens.color.textSecondary,
    // FIXME(nex-56): off-scale fontSize 11 — design review
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  blockChipTextPrimary: {
    color: tokens.color.teal,
  },
});
