export type ParsedCommand =
  | { intent: 'log_habit'; habit: string }
  | { intent: 'log_giving'; amount: number; cause: string }
  | { intent: 'log_gifted_product'; quantity: number; product: string }
  | { intent: 'create_schedule_item'; title: string; time: string }
  | { intent: 'ask_what_matters_next' };

function normalizeHabit(input: string): string | null {
  const text = input.trim().toLowerCase();

  if (
    text === 'log workout' ||
    text === 'i worked out today' ||
    text === 'worked out at 7am' ||
    text === 'worked out this morning'
  ) {
    return 'workout';
  }

  if (
    text === 'meditated at 6am today' ||
    text === 'i meditated today' ||
    text === 'meditated this morning'
  ) {
    return 'meditation';
  }

  if (
    text === 'did yoga this morning' ||
    text === 'i did yoga today'
  ) {
    return 'yoga';
  }

  if (
    text === 'journaled this morning' ||
    text === 'i journaled today'
  ) {
    return 'journaling';
  }

  if (text === 'read for 20 minutes') {
    return 'reading';
  }

  return null;
}

export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim().toLowerCase();

  const habit = normalizeHabit(input);
  if (habit) {
    return { intent: 'log_habit', habit };
  }

  const donationMatch = input.match(/donated \$?(\d+)\s+to\s+(.+)/i);
  if (donationMatch) {
    return {
      intent: 'log_giving',
      amount: Number(donationMatch[1]),
      cause: donationMatch[2].trim(),
    };
  }

  const giftedMatch = input.match(/gave away (\d+)\s+(.+)/i);
  if (giftedMatch) {
    return {
      intent: 'log_gifted_product',
      quantity: Number(giftedMatch[1]),
      product: giftedMatch[2].trim(),
    };
  }

  const pickupMatch = input.match(/add (.+) tomorrow at (.+)/i);
  if (pickupMatch) {
    return {
      intent: 'create_schedule_item',
      title: pickupMatch[1].trim(),
      time: `Tomorrow at ${pickupMatch[2].trim()}`,
    };
  }

  if (text === 'what matters next?') {
    return { intent: 'ask_what_matters_next' };
  }

  return null;
}
