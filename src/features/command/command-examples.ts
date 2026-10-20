/**
 * Command examples.
 *
 * A static list of natural-language command samples used for onboarding
 * hints, placeholder text, and future guided UI surfaces.
 * Safe to import anywhere — no side effects, no native API calls.
 */

export interface CommandExample {
  /** Natural-language text the user could type or speak. */
  text: string;
  /** Short label describing the action category. */
  category: 'reminder' | 'habit' | 'calendar' | 'task' | 'goal';
}

export const COMMAND_EXAMPLES: CommandExample[] = [
  {
    text: 'Remind me to call Mom tomorrow',
    category: 'reminder',
  },
  {
    text: 'Block workout every weekday at 6 AM',
    category: 'habit',
  },
  {
    text: 'Add read 20 minutes as a daily habit',
    category: 'habit',
  },
  {
    text: 'Dinner with Hali Friday at 7 PM',
    category: 'calendar',
  },
  {
    text: 'Add build Nexus as a vision goal',
    category: 'goal',
  },
];

/** Plain strings — convenient for placeholder cycling or list rendering. */
export const COMMAND_EXAMPLE_TEXTS: string[] = COMMAND_EXAMPLES.map((e) => e.text);
