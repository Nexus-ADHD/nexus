# TypeScript Hardening Plan — Nexus

Last updated: 2026-06-15  
Refs: Issue #5, NEX-140 (ratchet + audit)

---

## Current State

| Metric | Value |
|---|---|
| `tsconfig.json` `strict` | `false` |
| `tsconfig.json` `noImplicitAny` | `false` |
| `tsconfig.json` `strictNullChecks` | `false` |
| Files with `// @ts-nocheck` (active directives) | 15 |
| `@ts-nocheck` ratchet (NEX-140) | live — `docs/ts-nocheck-allowlist.txt` + `node scripts/check-ts-nocheck.mjs` in CI |
| Pre-existing TS errors (non-Deno) | 0 (`tsc --noEmit` green; the 15 directives opt out) |

> The count is **15** (PR A corrected the stale "21" — `notifications.ts`,
> `giving-screen.tsx`, `help-screen.tsx`, `trophies-screen.tsx` were already typed in
> PRs #14–#17; the Tier-1 PR then deleted 2 dead-code files). The live set of files allowed
> to carry `@ts-nocheck` is the committed **`docs/ts-nocheck-allowlist.txt`** — that file,
> not this prose, is the SSOT for the set; CI fails if they ever diverge.

### The ratchet (NEX-140)

`tsc --noEmit` is green *because* `@ts-nocheck` suppresses the opted-out files — so the typecheck
gate cannot notice a newly-added directive. Commit `937e1bb` (2026-03-27) exploited exactly
that: it re-added `// @ts-nocheck` to `app/_layout.tsx`, silently reverting NEX-25's win, and
nothing went red. `scripts/check-ts-nocheck.mjs` (run via `node`, wired into the required
`typecheck` CI job) closes the hole: it fails if any file carries the directive
without being on the allowlist. The list may only shrink — removing a directive means deleting
its allowlist line in the same, reviewable PR; adding one is a visible admission of new debt.

---

## Files With `@ts-nocheck`

The 15 active directives, in recommended removal order — safest first. Removing one is
**bug-surgery, not an annotation chore**: a stripped directive surfaces errors that were masked
for months (Codex's audit found `week-screen.tsx` reading a nonexistent `scheduleItems` field,
`auth-screen.tsx` calling a Supabase method absent from installed types, `_layout.tsx` passing an
unsupported PostHog prop). Fix the real error; ambiguous → `unknown` + a type guard, never a new
`as any`. A fix that adds a field or changes a value is a behavior change needing its own ticket.

### Tier 1 — leaf / display (do next)

| File | Risk | Notes |
|---|---|---|
| `src/features/orbit/EventDetailSheet.tsx` | Low–Med | Calendar reads |
| `src/features/orbit/ScheduleEditModal.tsx` | Low–Med | Calendar mutation |

> **Deleted as dead code (Tier-1 PR):** `src/features/week/week-screen.tsx` (orphaned stub superseded by `ThisWeekScreen`; read a nonexistent `scheduleItems` field — would have crashed if ever rendered) and `components/parallax-scroll-view.tsx` (unused Expo starter-template component, imported nowhere). Both removed entirely rather than typed.

### Tier 2 — moderate; one (or a few) per PR

| File | Risk | Notes |
|---|---|---|
| `src/features/voice/voice-journal.tsx` | Medium | Audio recording + AI |
| `src/features/talk/talk-screen.tsx` | Medium | AI chat + audio |
| `app/settings/apple-reminders.tsx` | Medium | EventKit / reminders |
| `src/features/auth/auth-screen.tsx` | Medium | Supabase auth; `linkIdentityWithIdToken` missing from installed types |
| `src/features/reminders/triage-flow.tsx` | Medium | First-connect triage modal |
| `src/features/paywall/paywall-screen.tsx` | Medium | RevenueCat integration |
| `app/(tabs)/inbox.tsx` | Medium | Supabase sync + Zustand mutations |
| `app/mandate/[id].tsx` | Medium | Mandate detail screen |
| `src/features/settings/settings-screen.tsx` | Medium | RevenueCat + Supabase calls |

### Tier 3 — dedicated PRs

| File | Risk | Notes |
|---|---|---|
| `app/_layout.tsx` | High | App root, 2129 lines. Its own PR — read commit `937e1bb` first (why the directive was re-added) |

### Permanent retains (stay on the allowlist, documented)

| File | Reason |
|---|---|
| `app/(tabs)/index.tsx` | Command screen, largest file; harden only after the command module is fully extracted (rule #3). Execution orchestration left it 2026-09-02 (`src/features/command/use-command-executor.ts`, typed); voice/audio flows and AI prompt building remain |
| `app/(tabs)/orbit.tsx` | 2797 lines, calendar-sync entanglement; intentionally retained |
| `src/features/home/horizon-review.tsx` | Owned by NEX-163 (Design-the-Week); removing here collides |

> Files the old tables listed that are already typed and **no longer carry the directive**:
> `notifications.ts`, `giving-screen.tsx`, `help-screen.tsx`, `trophies-screen.tsx`,
> `comeback-screen.tsx`, `onboarding-tooltip.tsx`, `orbit/OrbitManualAddSheet.tsx`.

---

## Command Module (`src/features/command/`) — Current Health

All 7 files are **fully typed with zero `@ts-nocheck`**. This is the healthiest module in the codebase.

| File | `any` | `@ts-nocheck` | Lint warnings | Notes |
|---|---|---|---|---|
| `command-types.ts` | 0 | No | 0 | Clean |
| `command-parser.ts` | 0 | No | 0 | Clean |
| `command-examples.ts` | 0 | No | 0 | Clean |
| `command-labels.ts` | 0 | No | 0 | Clean |
| `command-review-card.tsx` | 0 | No | 0 | Fixed in this PR (removed 3 unused imports) |
| `command-executor.ts` | 0 | No | 0 | Clean; `as unknown as Record<string,unknown>` cast is intentional (AI JSON narrowing) |
| `command-execution-ledger.tsx` | 0 | No | 0 | Clean |

---

## Pre-existing Lint Errors (not introduced by this PR)

30 errors and 101 warnings exist across 23 files unrelated to the command module.  
Representative sample:

| Category | Example location | Rule |
|---|---|---|
| Unescaped HTML entities | `src/features/home/horizon-review.tsx:189` | `react/no-unescaped-entities` |
| Unused variables | Various `@ts-nocheck` files | `@typescript-eslint/no-unused-vars` |
| `require()` style imports | `src/widgets/watch-bridge.ts` | `@typescript-eslint/no-require-imports` |

These are **not introduced or changed by this PR**.

---

## Pre-existing TypeScript Errors

| File | Error | Root cause |
|---|---|---|
| `supabase/functions/weekly-summary/index.ts` | TS2307, TS2304 | Deno edge function with `deno.land` URL import — not part of React Native build, not fixable without Deno-specific tsconfig |

---

## Rules for Future Hardening PRs

1. **Never enable global `strict: true` in one PR.** Enable `strictNullChecks` first (separate PR), validate, then consider `noImplicitAny`.
2. **One `@ts-nocheck` removal per PR** for Tier 2+ files. Small focused commits are easier to revert.
3. **Never remove `@ts-nocheck` from `app/(tabs)/index.tsx`** until: (a) command execution logic is fully extracted, (b) voice/audio flows are typed, (c) AI prompt building is extracted.
4. **Do not fix pre-existing lint errors in unrelated files** in a hardening PR — always document them instead.
5. **Zero new `any`** in new code. Use `unknown` + type guards instead.
6. **Prop types must be exported** for all feature-level components so they can be referenced from screens without importing implementation details.

---

## Next Steps (NEX-140)

- [x] **Lock the gate** — `@ts-nocheck` ratchet (`docs/ts-nocheck-allowlist.txt` + `node scripts/check-ts-nocheck.mjs`, wired into the required `typecheck` CI job). Closes the `937e1bb` regression class. *(this PR)*
- [x] Reconcile this doc to the true count (17, was wrongly 21).
- [x] Tier-1: deleted `week-screen.tsx` + `parallax-scroll-view.tsx` as dead code.
- [ ] **NEX-175** — orbit detail/edit sheets (`EventDetailSheet.tsx`, `ScheduleEditModal.tsx`).
- [ ] **NEX-176** — Tier-2 feature screens, one per PR (`auth`, `paywall`, `settings`, `inbox`, `mandate`, `apple-reminders`, `talk`, `voice`, `triage-flow`).
- [ ] **NEX-177** — `app/_layout.tsx`, dedicated PR; read commit `937e1bb` first.
- [ ] Enable `strictNullChecks: true` (separate, larger lift — its own ticket).

> **NEX-140 (the umbrella) is closed.** Its deliverable — the ratchet + audit + reconciled doc + documented exceptions — is shipped (PRs #128/#129). Every remaining `@ts-nocheck` is now justified: 3 permanent retains, or tracked under NEX-175/176/177. The count is structurally one-way from here.

As each directive is removed, **delete its line from `docs/ts-nocheck-allowlist.txt` in the same PR** (the ratchet enforces this).

---

## Notes: Giving Screen (`src/features/giving/giving-screen.tsx`)

The screen was a stub that referenced `givingEntries` and `giftedProducts` on the Zustand store — neither field exists in `AppState`. The `@ts-nocheck` was suppressing the type error on `useAppState()`. Fix: removed the broken `useAppState()` destructure, added local `GivingEntry` and `GiftedProduct` interfaces, and used empty-array fallbacks with a TODO comment. The UI renders identically. **Store wiring is deferred until the Giving feature is implemented.**

---

## Notes: Expo Notifications Type Quirks

The installed Expo Notifications SDK (v51+) changed `NotificationBehavior`:

| Field | Status |
|---|---|
| `shouldShowAlert` | Deprecated — kept for backward compat |
| `shouldShowBanner` | Required in SDK 51+ |
| `shouldShowList` | Required in SDK 51+ |

When removing `@ts-nocheck` from `notifications.ts`, `setNotificationHandler`'s return type failed until `shouldShowBanner: true` and `shouldShowList: true` were added. These fields mirror the old `shouldShowAlert: true` — **zero behavior change** on devices already running SDK 51+.
