import { describe, expect, it } from 'vitest';
import {
  countLinkedHabitsForPillar,
  pruneGoalHabitMapToRecurringRules,
  type GoalHabitMapLike,
  type HabitLinkRule,
} from '../mandate-habit-links';
import { normalize } from '../text';

function linkedHabitTitlesForPillar(
  pillarId: string,
  recurringRules: HabitLinkRule[],
  goalHabitMap: GoalHabitMapLike,
): string[] {
  const out: string[] = [];
  for (const rule of recurringRules) {
    const key = normalize(rule.title);
    if (!key) continue;
    const ids = goalHabitMap[key] ?? [];
    if (ids.includes(pillarId)) out.push(String(rule.title));
  }
  return out;
}

describe('countLinkedHabitsForPillar', () => {
  it('returns 0 when no recurringRule matches an orphan goalHabitMap key', () => {
    const count = countLinkedHabitsForPillar(
      'pillar-1',
      [{ title: 'Yoga' }],
      {
        'deleted yoga': ['pillar-1'],
      },
    );

    expect(count).toBe(0);
  });

  it('matches the linked habits list when computed from the same state', () => {
    const recurringRules = [
      { title: 'Yoga' },
      { title: 'Reading' },
      { title: 'Lift' },
    ];
    const goalHabitMap = {
      yoga: ['pillar-1'],
      reading: ['pillar-1', 'pillar-2'],
      lift: ['pillar-2'],
      'deleted habit': ['pillar-1'],
    };

    const linkedHabitTitles = linkedHabitTitlesForPillar(
      'pillar-1',
      recurringRules,
      goalHabitMap,
    );

    expect(countLinkedHabitsForPillar('pillar-1', recurringRules, goalHabitMap))
      .toBe(linkedHabitTitles.length);
    expect(linkedHabitTitles).toEqual(['Yoga', 'Reading']);
  });
});

describe('pruneGoalHabitMapToRecurringRules', () => {
  it('drops orphan keys and canonicalizes surviving rule-title keys', () => {
    expect(
      pruneGoalHabitMapToRecurringRules(
        {
          ' Yoga  Flow ': ['pillar-1', 'pillar-1'],
          'old habit': ['pillar-2'],
          reading: ['pillar-3'],
        },
        [{ title: 'Yoga Flow' }, { title: 'Reading' }],
      ),
    ).toEqual({
      'yoga flow': ['pillar-1'],
      reading: ['pillar-3'],
    });
  });
});
