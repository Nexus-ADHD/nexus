/**
 * NEX-185 shared weekly-broadcast content + scheduling math.
 *
 * Single source of truth for the 12-week rotating value content AND the
 * per-user week / ISO-week-key math, imported by BOTH channels:
 *   - weekly-broadcast/index.ts  → email (uses `subject` + `body` + buildHtml)
 *   - the inline SMS parity pass  → SMS   (uses `sms`, wrapped by emailToSms)
 *
 * Keeping content + week-math in one module is what prevents the two channels
 * from drifting. `buildHtml` and the eligible-profile query stay in
 * weekly-broadcast (email-specific).
 *
 * The `body` essays are unchanged from the original weekly-broadcast WEEKS array
 * (verified by snapshot test). Each `sms` line is a purpose-written, tightened
 * ≤2-GSM-7-segment version following the Nexus voice rules (no em dashes, no
 * exclamation points, declarative endings) — the SMS adapter (emailToSms) adds
 * the `Nexus: ` prefix and ` Reply STOP to unsubscribe.` suffix at send time, so
 * these strings carry the message body only.
 */

export interface WeekContent {
  index: number;
  subject: string;
  body: string;
  sms: string;
}

export const WEEKS: WeekContent[] = [
  {
    index: 1,
    subject: 'The score is a measurement, not a verdict.',
    body: `Hey {firstName},

The score on Home is a measurement. It is not a verdict.

A low day tells you which habit slipped. A high day tells you which patterns are holding. Neither is a grade. Both are signal.

A 2009 study from University College London — Phillippa Lally and colleagues — found the average new habit takes 66 days to feel automatic. Not 21, as the popular myth goes. Sixty-six. If the number is moving slowly, that's not failure. That's the timeline.

One thing for this week: open Home once a day. Look at the number. Don't fix it. Notice it.

If anything in the app feels off, reply to this email. I read every one.

— Circle of Light`,
    sms: 'The score on Home is a measurement, not a verdict. A low day shows which habit slipped. A high day shows which patterns hold. This week, open Home once a day. Notice the number. Do not fix it.',
  },
  {
    index: 2,
    subject: 'The work is subtraction.',
    body: `Hey {firstName},

The work is not acquisition. You don't need another book about discipline. You don't need a system that grades you harder.

The work is subtraction.

Antoine de Saint-Exupéry: "Perfection is finally attained not when there is no longer anything to add, but when there is no longer anything to take away."

A habit, done seven days in a row, is a piece of evidence about who you are. A habit done once, then never again, is a story you told yourself. Nexus is just the place where the evidence accumulates.

You are not behind. You are not insufficient.

If something in the app isn't serving you, write back.

— Circle of Light`,
    sms: 'The work is not acquisition. It is subtraction. A habit done seven days running is evidence of who you are. Done once, it is a story. This week, take one thing away.',
  },
  {
    index: 3,
    subject: 'The hardest day is the second Tuesday.',
    body: `Hey {firstName},

The hardest part of any practice is on the second Tuesday.

Day one is novelty. Day three is momentum. The first week tells you nothing — anyone can do something for seven days. The second Tuesday is the day the practice has stopped feeling new and hasn't yet started feeling like who you are.

Decades of behavior research point to one variable that predicts whether a new habit lasts: whether the behavior gets done badly, on a hard day, and still gets done. Not whether it gets done well on a good day.

If you've been at this for two weeks, you're past the hardest part already.

Reply if you want to talk through where you're stuck.

— Circle of Light`,
    sms: 'The hardest day of any practice is the second Tuesday, when it has stopped feeling new and does not yet feel like you. If you are two weeks in, the hardest part is behind you.',
  },
  {
    index: 4,
    subject: "What's working, what isn't.",
    body: `Hey {firstName},

This is the part of the email where most apps would ask you to do something. Add a habit. Set a goal. Open a paywall.

This one isn't doing that.

There's a line often credited to Peter Drucker: what gets measured gets managed. The deeper version, less quoted, is that what gets noticed gets named, and what gets named gets changed.

If Nexus is working for you, that's all I need to know. Keep going. If it isn't, tell me where it's breaking. The app gets better when the people using it tell me how.

Reply if you want to talk through your practice. I'm one person. I'll write back.

— Circle of Light`,
    sms: 'Most apps would ask you to do something here. This one will not. If Nexus is working, keep going. If it is not, reply and tell me where it breaks. The app gets better when you do.',
  },
  {
    index: 5,
    subject: "You aren't trying to reach something.",
    body: `Hey {firstName},

You aren't trying to reach something. You're trying to become someone.

James Clear writes that the goal isn't to run a marathon, it's to become a runner. The marathon is a side effect of being the kind of person who runs. The goal is the identity.

When you log a habit in Nexus, you're not crossing something off. You're casting a vote. The score on Home is the running count of votes for the version of yourself you said you wanted to be.

One question for this week: who is the person on the other side of these habits? Name them. Specifically. The clearer you can see them, the easier the work gets.

Reply if you want to think this through.

— Circle of Light`,
    sms: 'You are not trying to reach something. You are trying to become someone. Every habit you log is a vote for that person. This week, name them. The clearer you see them, the easier the work.',
  },
  {
    index: 6,
    subject: "The slowest math you'll ever do.",
    body: `Hey {firstName},

A 1% improvement, daily, for a year, is a 37x improvement. The math is right. The math is also not the point.

The math is the cover story. The real thing is this: a small thing, done daily, compounds in ways you cannot feel from inside the practice. The compounding happens to you, not for you.

Anders Ericsson spent forty years studying elite performers across domains — musicians, chess players, surgeons, athletes. The one variable that mattered everywhere was deliberate practice performed alone, without an audience. The audience comes later, if it comes at all.

Your habits don't have an audience. That's the point.

If you want to talk through which habits to keep and which to cut, write back.

— Circle of Light`,
    sms: 'A small thing done daily compounds in ways you cannot feel from inside the practice. It happens to you, not for you. Your habits have no audience. That is the point.',
  },
  {
    index: 7,
    subject: 'Show up small.',
    body: `Hey {firstName},

The person who works out for two hours on Sunday and skips the rest of the week is not in better shape than the person who walks fifteen minutes a day. Their nervous system never gets the signal that this is who they are.

Consistency beats intensity. The research across behavior change domains — exercise, study, recovery, meditation — is consistent: long-term success correlates with frequency, not with size.

If you have an ambitious habit that keeps falling off, shrink it. By half. Then by half again. Make it so small that skipping it would be more embarrassing than doing it.

Reply if you want help shrinking one.

— Circle of Light`,
    sms: 'Consistency beats intensity. Fifteen minutes daily beats two hours on Sunday. If a habit keeps falling off, shrink it by half, then half again, until skipping feels harder than doing it.',
  },
  {
    index: 8,
    subject: "You don't have to keep them all.",
    body: `Hey {firstName},

The most underused button in Nexus is the one that removes a habit.

People add habits. They rarely subtract. A practice you set up two months ago, that no longer fits the life you're living now, is a tax on every other practice you're trying to do. The streak doesn't deserve loyalty if the habit doesn't serve you.

Marcus Aurelius kept a private notebook that survived him. The thread that runs through it is unsentimental: ask of everything you do, is this essential? If not, set it down.

Pull up Mandates this week. Look at each one. Is this still the work? If not, retire it. The version of you you're trying to become will not be offended.

Reply if you want to talk through what to cut.

— Circle of Light`,
    sms: 'The most underused button in Nexus is the one that removes a habit. A practice that no longer fits is a tax on the rest. This week, open Mandates and retire one that is done.',
  },
  {
    index: 9,
    subject: 'What gets your attention gets your life.',
    body: `Hey {firstName},

Annie Dillard: "How we spend our days is, of course, how we spend our lives."

The reason habits matter — actually matter, not as a productivity meme — is that your attention is the only thing you trade with. Every habit you keep is an attention contract you signed with yourself.

Nexus is not a productivity app. It's an attention ledger. The score is just the running balance.

This week: pick one habit and pay closer attention to it. Not to whether you did it, but to what happens before and after. The before tells you what triggers it. The after tells you what it gives you. That's the data the app can't show you.

Write back if you find something interesting.

— Circle of Light`,
    sms: 'How you spend your days is how you spend your life. Nexus is not a productivity app. It is an attention ledger. This week, pick one habit and notice what happens before and after it.',
  },
  {
    index: 10,
    subject: 'One missed day is one missed day.',
    body: `Hey {firstName},

One missed day is one missed day. It is not a referendum on your character. It is not the start of a slide. It is a Tuesday where something didn't happen.

The research on habit formation is consistent on this: a single missed day does not predict whether a habit lasts. The thing that breaks habits is not the skipped day. It is the story you tell yourself about the skipped day.

If you've missed something this week, the move is not to make up for it. The move is to do the next one.

Reply if the inner critic is loud right now. I get it.

— Circle of Light`,
    sms: 'One missed day is one missed day. Not a verdict, not a slide. What breaks a habit is the story you tell about the miss, not the miss itself. If you slipped this week, just do the next one.',
  },
  {
    index: 11,
    subject: "You can't fix what you can't see.",
    body: `Hey {firstName},

Most people overestimate what they're doing and underestimate what they're not. The gap closes when you start writing it down.

A 2008 Kaiser Permanente study on weight loss — Hollis and colleagues, published in the American Journal of Preventive Medicine — found one variable that doubled outcomes across every demographic they tracked: keeping a daily log. Not what was in the log. Not how detailed it was. The act of writing it down.

This is the part of Nexus that's easy to dismiss. Logging a habit feels like clerical work. It isn't. The log is the practice. Without it, the habit is a mood. With it, the habit is data.

This week: log one thing you've been doing unofficially. Make it official.

Reply if you want to talk about what to track.

— Circle of Light`,
    sms: 'Most people overestimate what they do and underestimate what they skip. Writing it down closes the gap. The log is the practice. This week, log one thing you have been doing unofficially.',
  },
  {
    index: 12,
    subject: 'A year from now.',
    body: `Hey {firstName},

A year from now, you will either be one year of consistent practice deeper into the person you're becoming, or you will be one year of stories about why this year didn't count.

Both years take the same amount of time.

William James, the father of American psychology, wrote in 1890: "We are spinning our own fates, good or evil, and never to be undone. Every smallest stroke of virtue or of vice leaves its never so little scar."

The science has refined this language over a hundred and thirty years. The premise hasn't changed.

If you've been at this for twelve weeks, you're past the test most people fail. The rest is just continuing.

If something has clicked for you in this practice, write back. I'd love to hear it.

— Circle of Light`,
    sms: 'A year from now you will be one year deeper into who you are becoming, or one year of reasons it did not count. Both take the same time. If you are twelve weeks in, the rest is just continuing.',
  },
];

export function getFirstName(name: string | null): string {
  return (name ?? '').split(' ')[0] || 'there';
}

export function weeksSinceTrialStart(trialStartIso: string, now: Date): number {
  const start = new Date(trialStartIso).getTime();
  const days = (now.getTime() - start) / (1000 * 60 * 60 * 24);
  return Math.floor(days / 7);
}

export function pickWeekContent(weeksSince: number): WeekContent {
  const idx = (((weeksSince - 1) % WEEKS.length) + WEEKS.length) % WEEKS.length;
  return WEEKS[idx];
}

export function currentBroadcastKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `weekly_broadcast_${d.getUTCFullYear()}_W${String(weekNum).padStart(2, '0')}`;
}
