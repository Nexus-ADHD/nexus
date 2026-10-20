/**
 * Pure decision: does this action's voice-capture result get
 * mirrored to Apple Reminders? Lifted out of the executor so the
 * decision matrix is unit-testable without spinning up Zustand or
 * EventKit.
 *
 * Phase 4 mirrors only `inbox_add` and `todo_add`. Calendar /
 * recurring / align actions belong on different surfaces and
 * mirroring would create surface-confusion duplicates.
 *
 * Even when the action type is mirror-eligible, mirror requires
 * an active Apple Reminders connection AND a Nexus list to
 * deposit into. Anything missing → no mirror, no error.
 */

export type MirrorableActionType = 'inbox_add' | 'todo_add';

const MIRRORABLE_TYPES: ReadonlySet<string> = new Set<string>([
  'inbox_add',
  'todo_add',
]);

export function shouldMirrorAction(
  action: { type: string } | null | undefined,
  isConnected: boolean,
  nexusListId: string | null | undefined,
): boolean {
  if (!action || typeof action.type !== 'string') return false;
  if (!MIRRORABLE_TYPES.has(action.type)) return false;
  if (!isConnected) return false;
  if (!nexusListId) return false;
  return true;
}

/**
 * Pure: builds the mirror payload for a given action, stripping
 * fields the action type isn't supposed to carry. Critical defense
 * against the AI hallucinating dates on inbox_add: even if the
 * model emits dateStr/time/startISO, this helper drops them by
 * omission. inbox_add by definition has no schedule.
 *
 * Returns null for action types that don't mirror — caller treats
 * null as "skip mirror," same as shouldMirrorAction === false.
 */
export interface MirrorPayload {
  title: string;
  dueDate?: string;
  notes?: string;
}

export function buildMirrorPayload(
  action: any,
): MirrorPayload | null {
  if (!action || typeof action.type !== 'string') return null;
  const title = String(action.title ?? '').trim();
  if (!title) return null;
  switch (action.type) {
    case 'inbox_add':
      // No date/time fields — even if the model invented them.
      return { title };
    case 'todo_add': {
      const dateStr = typeof action.dateStr === 'string' ? action.dateStr : '';
      if (!dateStr) return { title };
      const time = action.time && /^\d{2}:\d{2}$/.test(action.time)
        ? action.time
        : null;
      return {
        title,
        dueDate: time ? `${dateStr}T${time}:00` : dateStr,
      };
    }
    default:
      return null;
  }
}
