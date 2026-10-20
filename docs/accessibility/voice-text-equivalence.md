# Voice → Text Equivalence

**Status:** Active · **Ticket:** NEX-229 (part of NEX-216) · **Rule source:** CLAUDE.md §1.5 Law D, §17, UF-01 §2.6/§3.3

## The rule

**No capture or command surface ships voice-only.** Every action reachable by voice (the Eye / orb, journals, reflections, mandate work) has a **visible text/tap path to the same outcome** — for a noisy room, a speech disability, a privacy-sensitive moment, or simply "can't speak right now." A denied or failed microphone must route to that text path, never to a dead end. Accessibility is a *gating* friendliness floor (a feature scoring <3 on accessibility caps overall at 2), and an unrecoverable mistake caps the score regardless of polish.

## Equivalence map

| Voice action | Text/tap equivalent | File |
|---|---|---|
| Command / Eye capture + commands | `TextInput` manual-entry fallback (mic-denied + always-available) | `app/(tabs)/index.tsx` |
| Evening reflection | `TextInput` fallback | `src/features/onboarding/reflection-flow.tsx` |
| Mandate "Strengthen" (voice) | `TextInput` fallback | `app/mandate/[id].tsx` |
| Horizon review (voice) | `TextInput` fallback | `src/features/home/horizon-review.tsx` |
| Onboarding first invocation / first win | `TextInput` fallback (canonical mic-denied pattern) | `src/features/onboarding/first-win-capture.tsx` |
| **Voice journal** (record → AI reflection → actions) | **"Type instead" `TextInput` → same `analyze()` pipeline** (always-available; mic-deny and empty transcription route here) | `src/features/voice/voice-journal.tsx` |

## Implementation notes

- The text path feeds the **same downstream pipeline** as voice (AI reflection + action execution), so outcomes are identical — only the input source differs. Prompts are source-neutral (typed input is never described to the model as "spoken").
- Mic-denied and empty/failed transcription **route to the text path**, never to a dead-end alert.
- The typed submit is disabled on empty input and while processing; controls carry `accessibilityRole`/`accessibilityLabel`.
- AI output is parsed defensively: a malformed response shows the reflection fallback and executes **zero** actions.

When adding any new voice surface, add its row here and wire the text fallback in the same PR.
