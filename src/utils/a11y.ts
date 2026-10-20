import { AccessibilityInfo } from 'react-native';

/**
 * Speak a message through the active screen reader (VoiceOver / TalkBack).
 *
 * A no-op when no screen reader is running, so it's safe to call
 * unconditionally at a state transition. Use this for events that happen away
 * from the focused control or that spawn new UI (processing started, a command
 * landed, a clarification appeared) — not for a control's own resting label,
 * which VoiceOver reads from `accessibilityLabel` on focus.
 *
 * Single call site for the accessibility epic so the behavior is consistent and
 * mockable.
 */
export function announce(message: string): void {
  if (!message) return;
  AccessibilityInfo.announceForAccessibility(message);
}
