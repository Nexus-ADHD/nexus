/**
 * Command feature — shared type re-exports and constants.
 *
 * Centralises the allowed action types and the ALLOWED_TYPES guard set so
 * every consumer imports from one place instead of duplicating them.
 */

import {
  ProposedActionType,
  ProposedAction,
  normalizeProposedAction,
} from '../../utils/recurrence';

/** The action types the command parser is permitted to emit. */
export const ALLOWED_TYPES = new Set<ProposedActionType>([
  'calendar_add',
  'inbox_add',
  'align',
  'recurring_add',
  'todo_add',
  'recurring_todo_add',
]);

// Re-export so callers only need one import.
export type { ProposedActionType, ProposedAction };
export { normalizeProposedAction };

/**
 * Type guard: value is a plain, non-array object record.
 * Shared across parser helpers to validate AI response shapes.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
