# NEXUS — Design System Spec

**Version 3.0 · Stellar · Extracted from CLAUDE.md (2026-07).**

> This is the canonical Nexus design system. It was moved out of `CLAUDE.md` so that file (loaded on every turn) stays lean, but this doc is **authoritative** for every value and remains the single source of truth §-referenced across the codebase and tickets. Section numbers are preserved exactly, so a reference like `§4.6` or `§10.3` resolves here. Read this before any UI, component, screen, motion, material, or visual-copy work.

The behavioral guardrails that apply to EVERY task stay in `CLAUDE.md`: §1.5 (ADHD Laws), §2 (Locked Decisions), §18 (Copy & Voice), §19 (Anti-patterns), §23 (Planning Protocol), §24 (Session Memory & PR Pipeline).

---

## 0. WHAT NEXUS IS

Become the you that already exists. You know who you are. ADHD just makes it hard to stay close to it. Nexus keeps that person in front of you — and the next right thing with them. Not a better you. The one already underneath the noise.

Your operating system for becoming. A premium iOS app where identity, habits, recurring tasks, one-offs, calendar, and voice-based reflection live in one unified experience. For people with ADHD who know they're capable of more and struggle to stay close to who they are.

**Preserved wholesale from the existing app:**

- **Mandates** — identity statements ("I am someone who...") organized in three categories: Business, Vision, Personal. Load-bearing. Rarely change.
- **Habits** — tied to mandates, not standalone. Daily or scheduled repetition.
- **Recurring to-dos** — Orbit tab. Tasks that repeat on a schedule.
- **One-off to-dos** — Inbox tab. Captured items awaiting resolution.
- **Calendar integration** — real Apple Calendar, round-trip sync.
- **Voice rituals** — morning intention, evening reflection, utility commands, all through the Eye on the Command tab.
- **Alignment Score** — the daily synthesis metric, surfaced on Home.
- **5-moment onboarding ritual** — preserved, with Moment 3 (First Invocation) rewritten to use the Eye.
- **Pricing** — $14.99/mo or $99.99/yr. No ladders. No lifetime deals.
- **Research-cited copy** — Lally et al. (2010) on 66-day habit automaticity, 23-minute refocus cost, and similar references appear where they add credibility.
- **Voice and copy rules** — no em dashes, no exclamation points, declarative endings. Preserved.

**Five tabs, locked:** Home · Command · Orbit · Inbox · Align.

**What changes from the original (v1) app:**

- Manual habit pinning is replaced with automatic scheduling. The app auto-migrates existing pin patterns into schedules on first open of the new version.
- The Command tab's voice surface is replaced with the Eye — a full-screen cosmic composition (Skia + Rive).
- Every screen sits on a global cosmic backdrop — galaxy photo + 80 animated white twinkling stars — rendered behind the tab navigator. Cards float on cosmos rather than on void.
- All five tabs receive a material upgrade: **frosted-glass cards** (BlurView + translucent dark tint), luminous white hairlines, tracked-caps labels, ambient gold halos on every section block.
- The Home tab is redesigned around a ceremonial entry (alignment score + qualitative word + today's habits + today's horizon) with everything else revealed on scroll.
- The color system is **stellar** — pure white primary text + cool blue-whites for secondary + electric teal + brightened gold for earned ornament. Amber is reserved exclusively for streak milestone ceremonies (7/30/66/365 day). Phosphor green is reserved for year-milestones.
- Typography hybrid locked: Fraunces Light Italic (identity and reflection), Inter (UI), IBM Plex Mono (numerals), plus brutalist tracked-uppercase (+0.16em, 600 weight) for section labels.
- Motion language sharpens: 250ms ease on everything, except the Eye (its own living motion) and the StarField (continuous micro-scintillation + discrete flicker events per star).

---

## 1. THE AESTHETIC THESIS (LOCKED)

The visual language is governed by two images operating in tension:

**The cosmic field** (atmosphere, 95% of the app). A deep galaxy — purple and magenta nebula clouds against near-black void, scattered with pure-white twinkling stars. A sacred figure could sit in this field — crumpled paper with gold leaf, wrapped in a luminous teal ring of energy — but the figure is implied, not rendered. What's rendered is the *room they live in*: cosmic field behind every screen, frosted-glass cards holding content suspended in the field, luminous-white hairlines defining card edges, gold as the one warm accent reserved for earned moments, teal as electric-cyan sacred-active. The page reads as made of the same material as the sky.

**The Eye image** (one specific surface, 5% of the app by area but 100% of the Command tab). A cosmic eye-nebula: pure black pupil, teal-cyan iris with gold fleck striations, orange-red combustion ring, purple-pink nebula wisps, all emitting outward against warm void. This governs the Command tab alone. The Eye's radial-emissive energy is reserved for that one surface and does not leak into the rest of the app.

**The thesis in one line:**
> A sacred daily operating system where your life is suspended in a cosmic field, held in frosted glass and starlight, and your voice is received by a cosmic eye that listens and acts.

### The seven governing principles

Every design decision must serve these. If a proposed element violates one of these, it is wrong, no matter how "nice" it looks.

**1. Cosmic field, not black dark mode.** Every screen sits behind a galaxy photo with 80 animated white twinkling stars. The void color `#06060C` is the fallback that shows briefly at app launch before the StarField mounts; it is *not* the visible background. Never pure `#000000`. Never a flat dark surface.

**2. Pure white and luminous starlight, not cream and gold leaf.** Primary text is `#FFFFFF` (matches the star color, so writing and sky feel made of the same material). Secondary text is `#E8EEF6` (cool blue-white, moonlight not paper). Card hairlines are luminous white at 10%. Gold is `#E5BA6E` (brightened burnt gold) reserved for earned ornament — section action labels, accent bars on attention cards, the alignment-ring arc. **Under-5%-gold rule:** gold appears on at most 1–2 elements per screen, never as a stroke across the UI.

**3. Frosted glass, not opaque stone.** Cards are translucent dark tint (`rgba(8,10,18,0.68)`) wrapped in an iOS BlurView (intensity 25 default / 35 elevated). The cosmos peeks through every card. Luminous-white hairlines at 10% define the edge. Inset highlight glow at top (white 4%). Ambient gold halo beneath (`rgba(229,186,110,0.28)` / 36pt / +8 offset) via the shared `ambientGlow` style — never drop shadows. Carved from starlight, not laid on top of it. **(Amended 2026-08-06, owner-approved):** the halo is now two-tier — full `ambientGlow` for hero/elevated surfaces only, soft `ambientGlowSoft` for ordinary cards — so only one lit object glows per surface (§4.9).

**4. Stone doesn't bounce — except the Eye and the StarField.** Motion is 250ms ease transitions and 350ms fade+8pt rise on entry everywhere except Command and the global star field. No springs. No bounce. No overshoot. The Eye is the one living thing in the room; the StarField is the one breathing thing in the sky. Every other surface respects the stillness.

> **Home Coherence Ring exception (added 2026-05-31, by design decision; bloom updated NEX-157 2026-06-07; widened to the serpent 2026-08-15, owner-approved).** The Home alignment ring (`AlignmentScoreRing`) plays a one-time entrance — the bloom fades in and the score counts up — then settles into a slow ambient *breath*: a ~5s brightness swell on the glow, and the serpent's own undulation. This is intentional and is the ring's resting state; it borrows the StarField's "breathing thing in the sky" register rather than the Eye's living motion. It is the only sanctioned ambient motion outside the Eye and StarField. Do not remove it as a §1.4 violation. (The glow is an SVG horizon bloom hugging the arc as of NEX-157; the earlier rotating captured-halo image was retired — a radially symmetric bloom has no rotation to show.) Everything else on Home still holds perfectly still.
>
> **What the serpent's share of this exception is, exactly (2026-08-15).** A travelling wave runs down the body: each point of the authored frame is displaced along its RADIUS, amplitude **1% of the hero box**, one full wave every **7 seconds**. Nothing else about the animal moves — it does not rotate, drift, scale or glow, and its growth is still driven entirely by the score.
>
> Why it exists: the owner's standing note was *"I want it to still move like a snake would move,"* and the comparison that prompted it (Opal) has a hero that is never still. A progress indicator that is an animal and yet frozen reads as a picture of an animal.
>
> Why these numbers and not larger ones. 1% of a 260pt box is 2.6pt, about **7% of the body's own thickness** — present at a glance, invisible to a stare. The 7s period is deliberately **slower than the ~5s halo breath beside it**, so the serpent sits *under* the glow in the visual hierarchy rather than competing with it; a faster animal would make the ring's own breath read as the quieter, secondary motion, which inverts what this surface is for. Both numbers were judged on device against the Opal recording, with both dials exposed, after an earlier round in which the clock was frozen and every setting was therefore judged on a still image.
>
> Bounds that are part of the approval, not decoration:
> - **Zero under Reduce Motion**, failing *toward* stillness. `useReduceMotion()` resolves a failed read to `reduceMotion: false`, so honouring `resolved` alone is not enough — the wave stays off until a successful read confirms otherwise (§1.5 UF-01, and the LEARNINGS 2026-07-24 `rmStale` rule).
> - **Deform, never synthesise.** The wave displaces the pixels of the shipped authored frame. It may not generate body. That is the rule NEX-338 reversed ~1.5k lines to establish.
> - **The envelope never grows.** The geometry is inset by 2.1× the amplitude so the animal oscillates *inside* the silhouette it already occupies, which is why this cannot raise the §4.4 gold budget.
> - **This licenses the serpent and nothing else.** No second Home surface acquires ambient motion by pointing at this paragraph.

**5. Two type registers, held in tension.** Fraunces Light Italic for identity and reflection moments (mandate statements, alignment score qualitative word, onboarding, Daily Pulse insight, weekly focus). Inter for UI. IBM Plex Mono for numerals and data. Brutalist tracked-uppercase treatment (+0.16em, 600 weight) for section labels. No other typefaces. Ever.

**6. Teal is sacred-active, gold is earned-ornament, amber is milestone-only, white is everything else.** Four-tier accent system. Teal (`#5FE0EA`, electric cyan) for primary actions, in-progress states, completed checks, success indicators, NOW states — the voice of the app. Gold (`#E5BA6E`) for earned moments, category markers, section emphasis, attention cards — under 5% of screen. **Amber (`#F5A04A`) is retired from default utility and reserved exclusively for streak milestone ceremonies (7/30/66/365 day hits).** Galaxy already supplies its own warm combustion regions; a second warm accent on default screens fights with it. Pure white (`#FFFFFF`) carries all neutral content. Red is the warm-biased `state.error` (`#E55B45`), used only for destructive actions and validation errors. Phosphor green is reserved for year-milestones (365-day chapters) and is earned, not given.

**7. Ceremonial entry, operational depth.** Every Home open begins as a ritual (alignment score + qualitative word + today's habits). Scrolling reveals the full operating system. First impression is meditative; sustained use is powerful. Nothing is removed — everything is reordered around calm-first.

---

## 3. REFERENCE APPS (MOBBIN BENCHMARKS)

These are the execution benchmarks. They are cited throughout this document where their specific patterns inform component specs.

### Tolan
3D companion object floating in deep blue-black void. Radical minimal chrome. Single CTA pill at bottom center. Voice-reactive animation (scales with volume). Full-screen cinematic treatment of a single hero element.

**What Nexus steals:** Single-hero dominance of upper 60% of screen · one pill CTA bottom-center · voice-reactive motion (Eye scales subtly with voice input) · cinematic post-onboarding reveal of the hero.

**What Nexus does NOT copy:** Character personality / anthropomorphization · saturated magenta-purple palette · voice-primary UX for every screen.

### Opal
Photorealistic 3D opal gemstone on pedestal, lit from within. Uppercase tracked labels (FOCUS, SCREEN TIME, CULPRITS) + huge display numerals. Row-of-gemstones streak progression with poetic state names (Steadfast, Determined). Gradients appear only at milestone moments, never as background chrome. Dignified dark-first palette.

**What Nexus steals:** Tracked-uppercase micro-labels over huge display numerals · poetic state-name vocabulary for qualitative metrics · pre-rendered hero asset philosophy (though Nexus's Eye is runtime shader, not pre-rendered video) · full-bleed dark with content floating in space · 7-day trial timeline paywall pattern.

**What Nexus does NOT copy:** Mint green accent (too specifically theirs) · social/leaderboard layer · Focus Score 0-100 gamification · specific gem geometry.

### Gymshark 66
Grain-textured saturated gradient cards as the only place saturated color lives outside milestones. Huge weighted display numerals. Uppercase tracked section labels (HABITS, DAY 3 / 66). Pure black backgrounds. Tap-card-to-complete satisfaction. Partial-completion respect (2-of-3 reads as "partially complete," not failure).

**What Nexus steals:** Grain-textured gradient card technique (reserved for earned moments only) · huge weighted display numeral treatment · uppercase tracked section labels · tap-card-to-complete satisfaction (upgraded to ceremonial check animation) · partial-completion framing ("12 left, 23 total," never "you failed").

**What Nexus does NOT copy:** Pure black backgrounds (we use cool near-black `#06060C`) · generic rainbow habit-card palette (we restrict to teal + gold + white; amber is milestone-only) · fitness-app visual register.

---

## 4. COLOR SYSTEM (v3 STELLAR)

All values given as hex (sRGB) and rgba where applicable. `src/theme/tokens.ts` is the canonical runtime source; this section is the spec. Display-P3 conversions removed for v3 — the cosmic backdrop already pushes the visible palette into P3 territory through its photo content, and per-token P3 declarations were a v2 paper exercise that didn't pay off.

### 4.1 Void family — backgrounds

| Token | Hex | RGB | Usage |
|---|---|---|---|
| `void` | `#06060C` | 6, 6, 12 | Fallback background. Shown briefly at app launch before the StarField mounts; otherwise covered by the cosmic backdrop. Cool near-black (B+6 bias). |
| `voidDeep` | `#020208` | 2, 2, 8 | Tab bar background. Gradient inner. Modal scrim base color. |

The galaxy photo + StarField sit on top of `void` and become the visible "background" everywhere except the tab bar. Never `#000000`. Never warm near-black (v2's `#0A0A0B` had a +4 red bias; v3 reverses to a slight cool bias).

### 4.2 Surface family — frosted glass

Cards are translucent dark tints behind a `<BlurView/>`. Alpha values are intentional — cards must let the cosmic backdrop participate without dragging text contrast below readable thresholds. v3.5 tuning landed after iteration with the live screen.

| Token | rgba | Usage |
|---|---|---|
| `surface` | `rgba(8, 10, 18, 0.68)` | **Default card background.** Wrapped by BlurView intensity 25. |
| `surfaceElevated` | `rgba(12, 14, 22, 0.82)` | Modal / sheet / pressed-card background. Wrapped by BlurView intensity 35. |
| `surfaceSunken` | `rgba(4, 6, 12, 0.50)` | Inset panels, disabled states. No blur. |

### 4.3 Text family — stellar

Primary text matches the pure-white star color. Secondary text reads as moonlight (cool blue-white) rather than paper (warm cream). All text colors v3.5-tuned for legibility against the cosmic backdrop after multiple iterations.

| Token | Hex | RGB | Usage |
|---|---|---|---|
| `text` | `#FFFFFF` | 255, 255, 255 | **Primary text.** Same color as the StarField stars. ≥15:1 against `void`. |
| `textSecondary` | `#E8EEF6` | 232, 238, 246 | Body secondary, card body copy. Cool blue-white. |
| `textMuted` | `#9AA3B5` | 154, 163, 181 | Metadata, hints, tracked-caps section labels. Cool gray-blue. |
| `textDisabled` | `#4A5260` | 74, 82, 96 | Disabled states. Large UI only — too dim for body. |
| `textInverse` | `#06060C` | 6, 6, 12 | Text on light-colored fills (cream pills, gold pills). Matches `void`. |

### 4.4 Gold family — earned ornament (≤5% per screen)

Brightened from v2's `#D4A056` to assert against cosmic competition. Screen budget tightened from ≤10% to ≤5% — gold is now even more deliberately a seal, not a stroke.

**Per-card accent rule (added 2026-08-06, owner-approved — tightens the screen-level cap into a per-card rule):** ≤1 accent-colored token per card, and only ever on a numeral, a state word, or one inline span. Never on chrome, never on a border, never on an icon that isn't itself the meaning.

| Token | Hex / rgba | Usage |
|---|---|---|
| `gold` | `#E5BA6E` | **Primary accent.** Section action labels (EDIT, MANAGE), category markers, the alignment-ring arc, the Ring logo. |
| `goldBright` | `#F2D08A` | Hover, pressed, momentary flare |
| `goldDeep` | `#A07A3F` | Pressed state, dark accretion-ring outer edge |
| `goldHairline` | `rgba(255, 255, 255, 0.10)` | **Card border hairline.** Token name kept for compat; the value is now luminous white at 10% (no longer gold-tinted — v3 card edges read as carved from starlight). |
| `goldWash` | `rgba(229, 186, 110, 0.05)` | Subtle gold-rgba tint for selected pill backgrounds, countdown chips |

### 4.5 Teal family — sacred-active (electric cyan)

Brightened to pop against the backdrop's own teal-cyan iris regions in the galaxy photo. If v2 teal blended in, v3 teal stands out.

| Token | Hex / rgba | Usage |
|---|---|---|
| `teal` | `#5FE0EA` | **Primary active.** Completed checks, in-progress rings, success states, NOW/HAPPENING badges, Eye iris |
| `tealBright` | `#7FE8F0` | Hover, Eye glimmer peak |
| `tealDeep` | `#2A8F98` | Pressed, outer iris, rim depth |
| `tealWash` | `rgba(95, 224, 234, 0.08)` | Tealtinted background for active/now chips |

### 4.6 Amber family — RETIRED from default utility

> **ADHD-pivot amendment (2026-06-16, §1.5 Law B):** amber stays milestone-only, but a milestone is a *positive, cumulative* moment — **not a consecutive-day chain, and never a broken-streak red state.** `<StreakChip/>` shows cumulative progress by default; breakable streaks are opt-in "Soft Mode" only.

Amber exists in the token registry but is **reserved exclusively for streak milestone ceremonies (7, 30, 66, 365 day hits) and the milestone state of `<StreakChip/>`**. Anywhere amber was used in v2 as a "low/warn" indicator (Weekly Debrief low-tier, Cut-or-Commit accent, traffic-light low) now uses `textMuted` (quiet) or `gold` (attention-needed).

| Token | Hex | Usage |
|---|---|---|
| `amber` | `#F5A04A` | Streak milestone ceremony only |
| `amberDeep` | `#E88438` | Combustion gradient mid (Eye shader) |
| `amberCore` | `#A94520` | Combustion gradient core (Eye shader) |

The galaxy backdrop already supplies its own warm combustion regions; a second warm accent on default screens fights with it. The retirement is the largest single behavioral shift between v2 and v3.

### 4.7 Nebula family — cosmic scale (Eye only)

Unchanged from v2.

| Token | Hex | Usage |
|---|---|---|
| `nebulaMagenta` | `#B83A6E` | Eye outer nebula |
| `nebulaViolet` | `#6E2A8F` | Eye deep nebula |
| `nebulaDeep` | `#2A1A3E` | Transition to void |

Reserved for the Eye and for 365-day milestone ceremonies. Also adopted as the Align tab's PERSONAL category color, replacing v2's amber-for-Personal which conflicted with the amber retirement (see §10.18 / `app/(tabs)/align.tsx`).

### 4.8 State family — semantic

| Token | Hex | Usage |
|---|---|---|
| `stateSuccess` | `#5FE0EA` (= `teal`) | Completion — uses teal, never green |
| `stateWarning` | `#E5BA6E` (= `gold`) | Mild warning — uses gold, never yellow |
| `stateError` | `#E55B45` | Brighter warm red than v2's `#C6523A` — pops against bright nebula |
| `stateErrorDeep` | `#A23D28` | Pressed, emphasis |
| `stateInfo` | `#78A5B8` | Muted celestial blue-gray — unchanged from v2 |
| `statePhosphor` | `#39FF7A` | **Rare.** Year-milestone (365-day) ceremonies only. Genuinely beyond sRGB on P3 displays. |

### 4.9 Material constants

| Token | Value | Usage |
|---|---|---|
| `material.shadow.ambient` | `shadowColor: rgba(229,186,110,0.28)`, `shadowRadius: 36`, `shadowOffset: {0,8}`, `shadowOpacity: 1` | The signature "lit from within" gold halo — **hero / elevated surfaces only** after the 2026-08-06 amendment. Exported as `ambientGlow` from `src/theme/glow.ts`. |
| `ambientGlowSoft` | `shadowColor: rgba(229,186,110,0.10)`, `shadowRadius: 20`, `shadowOffset: {0,4}`, `shadowOpacity: 1` (Android elevation 3) | **(Added 2026-08-06, owner-approved §2 amendment)** Soft halo tier for ordinary list cards — same gold hue family, quieter, so only one lit object glows per surface ("spend light like money"). Exported from `src/theme/glow.ts`; the Card primitive's default variant uses it. |
| `material.heroBloom.stops` | radial: `rgba(95,224,234,0.10)` at center → transparent by 60% radius | **(Added 2026-08-06, same amendment)** Radial teal bloom rendered BEHIND exactly one hero object per screen — light as hierarchy, carried by the bloom instead of a halo under every card. |
| `material.shadow.ambientAndroidElevation` | `6` | Android fallback for the halo |
| `material.hairline.color` | `rgba(255,255,255,0.10)` (= `goldHairline` token) | 0.5pt card border at rest |
| `material.hairline.active` | `rgba(255,255,255,0.22)` | 0.5pt card border on press / active state |
| `material.insetHighlight` | linear 180deg, `rgba(255,255,255,0.04)` → transparent at 18% | Top-edge inset glow that fakes "lit from above" on cards. v2 was cream-tinted; v3 is pure white. |

### 4.10 Gradient recipes

Gradients are rare in v3 — most "earned" treatment is carried by the ambient gold halo (§4.9) rather than gradient fills. The gradients below remain spec'd for the few ceremonial contexts.

**`gradient.earned` — milestone achievement cards (7/30/66/365 day):**
```
type: linear
angle: 165deg
stops:
  0%:   #F5A04A  (amber)
  55%:  #E88438  (amberDeep)
  100%: #A23D28  (stateErrorDeep)
```
Used only at milestone moments. Amber is permitted here because this *is* a streak ceremony — the exact context where amber lives in v3.

**`gradient.sacred` — Eye iris base, optional primary CTA backgrounds:**
```
type: linear
angle: 155deg
stops:
  0%:   #7FE8F0  (tealBright, v3 value)
  45%:  #5FE0EA  (teal, v3 value)
  100%: #2A8F98  (tealDeep)
```

**`gradient.vignette` — modal scrims and full-screen overlays:**
```
type: radial OR linear (both used)
modal scrim:    rgba(2, 2, 8, 0.78)  — cosmic vignette, replaces v2's pure-black-at-85%
top→middle→bottom (in-StarField scrim): rgba(2,2,8,0.10) → rgba(2,2,8,0.32) → rgba(2,2,8,0.18)
```

**Retired gradients (do not use):**
- `gradient.pedestal` (v2 Home hero radial) — the cosmic backdrop *is* the pedestal now; no per-screen radial needed.

### 4.11 Contrast audit (verified against WCAG 2.1)

Note: text against the cosmic backdrop varies with the local nebula region. The v3 in-StarField scrim (§6.7) darkens the mid-band so text is reading against an effective `rgba(2,2,8,~0.32)`-darkened photo rather than full-brightness nebula. Card-backed text reads against `surface` (`rgba(8,10,18,0.68)` + BlurView) which composites to roughly `#1A1D27` effective bg under typical conditions.

| FG | BG (effective) | Ratio | Verdict |
|---|---|---|---|
| `text` (`#FFFFFF`) | `void` (`#06060C`) | 19.8:1 | AAA |
| `text` | dimmed nebula (mid-band, after scrim) | ~7–11:1 | AAA most regions, AA worst-case |
| `text` | card-backed (`surface` composite) | ~13:1 | AAA |
| `textSecondary` (`#E8EEF6`) | `void` | 17.6:1 | AAA |
| `textSecondary` | card-backed | ~11:1 | AAA |
| `textMuted` (`#9AA3B5`) | `void` | 8.1:1 | AAA |
| `textMuted` | card-backed | ~6:1 | AA body |
| `gold` (`#E5BA6E`) | `void` | 10.4:1 | AAA |
| `teal` (`#5FE0EA`) | `void` | 13.7:1 | AAA |
| `stateError` (`#E55B45`) | `void` | 6.2:1 | AA body |
| `textInverse` (`#06060C`) | `text` fill (white pill) | 19.8:1 | AAA |
| `textInverse` | `gold` fill | 8.4:1 | AAA |
| `textInverse` | `teal` fill | 11.5:1 | AAA |

**Empty-state text on cosmos** (no card backdrop): apply a soft dark text-shadow (`textShadowColor: 'rgba(0,0,0,0.55)'`, `textShadowRadius: 4`, `textShadowOffset: {0,1}`) for floating text outside cards. See Inbox `emptyText`/`emptySub` and Align `hint`/`moreToggleText` for canonical examples.

### 4.12 High-contrast variant (iOS Accessibility → Increase Contrast)

When `isDarkerSystemColorsEnabled` is true:

- `text` stays at `#FFFFFF` (already maxed)
- `textSecondary` → `#FFFFFF` (collapse to primary for stronger hierarchy via weight not color)
- `textMuted` → `#C8CDD8` (brighten the cool gray-blue toward pure cool-white)
- `gold` → `#F2D08A` (brighter end of the gold family)
- `teal` → `#7FE8F0`
- Card hairlines: opacity 10% → 26%
- StarField scrim intensity: bumped (`0.10/0.32/0.18` → `0.18/0.45/0.28`) so bright nebula regions are more occluded
- Card `surface` alpha: `0.68 → 0.85` (less translucent)
- Fraunces Light 300 → swap to Regular 400

Every screen must remain legible and on-brand under this setting.

### 4.13 Why cool-shifted void beats warm near-black under the cosmic backdrop

In v2, `#0A0A0B` with a +4 red bias read as warm candlelight — the right ground for a cream-and-gold-leaf aesthetic. Under v3's cosmic backdrop, that warm bias fights with the galaxy photo's intrinsic warmth (combustion regions, nebula highlights). The eye reads the warm void as "leaking warmth from the wrong direction" — the warmth should come from the backdrop, not the screen base.

`#06060C` with a +6 blue bias (v3) recedes more cleanly behind the cosmic field. When the StarField mounts and the void is covered, the brief transition feels of-a-piece with the cool stellar palette. When the tab bar (which still uses `voidDeep`) sits at the bottom of the screen, it reads as a cool floor under the cosmic field, not a warm hearth.

The visible difference is small (R6/G6/B12 vs R10/G10/B11). The narrative difference is the whole point.

---

## 5. TYPOGRAPHY SYSTEM

**Three typefaces for the app. One sanctioned exception, scoped to a single non-UI surface.**

- **Fraunces Light Italic** (Google Fonts, OFL, free) — identity, reflection, and poetic moments. Mandate statements, alignment-score qualitative word, onboarding lines, Daily Pulse insight, weekly focus line, celebratory copy.
- **Inter** (Google Fonts, OFL, free) — all UI text. Buttons, labels, body copy, navigation, form fields.
- **IBM Plex Mono** (Google Fonts, OFL, free) — all numerals and data. Alignment score, streak counts, timers, percentages, XP values.

- **IBM Plex Sans JP** (OFL, free) — **katakana subset only, `MatrixRain` glyphs only.** The sanctioned fourth face (NEX-303, amends §2 + §19). Same Plex superfamily as Plex Mono, so it is a widened voice rather than a foreign one. It is loaded for the loading-surface rain and **nothing else** — no UI text, no body, no numerals may resolve it. The rain's Latin and numeric glyphs still come from Plex Mono.

The first three are already in the shipped app. Plex Sans JP is bundled as a katakana subset (~20KB). No license changes needed — all four are OFL.

### 5.1 The complete type scale

All tracking values in em. Multiply by pt-size for iOS `.tracking()`. All changing numerals use `.monospacedDigit()` or `fontVariant: ['tabular-nums']`.

| Token | Family | Size | LH | Tracking | Weight | Transform | Usage |
|---|---|---|---|---|---|---|---|
| `hero.numeric` | IBM Plex Mono | 140 | 130 | −0.04em | Medium 500 | — | Alignment score (Home hero) |
| `display.large` | Inter | 48 | 52 | −0.03em | Bold 700 | — | Screen title hero |
| `display.medium` | Inter | 36 | 40 | −0.025em | Bold 700 | — | Section primary |
| `title.screen` | Inter | 28 | 34 | −0.02em | SemiBold 600 | — | Screen titles ("Today", "Align") |
| `title.section` | Inter | 22 | 28 | −0.01em | SemiBold 600 | — | Card titles |
| `title.card` | Inter | 18 | 24 | 0 | SemiBold 600 | — | Card subtitle, list item |
| `body.lg` | Inter | 17 | 26 | −0.005em | Regular 400 | — | Long-form reflection, morning brief |
| `body.md` | Inter | 15 | 22 | 0 | Regular 400 | — | Default body |
| `body.md.emphasis` | Inter | 15 | 22 | 0 | Medium 500 | — | Inline emphasis |
| `caption` | Inter | 13 | 18 | +0.005em | Medium 500 | — | Metadata |
| `caption.tabular` | IBM Plex Mono | 13 | 18 | 0 | Regular 400 | — | Inline timestamps, IDs |
| `label.tracked.lg` | Inter | 13 | 16 | **+0.16em** | SemiBold 600 | UPPERCASE | **Section headers** — "THIS WEEK'S WINS", "MORNING BRIEF", "WEEKLY DEBRIEF". Brutalist museum-placard register. |
| `label.tracked.sm` | Inter | 11 | 14 | **+0.18em** | SemiBold 600 | UPPERCASE | Tab labels, micro-metadata, chip labels |
| `label.tracked.micro` | Inter | 9.5 | 12 | +0.20em | SemiBold 600 | UPPERCASE | Rare tiny labels |
| `numeric.display` | IBM Plex Mono | 36 | 40 | −0.01em | Medium 500 | — | Featured data ("109%", "76") |
| `numeric.md` | IBM Plex Mono | 18 | 24 | 0 | Medium 500 | — | Inline data |
| `numeric.sm` | IBM Plex Mono | 13 | 18 | 0 | Regular 400 | — | Timestamps, inline metrics |
| `poetic.hero` | Fraunces | 28 | 34 | +0.01em | Light Italic 300 | — | Alignment score qualitative word ("Steady") |
| `poetic.md` | Fraunces | 22 | 30 | +0.01em | Light Italic 300 | — | Mandate statements, onboarding lines |
| `poetic.sm` | Fraunces | 18 | 26 | +0.01em | Light Italic 300 | — | Daily Pulse insight, weekly focus |
| `button.primary` | Inter | 16 | 20 | +0.01em | SemiBold 600 | — | Primary pill CTAs |
| `button.tracked` | Inter | 13 | 16 | +0.14em | SemiBold 600 | UPPERCASE | Secondary brutalist CTAs ("DONE", "ADD", "EDIT") |

### 5.2 The +0.16em rule

At 13pt uppercase, iOS rasterization collapses capitals into a dense block. +0.16em tracking restores the museum-placard cadence without crossing into vaporwave territory. This is the single most leverage-positive move in the type system. Apple's HIG recommends +2% to +20% tracking on all-caps under 14pt; we sit at 16–20%.

**Every uppercase label ≤ 14pt gets +0.16em minimum. No exceptions.**

### 5.3 When to use which register

- **Fraunces Light Italic** — anywhere the app speaks about identity, reflection, or sacred intent. Mandate text in the Align detail view. The alignment-score qualitative word. The Daily Pulse insight. Onboarding headlines. "Today's win" label when a streak milestone is hit. Max one Fraunces treatment per screen — it loses its weight when overused.

- **Inter** — everything else in UI. Buttons. Tab labels. Body copy. List items. Form fields. Modal titles.

- **IBM Plex Mono** — every number. Streak counts. Percentages. Scores. Timers. XP values. Never use Inter for numerals that change or align in columns.

- **Tracked uppercase Inter** — every section header. "MORNING BRIEF", "THIS WEEK'S WINS", "WEEKLY DEBRIEF", "TODAY'S HORIZON", "CUT OR COMMIT", "UP NEXT". One per section, never stacked.

### 5.4 Numerals — tabular vs proportional

- **Tabular numerals** on everything that animates or aligns in a column: alignment score, streak counts, percentages, counters. `fontVariant: ['tabular-nums']` in React Native.
- **Proportional numerals** on hero display numbers that don't change mid-view: "DAY 3" onboarding. Optional — defaults to tabular if unsure.

### 5.5 Dynamic Type

- Hero display numerals: honor Dynamic Type but clamp at `.accessibility2`. At larger sizes, reflow to stacked layout — never shrink the hero number.
- Body text: fully honor, no clamp. Use `Font.custom(_:size:relativeTo:)` or `fontSize` with `allowFontScaling`.
- Tracked-caps labels: keep tracking in em so it scales proportionally — never use pt letter-spacing.
- At Accessibility XXL, drop uppercase transform on strings over 20 chars (caps reduce low-vision reading speed by ~13%).

### 5.6 Rules of the type system

1. Never mix display families.
2. Fraunces italic is reserved. Max one use per screen.
3. Tracked uppercase is signage — one per section, never stacked.
4. Numerals are always Plex Mono. Never Inter for numbers.
5. Italics only in Fraunces. Inter never italicizes.
6. Body text is `text.secondary` (`#E8EEF6`), not `text` (`#FFFFFF`). `text` is reserved for titles and hero copy.
7. Mono only for data. Never body.
8. One brutalist hero numeral per screen, max.


---

## 6. MATERIAL SYSTEM — FROSTED GLASS ON COSMIC FIELD

v2 called the material language "stone-morphism" — opaque dark cards carved into a warm void. v3 reframes the same idea on a cosmic backdrop: **frosted glass suspended in starlight**. Cards still have material presence, but the cosmos peeks through every surface. The signature changes (gold hairline → luminous-white hairline, warm gold halo → cool-shifted same-gold halo, grain → deferred), but the thesis is the same: cards are *carved from* the field, not laid on top.

> **What changed (NEX-146 / NEX-158, 2026-06).** The card edge moved from the near-invisible 0.5pt white-@10% hairline to a crisp **1px luminous-white edge** (`tokens.color.luminousEdge`, white @ 0.28) — the designer's "pixel border." NEX-158 adds **opt-in luminous corner glows** on primary cards (the border appears to light up at the corners) via `tokens.material.cornerGlow` + `src/components/ui/CornerGlows.tsx`. The §6.2 "hairline" signature is renamed to "luminous edge + corner glows." The card primitive already carries the 1px edge; the app-wide migration of manual card-shaped Views from `goldHairline` (0.5pt) to `luminousEdge` (1px) is the NEX-158b follow-up — dividers, text-input underlines, sheet top-edges, and chips/pills keep `goldHairline` (10%) deliberately.

### 6.1 The frosted-glass card spec

Every card in the app has these properties:

```
backgroundColor: rgba(8, 10, 18, 0.68)   — tokens.color.surface
                                          (rgba(12,14,22,0.82) for elevated)
border:          1px rgba(255,255,255,0.28) — luminous-white edge (tokens.color.luminousEdge)
                                          (active/pressed: white @ 0.40)
cornerRadius:    16pt (default) | 20pt (hero) | 24pt (full-screen pedestals)
padding:         20pt (default) | 24pt (hero)
overflow:        hidden  (clips BlurView + accent bar + inset glow)
```

Plus the layered material stack inside the rounded clipping container (bottom → top):

1. **`<BlurView/>` (`expo-blur`)** — `intensity={25}` default, `intensity={35}` elevated, `tint="dark"`. iOS native `UIVisualEffectView` blur of the cosmic field behind the card. This is what makes the card feel like glass.

2. **Translucent tint overlay** — `<Animated.View style={{...absoluteFill, backgroundColor: surface}}/>` painted on top of the BlurView. Gives the card its dark "reading sanctuary" tint. Animates between `surface` (rest) and `surfaceElevated` (pressed) via `interpolateColor` on the press shared value.

3. **Accent bar** (optional, `accentBar="gold"|"teal"|"amber"`) — left edge, 3pt wide, full card height, inside the rounded border.

4. **Inset highlight glow** — linear gradient 180deg from `rgba(255,255,255,0.04)` at 0% to transparent at 18%. Fakes "lit from above." v2 was cream-tinted; v3 is pure white.

5. **Content** — children, padded per `padding` value, shifted right by 3pt if accent bar is present.

6. **Corner glows** (optional, `cornerGlow` prop — NEX-158) — luminous-white accents that trace each rounded corner (line → arc → line), brightest at the corner and fading along both edges. Rendered as an absolute overlay on the outer wrapper (OUTSIDE the `overflow:hidden` card, so the soft glow bleeds outward and reads as the border lighting up). Opt-in, primary cards only; suppressed on the left edge when an accent bar is present. White, not gold (doesn't touch the ≤5% gold budget). Static (§1.4). See `CornerGlows.tsx` + `tokens.material.cornerGlow`.

**Ambient gold halo BENEATH the card** (outside the overflow:hidden clipping container, lives on the outer wrapper View):

- `shadowColor: rgba(229, 186, 110, 0.28)`
- `shadowRadius: 36pt`
- `shadowOffset: { width: 0, height: 8 }`
- `shadowOpacity: 1.0`
- Android: `elevation: 6`

This is exported from `src/theme/glow.ts` as `ambientGlow` and spread into the style entry of **every card-shaped surface** in the app (the Card primitive, plus dozens of manual card-shaped Views across Home, Inbox, Align, Orbit, Command, Settings). Never use iOS default black drop shadow. **(Amended 2026-08-06, owner-approved):** two tiers now — full `ambientGlow` on hero/elevated surfaces only, `ambientGlowSoft` on ordinary cards (§4.9). The app-wide sweep of manual card styles lands in a later slice; the Card primitive already follows the tier rule.

### 6.2 Luminous edge + corner glows — the signature

The **1px luminous-white edge** (`tokens.color.luminousEdge`, `rgba(255,255,255,0.28)`) is the most important detail in the material system. It is what separates Nexus's cards from "another dark-mode app with blur" — the edge reads as carved from starlight. (NEX-146 promoted it from the v3.0 near-invisible 0.5pt @10% hairline to this crisp "pixel border" per designer direction.)

On active/pressed states the edge lifts to **white @ 0.40**. Transition: 140ms ease (`motion.quick`).

**Corner glows (NEX-158, opt-in).** Primary cards may set `cornerGlow` to add luminous-white accents that make the edge appear to light up at each corner — a path tracing the rounded corner (line → arc → line), brightest at the corner apex and fading along both edges via a per-corner radial gradient (apex stroke at `apexOpacity` + a soft 3pt glow at `glowOpacity`). White, so it doesn't touch the ≤5% gold budget (§4.4); static, no shimmer (§1.4); rendered outside the card's `overflow:hidden` so the glow bleeds outward. Values live in `tokens.material.cornerGlow`; component is `src/components/ui/CornerGlows.tsx`. Off by default — list rows and dense surfaces stay plain so the glow stays special.

**Token-name caveat.** `goldHairline` (`rgba(255,255,255,0.10)`) is retained for non-card edges — dividers, text-input underlines, sheet top-edges, chips/pills — which correctly stay at the quiet 10%. Card-shaped container borders use `luminousEdge`. The app-wide migration of remaining manual card Views to `luminousEdge`/1px is the NEX-158b follow-up.

### 6.3 When to deviate from the frosted-glass card

Four surfaces override the standard frosted-glass card:

1. **The Eye (Command tab).** Full Skia cosmic composition. Covered in §9.
2. **Milestone earned cards.** Use `gradient.earned` (warm amber gradient — the *one* context where amber is permitted in v3) instead of frosted glass. Appear at most once per week. Covered in §8.
3. **Active CTA buttons.** Solid white fill for the primary `<PrimaryPill/>` variant, gold fill for the gold variant, outlined for secondary. Covered in §7.
4. **The alignment-score hero on Home.** Score numeral + qualitative word on cosmos. The Skia ring (gold accretion + halo) sits in the center; the numeral floats over it. No card wrapper, no BlurView — the ring IS the wrapper. See `AlignmentScoreRing.tsx`.

### 6.4 Grain texture — deferred under v3

v2 specced a 2–4% warm-cream noise PNG overlay on every card. v3 defers this:

- The cosmic photo backdrop + BlurView blur already supply organic visual texture. Adding cream-tinted grain on top would be redundant or fight the cool palette.
- If cards start to feel too clean once everything else settles, we can layer a 2% **cool-toned** grain (white or `textSecondary` noise) — but the bar to land it is "the design feels under-textured against the cosmic ground," not "the spec said so."
- The `material.grain` token values remain in `tokens.ts` but no Card consumer currently uses them. Revisit after first major release.

### 6.5 Depth hierarchy

Four depth levels, distinguished by background alpha + ambient halo intensity (never by drop shadow harshness):

| Level | Background | Halo | Use |
|---|---|---|---|
| 0 — cosmic field | (visible: galaxy photo + scrim + stars) | none | Screen "background" — the StarField renders here |
| 1 — card | `rgba(8, 10, 18, 0.68)` + BlurView 25 | `ambientGlow` | Default cards across all tabs |
| 2 — elevated | `rgba(12, 14, 22, 0.82)` + BlurView 35 | `ambientGlow` | Modals, bottom sheets, pressed cards |
| 3 — floating | `rgba(12, 14, 22, 0.82)` + BlurView 35 | `ambientGlow` + `material.shadow.floating` | Toast notifications, contextual popups |

Hierarchy comes from alpha + blur intensity, not shadow harshness. Never use iOS default black drop shadow at any level.

### 6.6 StarField — global cosmic backdrop

`src/components/ui/StarField.tsx`. Mounted in `app/_layout.tsx` immediately above the root void background and below the Stack content. Every screen sits on top of it.

**Layers (bottom → top inside StarField):**

1. **Galaxy photo** — `<expo-image Image/>` full-bleed `require('../../../assets/images/star-field-bg.jpg')`, `contentFit="cover"`, `cachePolicy="memory-disk"`.

2. **In-StarField scrim** — vertical linear gradient, three stops (`rgba(2,2,8,0.10)` → `rgba(2,2,8,0.32)` at 45% → `rgba(2,2,8,0.18)`). Darkens the bright nebula peak band in the middle of the screen so text floating on cosmos has contrast without dimming the stars. See §6.7 for why this lives inside StarField.

3. **Twinkle dots** — 80 absolutely-positioned `<Animated.View>` dots, one per star, opacity driven by `useAnimatedStyle` derivation. Pure white (`#FFFFFF`), 2.5–4pt diameter, distributed via two-pass placement (60-star jittered grid + 20-star mid-band fill so the right-middle region is dense enough).

**Twinkle animation (v9.5 — final):**

Architecture: **one** parent-level `setInterval` ticker writes a single `time` SharedValue every ~16ms (~60fps). Each `<TwinkleDot/>` reads `time` inside its `useAnimatedStyle` worklet and computes opacity as a pure function of `(time, this star's params)`. No per-star `withRepeat`, no per-star `useEffect`. This is what makes the field survive Fast Refresh — there is no per-component animation state to desync when the module hot-swaps. See memory `reanimated_per_component_withrepeat_fast_refresh` and `nexus_starfield_twinkle_shape`.

Each star runs two motions simultaneously:

- **Always-on micro-scintillation.** Two sines at non-integer per-star frequencies (0.45–1.0 Hz + 1.10–1.90 Hz, derived from `flickerStart` and `delay`), summed 65/35 and normalized to `[0,1]`. Amplitude is **18% of `(peak - trough)`**. The non-integer ratio makes the combined wave quasi-periodic — never reads as a clean pulse. Every star is *always* visibly moving.

- **Discrete flicker event.** Once per cycle, a sharp brightening from the wobbling base up to `peak` and gently back. 25% sharp rise (ease-out cubic), 75% gentler fall (ease-in quadratic). Flicker window = 12% of the cycle. Period range 4.5–11s per star.

Per-star randomization:
- `size`: 2.5–4pt (float, not int)
- `period`: 4.5–11s
- `delay`: 0–5s (initial cycle offset)
- `flickerStart`: 0.10–0.78 (position in cycle where flicker begins)
- `trough`: 0.42–0.60 opacity (rest brightness)
- `peak = trough + flickerStrength`, where `flickerStrength` is uniform 0.22–0.65 (every star visibly flickers — no quiet tier)

**Color and theming rule:** stars are pure white (`#FFFFFF`), not the warm cream `tokens.color.text` was in v2. This is intentional — real stars are emission sources, not paper. The intentional deviation is flagged with a FIXME in `StarField.tsx`.

**Reduce Motion:** *not yet wired.* Under Reduce Motion the StarField should freeze the `time` ticker at a static pleasing value (e.g., 3500ms) so stars hold at varied opacities without animating. Open follow-up.

### 6.7 Why the scrim lives inside StarField, not above it

v3.1 placed `<ScrimOverlay/>` as a sibling layer *above* StarField in the layout tree. The dark gradient dimmed everything below it — including the twinkle dots. User reported: "the stars look dimmer after every edit."

v3.2 fix: move the same gradient *inside* StarField, between Layer 1 (galaxy photo) and Layer 2 (twinkle dots). Now:
- Galaxy photo gets the mid-band darkening → text contrast restored.
- Twinkle dots render *on top of* the dimmed galaxy → they keep their original brightness.

Do not reintroduce a separate `<ScrimOverlay/>` above StarField. The legibility scrim must be inside the StarField composition.

---

## 7. MOTION LANGUAGE

### 7.1 The governing principle

**Stone doesn't bounce.** Motion is 250ms ease-out transitions and 350ms fade-plus-8pt-rise on entry. Everywhere. Three exceptions, all continuous, all named in §2: the Eye (§9), which has its own motion system because it is the living surface; the StarField (§6.6), the breathing thing in the sky; and the loading-surface `MatrixRain` (NEX-303), which runs only while the app is gated and never on an interactive screen.

> **Amended 2026-08-15 (owner-approved): the Home hero's share of that fourth exception now includes the
> serpent's undulation, not only the halo's brightness swell.** 1% of the hero box, 7s period, zero under
> Reduce Motion. See §1 principle 4 for the numbers and the bounds; they are stated once there and referenced
> here rather than repeated, because this rule living in three places is how it drifts.

> **Reconciled 2026-08-09 (NEX-331): this list of three has always been a list of four.**
> §1 principle 4's Home Coherence Ring exception already sanctions the alignment hero's slow
> ambient breath — a brightness swell on the glow, no rotation, no movement — and has since
> 2026-05-31. §7.1 simply never picked it up. The ouroboros replaces that ring and inherits
> the breath unchanged, so rather than let the hero's motion look new, it is written down
> here: Eye, StarField, `MatrixRain`, and the Home hero's halo breath. Nothing about the
> breath changed; only this list did.
>
> **The serpent adds ONE loop, and only one (amended 2026-08-15, owner-approved).** This
> paragraph used to read "the serpent itself adds no loop," and that sentence invited the
> amendment that has now arrived — it said any future loop needs its own amendment *here*, so
> here it is, in place, rather than as a second rule somewhere else that would quietly
> contradict this one.
>
> The one sanctioned loop is the ambient undulation: a travelling radial wave, 1% of the hero
> box, one wave every 7 seconds, zero under Reduce Motion. Its numbers, rationale and bounds
> are stated once in §1 principle 4; they are not repeated here.
>
> **Everything else the serpent does remains discrete and event-driven**, and that half is
> unchanged: it travels on the first count-up (1400ms) and on a re-score (700ms), the two
> timings the ring already used; the jaw opens as a function of the score rather than of time;
> the bite is a single beat that settles. A continuous highlight sweep existed in the prototype
> and was dropped — it is still dropped, and this amendment does not revive it. The ornament's
> rotation is a prop that defaults to zero with nothing driving it, and stays that way. **Any
> further loop on this hero — a sweep, a rotation, a glow cycle — still needs its own amendment
> here.** One loop, named; not a licence for motion generally.

No springs. No bouncing. No overshoot. No elastic pull-back. Monastic pacing.

The shipped app already specifies this. The overhaul enforces it more rigorously and adds a short list of exceptions.

### 7.2 Named curves

```ts
// motion/curves.ts
export const motion = {
  // The default — use this for 95% of transitions
  standard: {
    duration: 250,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',  // ease-out, no overshoot
  },

  // Entry: fade + 8pt rise
  entry: {
    duration: 350,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fromOpacity: 0,
    fromTranslateY: 8,
  },

  // Exit: fade out, slower than entry
  exit: {
    duration: 200,
    easing: 'cubic-bezier(0.4, 0, 1, 1)',  // ease-in
  },

  // Quick feedback — tap press-state
  quick: {
    duration: 140,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },

  // Ceremony — reserved for check-completion, milestone reveals
  ceremony: {
    duration: 680,
    easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
  },

  // Eye-only — the living surface. Used inside the Command tab.
  eye: {
    ambient: 'timeline animation, 4s loop, continuous',
    dilate: { duration: 600, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    combustion: 'fluid shader, advected over time',
  },
};
```

### 7.3 Reanimated specification

The shipped app uses Reanimated 4 with the New Architecture. Constrain all Reanimated uses to the named curves above. Do NOT use `withSpring()` (its default is bouncy). Do NOT use `withTiming` without specifying an easing.

**Correct:**
```tsx
opacity.value = withTiming(1, {
  duration: motion.standard.duration,
  easing: Easing.bezier(0.2, 0, 0, 1),
});
```

**Banned:**
```tsx
opacity.value = withSpring(1);  // bouncy default
translateY.value = withSpring(0, { damping: 12 });  // bouncy
```

Add an ESLint rule: `no-withSpring-without-named-config`.

### 7.4 Motion mapping

| Interaction | Curve |
|---|---|
| Card appears | `motion.entry` |
| Card dismisses | `motion.exit` |
| Button press | scale 1 → 0.97, `motion.quick` |
| Button release | scale 0.97 → 1, `motion.standard` |
| Modal present | `motion.entry` + ambient fade on scrim |
| Modal dismiss | `motion.exit` |
| Tab change | content swap at `motion.standard`, tab indicator at `motion.quick` |
| Page push/pop | iOS-native default (do not override) |
| Checkbox check | See §8.5 — ceremonial 800ms sequence |
| Score number change | Plex Mono cross-fade at `motion.standard` (numbers fade, don't flip) |
| Pull-to-refresh | Custom — teal hairline grows top-down on pull, releases with `motion.standard` |
| Swipe-to-delete | `motion.standard` for reveal, `motion.exit` for commit |
| Scroll parallax | None. Stone doesn't parallax. |
| Reordering drag | `motion.quick` on lift, `motion.standard` on drop |
| Toast appear | `motion.entry` from top |
| Toast dismiss | `motion.exit` upward |

### 7.5 The Eye's motion (exception)

The Eye has three motion modes, all continuous and shader-driven:

- **Ambient (default).** Iris glimmer at 0.3Hz sine. Combustion fluid-noise advected at 0.08 units/sec. Nebula drift at 0.04 units/sec. Pupil steady. All via a single `time` uniform passed to the SkSL shader. Runs at 60fps; drops to 30fps on thermal stress.
- **Listening (user tapped Eye, voice input active).** Pupil dilates from 40pt radius to 140pt over 600ms using `motion.eye.dilate`. Combustion intensity doubles. Iris glimmers faster (0.6Hz). A subtle waveform animates across the iris scaled to microphone input level.
- **Processing (voice input ended, AI routing).** Pupil stays dilated for ~800ms. Combustion pulses once (full intensity → ambient intensity over 400ms). Iris stabilizes. After AI confirms action, combustion does a single warm flare (400ms to 150% intensity, then settles). Then pupil contracts back to ambient over 500ms.

All motion driven by Reanimated shared values updating shader uniforms. No imperative animation on the geometry.

### 7.6 Reduce Motion

Every motion call includes `reduceMotion: ReduceMotion.System`. Additionally:

- Eye ambient: freeze shader time at a static beautiful frame
- Eye listening: pupil dilation stays (semantic); combustion pulse removes (decorative)
- Eye processing: flare becomes opacity flash, no animation
- Card entries: opacity only, no translateY
- Pull-to-refresh: hairline grows instantly at threshold, no animation
- Checkbox ceremony: instant state swap, haptics preserved

Haptics preserved in all modes.

---

## 8. HAPTIC AND AUDIO SYSTEM

### 8.1 Haptic vocabulary

Use `expo-haptics` uniformly. No third-party haptic libraries. No per-frame haptics.

| Interaction | Haptic |
|---|---|
| Tab change | `selectionAsync` |
| Primary button tap | `impact Light` |
| Secondary button tap | `selectionAsync` |
| Icon button tap | `selectionAsync` |
| Habit complete — press phase | `impact Medium` at press-in (60ms) |
| Habit complete — resolve phase | `notification Success` at 500ms |
| Streak milestone (7/30/66 days) | `notification Success` + custom 3-transient pattern via CHHapticEngine |
| Long-press start (e.g., delete confirm) | `impact Heavy` |
| Drag reorder swap | `selectionAsync` |
| Drag drop | `impact Medium` |
| Swipe action reveal (threshold crossed) | `impact Light` |
| Swipe action fire (commit) | `impact Medium` |
| Pull-to-refresh trigger | `impact Medium` at threshold |
| Modal present | `impact Soft` |
| Modal dismiss | none — silence respects exit |
| Scroll bounce limit | `impact Soft` |
| Input validation error | `notification Warning` — gentle, not Error |
| Voice tap-to-talk start | `impact Medium` |
| Voice tap-to-talk end | `impact Light` |
| Voice command succeeded | `notification Success` |
| Voice command failed/ambiguous | `notification Warning` |

**Banned:**
- `notification Error` on routine interactions — too punitive
- `impact Heavy` on taps — reserved for destructive confirms only
- Per-frame continuous haptics outside the Eye's ceremonial moments
- Cumulative/escalating haptics (reads gamified)

### 8.2 Audio (opt-in only, muted by default)

The shipped app is silent. The overhaul keeps that default. Audio becomes opt-in via Settings → "Hear the Orb? Off / Ceremony only / On."

When enabled:

| Moment | Source | Spec |
|---|---|---|
| Habit complete | Tibetan singing bowl, ~F3, softly struck | 0.8s tail, -24 LUFS, ambient session |
| Streak milestone (7/30/66) | Bowl + low drone C2 | Layered, 1.8s tail |
| Year milestone (365) | Three bowls, slow arpeggio F3→A3→C4 | 1.6s, with 2s reverb |
| Eye dilation | Subtle whoosh, very low frequency | Barely perceptible |
| Error / ambiguous voice | NONE | Silence is the correct response |

All sounds: 48kHz mono, -16 LUFS, `.caf` format, ≤1.2s, room-toned.

`AVAudioSession.Category.ambient` with `.mixWithOthers`. Never interrupt user's music. Never duck.

---

## 9. THE EYE — COMMAND TAB HERO

This is the most ambitious surface in the app. It is the voice interface, rendered as a 3D shader composition inspired by the eye-nebula reference image. Pupil, iris, combustion ring, nebula — all emitting outward against warm void.

### 9.1 What the Eye does (feature preservation)

The Eye is the Command tab. Tapping the tab takes the user full-screen into the Eye. Tapping the Eye begins voice input. All features from the current Voice Orb are preserved:

- **Morning intention.** User taps the Eye in the morning, speaks their intention for the day, the Eye listens and confirms. The intention is saved and surfaced on Home as today's focus.
- **Evening reflection.** User taps the Eye in the evening, speaks about their day. The AI reflects back what was intended vs. what happened, using context from mandates, habits, calendar, and Health.
- **Utility commands.** User speaks any of:
  - "Remind me to brush my teeth tonight at 10pm" → creates reminder in Inbox with time
  - "Add a recurring calendar block at 9pm called bedtime routine" → creates recurring block in Apple Calendar, syncs back to Orbit
  - "Mark meditation as done for today" → completes the habit
  - "Add a new habit: read 20 minutes, daily" → creates habit with schedule
  - "What's my streak on stillness" → speaks or displays the answer
  - "Read back my mandates" → displays mandates as scrollable cards
- **AI has full context:** mandates, today's habits, Apple Health data (steps, sleep, heart rate), calendar events, time of day, weather. The AI routes intents through Apple's on-device Foundation Models (iOS 18+) with deterministic grammar fallback on older devices.
- **Conversational follow-up.** If the user's command is ambiguous ("remind me to call mom"), the Eye asks one clarifying question in cream text under the composition: *"When?"* The user answers; the Eye confirms and closes the flow. Never more than two exchanges. Never a chat thread.

### 9.2 Visual composition (four Skia shader layers)

All four layers composited in a single Skia Canvas. The Eye fills the screen; layers are concentric around the center.

**Layer 1 — Pupil.** Pure black `#000000` circle, radial gradient from center to edge where edge fades to `#06060C` (void). Default radius 40pt. Animates to 140pt on dilation. No shader — plain Skia `Circle`.

**Layer 2 — Iris (SkSL shader).** The teal-cyan ring with gold fleck striations. Inner radius matches pupil; outer radius 240pt at ambient, 320pt when dilated.

```glsl
// iris.sksl
uniform float time;
uniform float innerRadius;
uniform float outerRadius;
uniform float glimmerPhase;
uniform float2 center;

const float PI = 3.14159265;

float hash(float2 p) {
  p = fract(p * float2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

half4 main(float2 pos) {
  float2 offset = pos - center;
  float r = length(offset);

  // radial falloff
  if (r < innerRadius || r > outerRadius) return half4(0);

  // normalized radial position 0-1
  float rn = (r - innerRadius) / (outerRadius - innerRadius);

  // polar angle
  float theta = atan(offset.y, offset.x);

  // radial striations (noise sampled in polar)
  float striation = hash(float2(theta * 12.0, rn * 3.0));

  // base teal gradient radial
  half3 tealInner = half3(0.310, 0.835, 0.859);  // teal.bright
  half3 tealOuter = half3(0.165, 0.561, 0.596);  // teal.deep
  half3 base = mix(tealInner, tealOuter, half(rn));

  // gold fleck overlay — voronoi-like scattered sparks
  float fleck = hash(float2(floor(theta * 24.0), floor(rn * 6.0)));
  float fleckMask = smoothstep(0.88, 0.92, fleck);
  half3 gold = half3(0.831, 0.627, 0.337);

  // glimmer — modulate fleck intensity over time
  float glimmer = 0.5 + 0.5 * sin(time * 1.8 + glimmerPhase * 6.28);

  // combine
  half3 color = base + gold * half(fleckMask * glimmer * 1.4);

  // striation dimming
  color *= half(0.7 + 0.3 * striation);

  // edge fade
  float edgeFade = 1.0 - smoothstep(outerRadius * 0.92, outerRadius, r);
  float innerFade = smoothstep(innerRadius, innerRadius * 1.05, r);

  return half4(color, half(edgeFade * innerFade));
}
```

**Layer 3 — Combustion ring (SkSL shader).** The orange-red fluid-noise ring that surrounds the iris.

```glsl
// combustion.sksl
uniform float time;
uniform float innerRadius;  // matches iris outerRadius
uniform float outerRadius;  // typically +120pt beyond iris
uniform float intensity;    // 0-2, default 1.0
uniform float2 center;

// two-octave curl noise for fluid flow
float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float a = hash(i);
  float b = hash(i + float2(1, 0));
  float c = hash(i + float2(0, 1));
  float d = hash(i + float2(1, 1));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float hash(float2 p) {
  return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
}

half4 main(float2 pos) {
  float2 offset = pos - center;
  float r = length(offset);

  if (r < innerRadius || r > outerRadius) return half4(0);

  float rn = (r - innerRadius) / (outerRadius - innerRadius);
  float theta = atan(offset.y, offset.x);

  // advected fluid noise
  float2 flowUV = float2(theta * 4.0 + time * 0.3, rn * 2.0 + time * 0.15);
  float n1 = noise(flowUV);
  float n2 = noise(flowUV * 2.0 + float2(time * 0.2, 0));
  float fluid = n1 * 0.6 + n2 * 0.4;

  // warm gradient
  half3 amberBright = half3(0.961, 0.627, 0.290);  // amber
  half3 amberDeep = half3(0.910, 0.518, 0.220);    // amber.deep
  half3 amberCore = half3(0.663, 0.271, 0.125);    // amber.core
  half3 color = mix(amberBright, amberDeep, half(rn * 0.7));
  color = mix(color, amberCore, half(rn * rn));

  // fluid masking
  float mask = smoothstep(0.3, 0.7, fluid);

  // edge fades
  float innerFade = smoothstep(innerRadius, innerRadius * 1.08, r);
  float outerFade = 1.0 - smoothstep(outerRadius * 0.85, outerRadius, r);

  return half4(color * half(intensity), half(mask * innerFade * outerFade * 0.85));
}
```

**Layer 4 — Nebula (SkSL shader).** Purple-pink cosmic atmosphere wisps.

```glsl
// nebula.sksl
uniform float time;
uniform float centerRadius;
uniform float outerRadius;
uniform float2 center;
uniform float2 resolution;

// fbm with 4 octaves
float fbm(float2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * noise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

half4 main(float2 pos) {
  float2 offset = pos - center;
  float r = length(offset);

  if (r < centerRadius) return half4(0);

  float rn = (r - centerRadius) / (outerRadius - centerRadius);

  // slow-drifting low-frequency noise
  float2 uv = offset * 0.002 + float2(time * 0.015, time * 0.008);
  float cloud = fbm(uv);

  // purple/magenta gradient
  half3 magenta = half3(0.722, 0.227, 0.431);   // nebula.magenta
  half3 violet  = half3(0.431, 0.165, 0.561);   // nebula.violet
  half3 deep    = half3(0.165, 0.102, 0.243);   // nebula.deep

  half3 color = mix(magenta, violet, half(rn));
  color = mix(color, deep, half(rn * rn));

  // radial falloff — nebula fades into void at edges
  float falloff = 1.0 - smoothstep(0.4, 1.0, rn);

  // opacity modulated by cloud noise
  float alpha = cloud * falloff * 0.18;

  return half4(color, half(alpha));
}
```

All four layers share a single `time` uniform. Layers composited bottom-up: nebula → combustion → iris → pupil.

### 9.3 Motion modes (reiterated from §7.5)

- **Ambient** — default idle state. Iris glimmer 0.3Hz. Combustion fluid-flow. Nebula drift. Pupil at 40pt.
- **Listening** — user tapped Eye, mic active. Pupil dilates 40→140pt over 600ms. Combustion intensity doubles. Iris glimmer 0.6Hz. Voice waveform overlay on iris.
- **Processing** — mic ended, AI parsing. Pupil holds at 140pt for 800ms. Combustion single-pulse. On completion, combustion flares to 150% for 400ms.

### 9.4 Voice input pipeline

**Speech-to-text:** Native iOS `SFSpeechRecognizer` via `expo-speech-recognition` wrapper. On-device recognition preferred (free, private). Fallback to server-side recognition if device doesn't support on-device.

**Intent parsing:** Two-tier.

1. **Deterministic grammars (fast path).** Regex + state machine for common commands:
   - `/remind me to (.+?) (at|on|tomorrow|tonight)/i` → reminder intent
   - `/add.*calendar block.*at (\d+).*called (.+)/i` → calendar intent
   - `/mark (.+?) (as )?done/i` → completion intent
   - `/what'?s my streak on (.+)/i` → query intent
   - `/read (back )?my mandates/i` → display intent
   - `/add (a )?new habit.*?[:\-]\s*(.+)/i` → habit creation intent
   - Morning patterns: `/my intention (for today )?is (.+)/i`, or just freeform speech at morning hours
   - Evening patterns: `/today I (.+)/i`, or freeform at evening hours

   If grammar confidence is high (>0.8 match score), execute directly.

2. **Apple Foundation Models (iOS 18+ fallback).** On ambiguity, pass transcript + context (time of day, recent commands, app state) to on-device Foundation Model with a structured-output prompt returning `{ intent, entities }`. Free on modern iPhones, private, low-latency.

**Feedback:**

After command execution, the Eye does one of three feedback patterns:

- **Success (unambiguous action).** Combustion does a warm 150% flare lasting 400ms, then settles. Cream text appears below the Eye in Fraunces Light Italic 22pt: *"Reminder set for 10:00 pm."* Fades after 3 seconds. Eye returns to ambient.
- **Ambiguous (needs clarification).** Combustion stays teal (no warm flare). Cream text appears below Eye in Fraunces italic 22pt: *"When?"* or *"Which habit?"* Eye stays in listening mode for follow-up. Max one follow-up; if still ambiguous, fall to error.
- **Error (can't parse).** Combustion stays teal. Cream text below Eye: *"I heard \"brush my toothbrush.\" Tap to try again."* No scolding, no error chime. Eye returns to ambient after 4s or on tap.

### 9.5 Eye tab layout

```
┌────────────────────────────┐
│                            │
│                            │
│                            │
│        [nebula]            │
│      [combustion]          │
│       [iris]               │
│      [pupil]               │
│                            │
│                            │
│                            │
│                            │
│   [feedback text space]    │
│                            │
│      [Tap to talk]         │  ← primary pill CTA
│                            │
└────────────────────────────┘
          HOME COMMAND ORBIT
           (tab bar)
```

The Eye sits vertically center, slightly above geometric center (golden ratio, 38% from top). The "Tap to talk" pill sits at the bottom-center-safe-area +48pt. Feedback text space lives between the Eye's bottom edge and the CTA pill, reserved for cream italic confirmations/clarifications.

When the Eye is in listening mode, the "Tap to talk" pill becomes "Tap to send" (solid teal fill). When processing, the pill disables and shows a teal ring progress indicator.

The tab bar remains visible during ambient and processing. During listening, tab bar fades to 40% opacity to focus attention on the Eye.

### 9.6 Accessibility

**Reduce Motion.** Shader ambient animation freezes on a static beautiful frame (pre-generated JSON seed). Pupil dilation on listening still occurs (semantic, not decorative). Combustion pulse on processing becomes an opacity flash. Voice waveform becomes a static amplitude bar.

**Reduce Transparency.** Nebula layer removed entirely. Combustion becomes a solid gradient ring (no fluid noise). Iris becomes flat teal-to-teal-deep radial. Pupil unchanged.

**VoiceOver.**
- Eye container: "The Eye. Voice command input. Double tap to speak."
- During listening: "Listening. Speak your command."
- During processing: "Processing your command."
- After success: Read the confirmation text aloud automatically.

**Battery / thermal.** Eye rendering is expensive (~3-5% extra battery per hour of active use). On:
- Low Power Mode: drop to 30fps, disable nebula drift, freeze combustion flow
- `thermalState == .fair`: same as Low Power Mode
- `thermalState == .serious`: combustion becomes static gradient, nebula removed
- `thermalState == .critical`: render the Reduce Motion static version

### 9.7 Rendering stack

- `@shopify/react-native-skia` ^2.x for shader layers (all four shaders as `RuntimeEffect`)
- Reanimated 4 shared values driving shader uniforms (`time`, `dilation`, `intensity`, `glimmerPhase`)
- `expo-speech-recognition` ^1.x for STT
- Native `SFSpeechRecognizer` bridge for on-device path
- Apple Foundation Models via `ExpoCoreML` bridge (iOS 18+)
- `expo-haptics` for haptic feedback

No Filament, no RealityKit, no SceneKit. The Eye is shader-only. This is intentional: shaders are fully reactive (every uniform can animate live), cheaper than 3D geometry for this use case, and don't require bundled asset files.


---

## 10. COMPONENT LIBRARY

Every component below references tokens from §4 (color), §5 (type), §6 (material), §7 (motion).

> **Color values reconciled to v3 stellar (2026-06).** Inline literals in this section were updated from the v2 warm-cream palette to v3 values (pure-white text, cool void, electric teal, brightened gold, frosted-glass surfaces). **§4 (Color) remains the canonical source** — if any literal below ever drifts from §4, §4 wins. Amber appears only where v3 still permits it (milestone gradient in §10.14, milestone state of the flame glyph in §10.17); it is retired from default utility everywhere else per §4.6.

### 10.1 Frosted-glass card (default)

```tsx
<Card>
  ...content...
</Card>
```

Specification (canonical material stack in §6.1):
```
background: surface (rgba(8,10,18,0.68)) over a <BlurView intensity={25} tint="dark"/>
border: 1px rgba(255,255,255,0.28) — luminous-white edge (tokens.color.luminousEdge)
borderRadius: 16pt
padding: 20pt
overflow: hidden (clips BlurView + accent bar + inset glow)
overlays (in order):
  - inset highlight glow (linear gradient from rgba(255,255,255,0.04) at top 0% to transparent at 18%)
  - grain overlay: DEFERRED in v3 (§6.4) — the cosmic backdrop + BlurView supply texture
on the outer wrapper (OUTSIDE overflow:hidden):
  - shadow (ambient gold halo):
    - shadowColor: rgba(229,186,110,0.28)  — the shared ambientGlow (§4.9)
    - shadowRadius: 36pt
    - shadowOffset: {0, 8}
    - shadowOpacity: 1
    - Android: elevation 6
  - corner glows (optional, cornerGlow prop — NEX-158): luminous-white corner
    accents, absolute overlay; off by default, primary cards only (§6.2)
pressedState:
  - background: surface.elevated (rgba(12,14,22,0.82)) over BlurView intensity 35
  - edge opacity: 0.28 → 0.40
  - transition: motion.quick
  - haptic: selectionAsync
```

### 10.2 Tracked-caps section header

```tsx
<SectionHeader>THIS WEEK'S WINS</SectionHeader>
```

Specification:
```
typography: label.tracked.lg
  - font: Inter SemiBold 600
  - size: 13pt
  - tracking: +0.16em
  - transform: uppercase
color: text.muted (#9AA3B5)
marginBottom: 16pt (standard) | 20pt (major section)
marginTop: 24pt (after previous content) | 12pt (after another header)
optional right-aligned action:
  - typography: label.tracked.sm
  - color: gold
  - tappable, haptic: selectionAsync
  - pattern: "EDIT", "TAP FOR DETAILS", "+ START REVIEW"
```

Every section in every tab gets this treatment. No exceptions.

### 10.3 Today's Habits row

The ceremonial habit-completion row. Replaces current habit checkboxes with a richer treatment.

```tsx
<HabitRow
  title="Meditation"
  emoji="🧘🏽"
  streak={18}
  completed={false}
  onComplete={...}
/>
```

Specification:
```
height: 72pt
paddingHorizontal: 20pt
background: transparent (sits inside parent Card or void)
bottomDivider: 0.5pt rgba(255,255,255,0.06), last row has no divider

Layout: horizontal
  [checkbox: 28pt circle]
  [gap: 16pt]
  [text column, flex]
    [title: title.card, text (#FFFFFF)]
    [meta: label.tracked.sm, text.muted (#9AA3B5)]  "DAILY · 2x/DAY"
  [streak chip, right-aligned]

Checkbox (default state):
  - 28pt circle
  - border: 1.25pt text.muted
  - fill: transparent
  - interior: empty

Checkbox (checked state):
  - fill: radial gradient from teal.bright center to teal edge
  - interior: text (#FFFFFF) checkmark, 1.5pt stroke
  - ambient glow: teal at 30%, radius 14pt, fades over 600ms

Checkbox animation on tap (800ms total):
  t=0:    scale 1.0, haptic impact.medium
  t=60:   scale 0.82 (press-in)
  t=180:  scale 1.14
  t=220:  radial fill pours from center over 220ms
  t=400:  white checkmark Skia path draws via dashoffset over 180ms
  t=500:  haptic notification.success
  t=600:  ambient glow halo fades
  t=800:  scale resolves to 1.0

Title (completed state):
  - opacity: 0.55
  - NO strikethrough
  - short gold hairline (16pt wide, 0.5pt thick) appears left of title, inset 4pt from checkbox
  - meta text unchanged

Streak chip:
  - height: 24pt, paddingHorizontal: 10pt
  - borderRadius: 12pt (pill)
  - background: rgba(229,186,110,0.10) (gold.wash)
  - leftIcon: custom flame glyph (NOT emoji) — 1.5pt stroke gold
  - label: label.tracked.sm, color: gold (#E5BA6E)
  - text: "18D" or "2X/DAY"
  - no border

Long-press: opens edit sheet (bottom sheet, medium detent)
  - haptic: impact.heavy
Swipe-right: reveals [SKIP] [ARCHIVE] actions
Swipe-left: reveals [SNOOZE] action
```

### 10.4 Primary CTA pill (Tolan-style)

```tsx
<PrimaryPill icon="mic">Tap to talk</PrimaryPill>
```

Specification:
```
height: 56pt
minWidth: 200pt
paddingHorizontal: 32pt
borderRadius: 9999pt (fully rounded)
background: text (#FFFFFF) — white fill, Tolan-style
color: text.inverse (#06060C)
typography: button.primary (Inter SemiBold 600, 16pt, +0.01em)

leftIcon (optional):
  - size: 18pt
  - strokeWidth: 1.5pt
  - color: text.inverse
  - marginRight: 8pt

pressedState:
  - scale: 0.97
  - background: rgba(255,255,255,0.92) (white dimmed 8%)
  - transition: motion.quick
  - haptic: impact.light

disabled:
  - background: rgba(255,255,255,0.25)
  - color: rgba(6,6,12,0.35)

loading:
  - label replaced with 18pt Skia ring spinner in text.inverse
  - 1.1s per revolution

shadow (ambient glow):
  - shadowColor: rgba(255,255,255,0.14)
  - shadowRadius: 20pt
  - shadowOffset: {0, 0}
```

**Addendum (2026-08-06) — the default variant is now `opal`.** The owner picked
the OPAL glass treatment from the button lab (`/redesign/button-lab`) after the
craft pass in `docs/design/explorations/2026-08-06-button-background-marriage-v2.md`
and the teardown in `docs/design/explorations/2026-08-06-opal-button-study.md`:
a dim gold → warm-gleam → teal horizontal bloom over BlurView 45 + `color.surface`,
with a 1pt top rim, a floor shade, and quiet two-stage halos. The white `cream`
fill above remains available as `variant="cream"` but is no longer the default.
Render budget: ≤1 hero pill per screen, ≤2–3 full glass buttons per scrolling view,
and compact buttons in long lists drop the BlurView (each one is a live
`UIVisualEffectView`, so a list of them is real render cost).

### 10.5 Secondary button (outline)

```tsx
<SecondaryButton>EDIT</SecondaryButton>
```

```
height: 52pt
paddingHorizontal: 24pt
borderRadius: 9999pt
background: transparent
border: 1pt rgba(255,255,255,0.22)
color: text
typography: button.tracked (Inter SemiBold 600, 13pt, +0.14em, UPPERCASE)

pressedState:
  - background: rgba(255,255,255,0.06)
  - border: rgba(255,255,255,0.40)
  - transition: motion.quick
  - haptic: selectionAsync
```

### 10.6 Gold-outlined button (rare accent)

Used sparingly for actions that should feel earned: "PREVIEW", "+ ADD ITEM", "+ START REVIEW".

```
height: 44pt (compact) | 52pt (default)
paddingHorizontal: 20pt
borderRadius: 9999pt
background: transparent
border: 1pt gold (#E5BA6E)
color: gold
typography: button.tracked

pressedState:
  - background: rgba(229,186,110,0.10)
  - border: gold.bright
  - haptic: selectionAsync
```

Under-5%-gold rule (§4.4): max one per screen unless the screen is explicitly gold-dense (Align tab mandate list).

### 10.7 Icon button (circular)

```tsx
<IconButton icon="gear" onPress={...} />
```

```
size: 44pt (full hit target)
visibleCircle: 40pt
background: rgba(255,255,255,0.05)
border: 0.5pt gold.hairline
icon: 18pt, 1.5pt stroke, color: text

pressedState:
  - background: rgba(255,255,255,0.12)
  - scale: 0.94
  - haptic: selectionAsync
```

### 10.8 Text input (single line)

```tsx
<TextInput label="MANDATE" placeholder="I am someone who..." />
```

```
height: 56pt
background: transparent
borderBottom: 1pt rgba(255,255,255,0.14)
paddingBottom: 14pt
paddingTop: 22pt

label (above input, static):
  - position: top
  - typography: label.tracked.sm
  - color: text.muted
  - marginBottom: 8pt

inputText:
  - typography: title.section (Inter SemiBold 600, 22pt)
  - color: text

placeholder:
  - color: rgba(138,138,138,0.5)
  - typography: matches inputText

caret:
  - color: teal

focused:
  - borderBottom color: teal
  - transition: 180ms ease

error:
  - borderBottom color: state.error
  - helper text appears below in state.error, 13pt

disabled:
  - opacity: 0.4
```

### 10.9 Text input (multi-line, for reflection/journal)

```
minHeight: 160pt
background: surface
border: 0.5pt gold.hairline
borderRadius: 14pt
padding: 20pt
typography: body.lg (Inter Regular 17pt, 1.53 LH)
color: text

placeholder:
  - "Reflect..." in Fraunces Light Italic, 17pt, color: text.muted

focused:
  - shadowColor: rgba(63,201,212,0.12) (teal @12%)
  - shadowRadius: 20pt

counter (optional, bottom-right):
  - typography: label.tracked.sm
  - color: text.muted
```

### 10.10 Tab bar (bottom, 5 tabs)

The shipped app already has 5 tabs with icons + small labels. The overhaul refines this.

```
height: 68pt + safeAreaBottom
background: frosted — transparent tabBarStyle + BlurView (tint="dark", intensity 75) + faint white top hairline (NEX-146, 2026-06; was solid voidDeep)
topBorder: 0.5pt rgba(255,255,255,0.08)
paddingTop: 10pt
paddingBottom: safeAreaBottom + 4pt

tabs: [Home] [Command] [Orbit] [Inbox] [Align]

each tab:
  - width: equal flex
  - layout: vertical center
  - icon: 24pt, 1.5pt stroke
  - label: label.tracked.micro (9.5pt, +0.20em, UPPERCASE)
  - gap between icon and label: 4pt

icon color:
  - active: gold
  - inactive: text.muted

label color:
  - active: gold
  - inactive: text.muted

active indicator:
  - the active tab's icon + label are both gold
  - no additional underline, dot, or pill
  - transition on tab change: 180ms ease (color cross-fade)

pressed:
  - icon scale 0.92, 120ms, return to 1.0 over 140ms
  - haptic: selectionAsync

during listening mode on Command tab:
  - tab bar fades to opacity 0.4
```

**Tab icons (from shipped app, preserved):**
- Home: house outline
- Command: microphone outline
- Orbit: 2x2 grid outline (calendar grid reference)
- Inbox: horizontal lines outline
- Align: triangle outline (pyramid/aspiration reference)

All icons at 1.5pt stroke, rounded line-caps only on Home (house) — every other icon uses butt caps (brutalist/engraved register).

### 10.11 Bottom sheet

```
library: @gorhom/bottom-sheet ^5.x
detents: [50%, 90%]

backdrop:
  # SUPERSEDED: this line predates v3-stellar and contradicts §4.10, which
  # defines the modal scrim as rgba(2,2,8,0.78) — the cosmic vignette that
  # replaced v2's warm near-black. tokens.color.scrim ships the §4.10 value and
  # src/components/ui/Sheet.tsx uses the token. §4.10 is authoritative.
  - background: rgba(2,2,8,0.78) (gradient.vignette, per §4.10)
  - blur: expo-blur intensity 30, tint dark

sheet:
  - background: surface.elevated (rgba(12,14,22,0.82)) over BlurView intensity 35
  - topCorners: 28pt
  - border: 0.5pt luminous-white hairline (rgba(255,255,255,0.10)) on top edge only
  - inset highlight glow: linear 180deg white@4% to transparent at 12%
  - grain: DEFERRED in v3 (§6.4)

handle:
  - width: 36pt
  - height: 4pt
  - borderRadius: 2pt
  - background: rgba(255,255,255,0.22)
  - marginTop: 10pt, centered

header:
  - paddingHorizontal: 24pt
  - paddingVertical: 16pt
  - title: title.section, color: text
  - closeButton: IconButton top-right (X icon, 16pt)
  - bottomBorder: 0.5pt gold.hairline at 6%

animation:
  - enter: motion.entry
  - exit: motion.exit
```

### 10.12 Full-screen modal

For ceremony moments: onboarding, paywall, composer flows. Not for bottom-sheet-appropriate content.

```
presentation: iOS native modal
statusBar: lightContent on void
header:
  - height: 56pt + safeAreaTop
  - background: void
  - leftAction: custom chevron-down 20pt (NOT iOS default back button)
  - rightAction: IconButton if needed
  - bottomBorder: none (void continues)

dismissAffordance:
  - swipe down from header or top 20% of screen
  - haptic on threshold: impact.light

transition:
  - enter: motion.entry, 350ms
  - exit: motion.exit, 200ms
  - full-cover slide, not zoom
```

### 10.13 Alignment Score ring (Home hero)

> **ADHD-pivot amendment (2026-06-16, §1.5 Law B):** the milestone flash is a *positive* ceremony only. No broken-streak / "you lost it" state on the ring; a missed day never turns the ring red or resets it. Milestone = cumulative moment, not a chain.

The alignment score displayed as a thin gold ring around the score numeral on Home. This is a small progress indicator, NOT a large 3D hero.

```
diameter: 180pt (outer edge)
strokeWidth: 3pt
trackColor: rgba(229,186,110,0.12) (gold @12%, faint background ring)
progressColor: gold (#E5BA6E)
startAngle: -90° (top)
capStyle: round
progressAnimation: motion.standard (250ms ease on value change)

contents (centered inside ring):
  - alignment score numeral (hero.numeric, 140pt Plex Mono) — value
  - qualitative word (poetic.hero, 28pt Fraunces italic) — below numeral, offset 4pt
  - "TODAY'S ALIGNMENT" (label.tracked.lg) — above numeral, offset 12pt

glow (subtle):
  - shadowColor: rgba(229,186,110,0.22)
  - shadowRadius: 32pt
  - ambient warmth, doesn't pulse

on streak milestone (7/30/66 day):
  - ring flashes amber (gradient.earned along arc) for 1.2s ceremony
  - returns to gold
```

### 10.14 Gradient milestone card (Gymshark-style, rare)

> **ADHD-pivot amendment (2026-06-16, §1.5 Law B):** "milestone" here means a **cumulative** achievement (lifetime reps / "back after a pause" / Nth completion), not a consecutive-day chain. The card celebrates; it never announces a broken or lost streak.

Appears only when user hits a 7/30/66/365-day streak milestone, or for weekly wins summary.

```
height: 168pt
paddingHorizontal: 20pt
paddingVertical: 24pt
borderRadius: 20pt
background: gradient.earned (amber gradient)
grain overlay: 10% overlay blend
innerVignette: radial, 110% from center, 0 → rgba(0,0,0,0.28)

typography:
  - eyebrow: label.tracked.lg, color: rgba(255,255,255,0.72)
  - title: Inter SemiBold 600, 28pt, color: white
  - body: body.md, color: rgba(255,255,255,0.78)
  - metric: Plex Mono Medium 500, 56pt, color: white

border: none (gradient provides edge)
shadow: none — ambient amber glow instead:
  - shadowColor: rgba(245,160,74,0.18)
  - shadowRadius: 40pt
```

### 10.15 Quiet empty state

```
layout: vertical center, paddingTop screenHeight * 0.18

optional tiny artifact:
  - size: 72pt
  - opacity: 0.5
  - static (no motion)

eyebrow: label.tracked.lg, color: text.muted, marginTop: 28pt
title: title.screen, color: text, center-aligned, maxWidth: 280pt
body: body.md, color: text.secondary, center-aligned, maxWidth: 320pt
cta: PrimaryPill or SecondaryButton, marginTop: 32pt
```

**Copy rule for empty states:** never imperative ("Tap to add"). Always contemplative ("The altar waits.", "Your mandates are the few sentences you refuse to live in contradiction to."). Consistent with the shipped app's voice.

### 10.16 Toast / notification pill

```
position: top, safeAreaTop + 12pt
height: 52pt
paddingHorizontal: 20pt
background: surface.elevated
border: 0.5pt gold.hairline
borderRadius: 9999pt
shadow:
  - shadowColor: rgba(0,0,0,0.45)
  - shadowRadius: 24pt
  - shadowOffset: {0, 12}

layout: [icon 16pt] [label] [optional action]

label: body.md SemiBold 500, color: text

variants (icon color):
  - success: teal
  - warning: gold
  - info: text.muted

enter: translateY -20 → 0, opacity 0 → 1, motion.entry
exit: translateY 0 → -8, opacity → 0, motion.exit
duration visible: 3200ms
haptic on enter: matches variant
```

### 10.17 Custom flame glyph (replaces emoji)

The shipped app uses the 🔥 emoji on streak indicators. The overhaul replaces this with a custom SVG glyph for visual consistency.

```
style: 1.5pt stroke, line-cap butt
color: gold (default) | amber (milestone state)
size: 10pt (inline) | 14pt (card) | 20pt (hero)
background: transparent
shape: stylized single-flame silhouette, 3 control points, narrow base, pointed tip
no fill, stroke only
```

Export from Figma as SF Symbols custom template for easy tinting. Ship at the three sizes.

### 10.18 Category accent bar

Used on Align tab mandate cards and Home "This Week's Wins" cards — a thin vertical gold bar on the left edge.

```
width: 3pt
height: full card height
color: gold
alignment: left edge, flush
borderRadius: 0 (sharp edge)

category variants (used on Align mandate cards — see app/(tabs)/align.tsx):
  - Business: gold (tokens.color.gold, #E5BA6E)
  - Vision:   teal (tokens.color.teal, #5FE0EA)
  - Personal: nebula-magenta (tokens.color.nebulaMagenta, #B83A6E)
    — v3 stellar: replaces v2's amber-for-Personal, since amber retired
    from default utility per §4.6. Nebula-magenta gives Personal its own
    identity drawn from the cosmic palette.
```

### 10.19 Generic list row

The utility row. Every settings-style line in the app — a label with a value, a
navigation target, a switch, a selection option — is this component. It is the
plain counterpart to §10.3's ceremonial habit row, which stays bespoke.

```tsx
<ListSection title="NOTIFICATIONS">
  <ListRow title="Morning Reminder" trailing="value-chevron" value="7:00 AM" onPress={…} />
  <ListRow title="Milestone Alerts" trailing="toggle" trailingAccessory={<Toggle … />} />
  <ListRow title="Version" trailing="value" value="1.0.0" />
</ListSection>
```

Specification:
```
minHeight: 56pt   (minHeight, never a fixed height — Dynamic Type)
paddingHorizontal: 16pt
title:    body.md.emphasis (Inter Medium 15pt), color text — NOT SemiBold.
          25 rows of SemiBold shout at once and flatten hierarchy; weight is
          not the lever here. White-vs-muted and the tracked §10.2 header do
          the structural work
subtitle: caption (Inter Medium 13pt), color text.muted, max 2 lines
footnote: caption, color gold — a warning or qualifier that must survive the
          subtitle's 2-line cap. Its own line, never concatenated into subtitle
leftIcon: 20pt monochrome glyph in a gutter, 12pt gap
divider:  0.5pt luminous-white hairline, BETWEEN rows only (never after the
          last), inset to the text column — 16pt plain, 48pt past an icon
          gutter. Adjacent rows inset to the DEEPER of the two
pressed:  background flash to surface.elevated at motion.quick (140ms)
haptics:  the row owns its press haptic (selection). A row hosting an
          interactive accessory fires NONE — the control's own haptic is the
          only one (single-haptic rule)

trailing (one of):
  none          nothing. The default for a row with NO action
  chevron       ›  the default for an ACTIONABLE row
  value         trailing text, body, color text.muted
  value-chevron both
  external      ↗  replaces the chevron whenever the tap LEAVES the app
  check         ✓  teal, selection lists — shown only when `selected`
  toggle        an interactive control (Toggle/Switch)
  custom        caller-supplied accessory

states: busy (trailing …) · selected (gold trailing value) · destructive
        (title state.error) · disabled (0.5 opacity)
```

**The trailing glyph says where the tap goes.** Three cases, and they are not
interchangeable:

```
chevron  ›   goes somewhere IN the app (pushes a route, opens a sub-screen)
external ↗   LEAVES the app (mailto, App Store, web)
none         acts in place (Back Up Now, Send myself a test summary)
```

A chevron is a promise of navigation, which is why `trailing` defaults to
`none` when a row has no `onPress` — and why a row that *performs* an action
reads as a plain row. The whole row is the button; it needs no glyph to say so.
Inventing an affordance for an action row is how a settings screen ends up with
twenty identical chevrons that mean three different things.

**Dynamic Type: text scales, ornament doesn't.** The title, subtitle and
footnote carry **no** `maxFontSizeMultiplier` — the row is `minHeight`, not
`height`, precisely so it grows with the user's type size (§17, and §1.5 UF-01
makes this gating). The trailing column caps at **1.3×**: it competes for
horizontal space against the text column, and a chevron rendered at 3× is
decorative noise, not information. A **text-bearing `trailingAccessory` must
apply that cap itself** — the kit renders the accessory as given, so the cap is
exported as `TRAILING_MAX_SCALE` for callers to use. Non-text controls (a
`Switch`) need nothing; they don't scale with type size. The trailing column
also `flexShrink`s and is bounded at 45% width, so even an accessory that
ignores the contract can never crowd out the text.

**The label must carry the row's full text — one composition rule, no
exceptions.** When the row is one accessibility element its children are not
individually focusable, so any text inside it that is absent from the label is
simply **never spoken**. That is not a per-slot concern to be patched as slots
are added; it is a single rule over every input the row can render:

```
title  ,  state  ,  subtitle  ,  footnote
          └─ the shown `value`, else `accessoryLabel`
```

*"Subscription, Annual, Cancel or change your plan"* — identity, then state,
then description, then caveat. The subtitle matters most here precisely because
the layout clips it at two lines: leave it out and a long description is
neither shown nor announced.

A **custom accessory is opaque to the kit** — it cannot read a badge or a plan
name — so name it with **`accessoryLabel`**, which feeds the rule above.
`accessibilityLabel` is a **total override**: supplying it means the caller owns
the entire announcement and nothing is appended, so using it merely to name an
accessory silently drops the subtitle. Reach for `accessoryLabel` first.

**Accessibility — the row takes one of three shapes**, and getting this wrong
silently strips controls from VoiceOver (the #389/#391 regression):

```
row IS the action        → one element, role=button, disabled honored
static informational row → one element, no role, NOT disabled, so
                           "Version, 1.0.0" reads as one thing
row HOSTS a control      → NOT an element: title, subtitle and the control
                           stay separately focusable, and the control keeps
                           its own role and on/off state
```

Interactivity is **declared, never inferred**: `trailing="toggle"` is
interactive by definition; a `custom` accessory must set `interactiveAccessory`.
Presence alone cannot tell a live button from a static status badge — and a
static badge is not announced at all unless the row's `accessibilityLabel`
says it.

**Grouping — `ListSection`.** One kit `Card padding="none"` per group, never
per row: each `Card` is a live `UIVisualEffectView`, so a per-row card turns a
settings screen into a scroll-jank generator. Rows own their padding so the
pressed flash reaches the card edge. The tracked-caps §10.2 header is opt-in
per screen — its `marginTop` re-flows existing groups.

**When NOT to use a row.** If each item carries its own card — its own fill,
border and `marginBottom` — it is a **card affordance**, not a row, and it
stays bespoke; grouping those into one `ListSection` merges distinct objects
into a single surface. Likewise a compact read-only line (a date-and-title
listing inside a larger step) is not a 56pt row, and a row whose *leading*
element is interactive (a checkbox) has no home here — the icon gutter is a
static glyph slot. Rows already inside an elevated surface use bare `ListRow`s
in their existing container rather than nesting glass inside glass.

Gold stays a seal (§19): a gold trailing is only for a trailing element that
*is* the action, and the ≤2-gold-elements-per-screen budget is the screen's
job, not the row's.

### 10.20 Toggle

The kit switch. Every on/off control in the app is this component — there are
no raw `Switch` elements outside it.

```tsx
<ListRow
  title="Milestone Alerts"
  trailing="toggle"
  trailingAccessory={
    <Toggle value={on} onValueChange={setOn} accessibilityLabel="Milestone Alerts" />
  }
/>
```

Specification:
```
geometry: stock platform Switch — unchanged. It is already accessible, already
          animated, and already reads as a switch to assistive tech. The kit
          owns the PALETTE and the HAPTIC, nothing else
track ON:  teal (#5FE0EA) — sacred-active, and success-is-teal is v3 canon
track OFF: luminous.edge.soft (white @ 12%)
thumb:     white in BOTH states — the TRACK carries the state; the thumb is a
           physical object
           iOS — set NOTHING. Setting thumbColor on iOS strips the grip's drop
           shadow (RN Switch docs); iOS already ships a white thumb with it
           Android — set explicitly; it has no white default
disabled:  dims the whole control (0.4), never a third palette
haptic:    the Toggle owns its value-change haptic (selection). A row hosting
           one fires NO press haptic — §10.19's single-haptic rule
```

**Gold is not a control state.** Switches used to wear gold tracks in three
different mixes (`gold@60`, a `goldTrackActive` token, and raw saturated gold),
which made routine controls read as earned ornament and let a settings screen
run past §19's 2-gold-element budget whenever several were on. Gold is a seal;
an on/off control is not a seal. `goldTrackActive` is retired.

**State is never colour-alone** (§17): thumb position, track colour, and the
platform's own on/off announcement each carry it independently.

**Label the Toggle, not the row.** On a `trailing="toggle"` row the row is
deliberately *not* a single accessibility element — the control must stay
reachable (§10.19, shape 3) — so the row's own label never reaches the switch,
and `ListRow`'s `accessoryLabel` is a **no-op there**. Pass
`accessibilityLabel` to the `Toggle` itself, or it announces as an unnamed
"switch, on".

**The row body must never drive the value.** A `trailing="toggle"` row changes
state only through the control. Wiring the row's `onPress` to flip the toggle
produces a state change with *no* haptic at all, because the row suppresses its
press haptic precisely so the control can own it.

### 10.21 Stepper

A value that **wraps** — an hour, a minute — nudged one step at a time.

```tsx
<Stepper
  value={hour}
  wrap={24}
  onChange={setHour}
  format={(h) => String(to12Hour(h).hour12)}
  accessibilityLabel="Morning Reminder hour"
  accessibilityValueText="7:15 AM"
/>
```

Specification:
```
form:    ‹  value  ›  — compact chevrons, NOT a 44pt-circle-and-pill cluster.
         Two of those either side of a value are a standalone control; this
         lives inside a list row and must read at row scale
targets: chevrons are 28pt visually with hitSlop to the 44pt floor (§19), so
         the touch area clears without changing layout
value:   numeric.sm (Plex Mono) — mono so digits don't change width as they
         change, which would make the chevrons jitter
wrap:    modular, never clamped. 23 → 0 is the whole point; min/max cannot
         express a clock
step:    snaps toward the direction of travel. From an off-grid 7 with step 5,
         up is 10 and down is 5 — never round-to-nearest, which would skip the
         value the user was aiming at
haptic:  the Stepper owns it, on one path shared by chevron taps AND the
         VoiceOver adjust action, so it can never double- or zero-fire
```

**One adjustable element, not two buttons.** The control is a single
`accessibilityRole="adjustable"` element and the chevrons are hidden from the
accessibility tree. VoiceOver users swipe up/down to change the value instead
of hunting two small glyphs, and there is exactly one code path for a change.
Leaving the chevrons exposed would publish three elements per stepper and two
competing ways to fire the same mutation.

**Speak the meaningful value, not the raw one.** `accessibilityValueText` gets
the whole time — *"7:15 AM"* — because an adjustable announcing a bare "11"
leaves out the one thing that makes a reminder time mean anything.

**Commit is debounced when a change is expensive.** Stepping is cheap to *look*
at and can be costly to *save*: in settings, every committed reminder time
reschedules all notifications and consumes lines from the notification-quote
pool. The display follows each press instantly; the write lands once the user
stops. Any consumer whose `onChange` triggers real work should do the same, and
must flush on unmount so a half-made edit is never lost.


### 10.22 DayPicker

Seven circles, Sunday first — the same index every `daysOfWeek` array in the app
uses. One component covers both selection modes; geometry, hit target and
accessibility are identical, only the toggle rule differs.

```tsx
<DayPicker mode="multi"  value={days} onChange={setDays} label="Repeats on" />
<DayPicker mode="single" value={weeklyDay} onChange={setWeeklyDay} label="Send on" />
```

Specification:
```
circle:   34pt, 1px hairline ring, transparent
selected: TEAL fill, textInverse letter
letter:   caption (Inter Medium 13pt), text.muted unselected
targets:  hitSlop 5pt each side, so a 34pt circle clears the 44pt floor (§19)
haptic:   the DayPicker owns it — one path for every selection
single:   tapping the selected day is a NO-OP, never a deselect ("no day" is
          not a valid weekly-summary state)
multi:    a day flips; emptying the selection IS allowed, because the forms
          that use it gate save on non-empty and render their own error
```

**Selected is teal, not the reference's white.** Three places did this three
ways: two filled the circle with solid **gold**, one used a gold wash. Habit
editing defaults to *all seven days selected*, so a routine control was
painting a whole row in the colour §19 reserves as a seal. Teal is the system's
active signal — the same one the Toggle's ON track uses — and costs nothing
from the gold budget. White was the other candidate and was rejected: on a
cosmic ground white is the text and star material, and a row of solid white
discs reads louder than the choice it represents.

**Announce the day, not the abbreviation.** The circle renders "Mo"; the
accessible name is "Monday". An abbreviation is a compression for the eye and
means nothing to the ear. Labels live in `src/utils/recurrence.ts`, not the kit
— app state and services need the same words and must never import from
`src/components/ui`.

**Single-select hands back a number.** The props are discriminated on `mode`, so
a single-select caller cannot accidentally persist two days — which a shared
`number[]` API would allow, and which the compiler would not catch in the
`@ts-nocheck` files that consume this.

**It does not fit a row's trailing slot.** Seven 34pt circles need ~238pt before
gaps, against §10.19's 45% trailing cap. A day picker is a full-width block
under its label, never a `ListRow` accessory.


---

## 11. SCREEN SPECIFICATIONS — ALL FIVE TABS

### 11.1 Home tab (MAJOR REDESIGN)

The Home tab is redesigned around the **ceremonial entry, operational depth** principle. Above the fold is a meditative ritual. Below the fold is the full operating system.

#### The fold (above, first visible on open)

Scrolled to top, what the user sees:

```
┌──────────────────────────────┐
│ [status bar]                 │
│                              │
│ [greeting cap + settings]    │  ← small header
│                              │
│       [80pt breathing]       │
│                              │
│                              │
│      ┌────────────┐          │
│      │   ring     │          │  ← 180pt gold ring
│      │            │          │
│      │    76      │          │  ← 140pt Plex Mono
│      │            │          │
│      │   Steady   │          │  ← 28pt Fraunces italic
│      │            │          │
│      └────────────┘          │
│                              │
│   TODAY'S ALIGNMENT          │  ← tracked caps
│                              │
│       [60pt breathing]       │
│                              │
│   ─────────────────          │  ← hairline divider
│                              │
│   TODAY'S HABITS             │  ← tracked caps
│                              │
│   [habit row 1]              │
│   [habit row 2]              │
│   [habit row 3]              │
│   [habit row 4]              │
│                              │
│   TODAY'S HORIZON            │  ← tracked caps
│                              │
│   [next calendar event]      │
│                              │
│                              │
└──────────────────────────────┘
        [tab bar: HOME*]
```

**Header bar (minimal):**
- Left: greeting cap "Good afternoon, Alex." — Inter SemiBold 24pt. Dynamic: "Good morning" 5-11am, "Good afternoon" 11am-5pm, "Good evening" 5-10pm, "Late night" 10pm-5am. Below greeting: "Wednesday, April 22" in caption style, text.muted.
- Right: gear Icon Button (settings) — 40pt circle, subtle border, no label

**The alignment ring hero:**

At the visual center of the fold:
- 180pt gold ring (AlignmentScoreRing component from §10.13)
- Ring stroke progress reflects today's alignment (0-100%)
- Inside ring, centered:
  - 140pt Plex Mono numeral showing today's score (e.g. "76")
  - Below numeral: 28pt Fraunces Light Italic qualitative word (Rising / Steady / Holding / Drifting / Quiet — mapped to bands: 90+/75-89/60-74/45-59/<45)
  - Above numeral: small tracked-caps "TODAY'S ALIGNMENT" label

Tapping the ring or score opens a bottom sheet with the full Weekly Debrief (score trend, 7-day chart, KPIs).

**Today's Habits section:**

- Tracked-caps header "TODAY'S HABITS" with right-aligned "MANAGE" action (opens habit management sheet)
- Vertical list of today's scheduled habits (auto-scheduled, no manual pinning) using HabitRow component from §10.3
- Maximum 5 habits visible; if more exist, a subtle "+ X more" text at bottom expands the list
- If all habits complete: the list shows with subtle gold hairlines beside each title. An ambient teal glow surrounds the Alignment Ring.

**Today's Horizon section:**

- Tracked-caps header "TODAY'S HORIZON"
- A single card showing the next calendar event:
  - "UP NEXT" in tracked-caps
  - Event title in title.section (22pt Inter SemiBold)
  - Time in numeric.display (36pt Plex Mono) with gold color if within next 2 hours

#### Below the fold (scroll to reveal)

The user scrolls and the rest of the operating system appears, each section separated by generous vertical whitespace (48pt between sections) so each feels like a separate gallery room:

1. **Morning Brief / Evening Reflection** (existing, enhanced)
   - Tracked-caps header "MORNING BRIEF" (AM) or "EVENING REFLECTION" (PM)
   - AI-generated 2-4 bullet points in body.lg on a frosted-glass card with a gold left accent bar
   - Refresh icon top-right, tappable to regenerate
   - Each bullet begins with a small triangular marker glyph (▸) in gold

2. **This Week's Wins** (existing)
   - Tracked-caps header with "EDIT" action right-aligned
   - Frosted-glass card containing 3-5 win bullets with gold diamond markers (◆)
   - Each bullet is Fraunces Light Italic 17pt — these are identity-level wins

3. **Today's Win** (existing, enhanced)
   - Tracked-caps header "TODAY'S WIN"
   - Frosted-glass card with gold left accent bar
   - User's self-declared win for the day in Fraunces Light Italic 22pt
   - "TAP TO EDIT" subtle action beneath

4. **Cut or Commit** (existing, enhanced)
   - Tracked-caps header "CUT OR COMMIT"
   - Frosted-glass card with a gold hairline/left accent (attention-needed) instead of the default white hairline — amber retired from utility per §4.6, gold now carries "attention-needed"
   - List of items sitting untouched, each with:
     - Title in title.card
     - Days untouched in numeric.md, right-aligned, color: state.error (warm red) if >14d
   - Body copy: "These have sat untouched. Go to Inbox to decide." in body.md, text.muted

5. **Weekly Debrief** (existing, PALETTE FIX)
   - Tracked-caps header "WEEKLY DEBRIEF" with "TAP FOR DETAILS ›" action
   - Frosted-glass card containing:
     - 7-day bar chart, one bar per day (Thu-Wed in the screenshot example)
     - Bars: **teal (#5FE0EA) for high-performing days, textMuted (#9AA3B5) for low-performing days** — replaces the current generic green/yellow. Amber is NOT used here (retired from utility per §4.6); a quiet day reads quiet, not alarmed.
     - Threshold: >75% habits complete = teal, 50-75% = textSecondary (#E8EEF6), <50% = textMuted (#9AA3B5)
     - Day labels below bars in caption style
   - Three KPIs below the chart:
     - Habits: numeric.display in teal if ≥80%, textMuted if <60%, white otherwise
     - Avg Score: numeric.display in white
     - Tasks: numeric.display colored same as habits
   - Tap opens full Weekly Debrief sheet with full analytics

6. **Focus** (existing, enhanced)
   - Tracked-caps header "FOCUS"
   - Gold left accent bar on card
   - AI-generated weekly focus line in Fraunces Light Italic 22pt (the one-sentence direction for next week)

7. **Your Anchor** (existing)
   - Tracked-caps header "YOUR ANCHOR" with "EDIT" right action
   - Frosted-glass card
   - Content: user's anchor habit — the keystone habit everything else builds on

8. **Horizon Reviews** (existing)
   - Tracked-caps header "HORIZON REVIEWS" with "+ START REVIEW" right action
   - Horizontal scroll of past weekly review cards
   - Each card has gold left accent, tracked-caps "WEEKLY" label, week-of date, first 3 lines of review preview in body.md truncated

9. **Getting Started** card (appears only for new users, first 7 days)
   - Tracked-caps "GETTING STARTED"
   - Gold left accent bar
   - Contextual guidance in body.lg that evolves each day: "Day 1 — Welcome.", "Day 2 — you logged a habit yesterday. Keep the momentum.", etc.
   - Disappears after day 7 or on manual dismiss

10. **Tip** card (occasional, AI-generated)
    - Tracked-caps "TIP"
    - Frosted-glass card with subtle teal hairline (not gold)
    - Body copy: "Speak to the orb in Command to add tasks hands-free."
    - Dismissible (X button right)

#### Home scroll behavior

- Pull-to-refresh: teal hairline grows top-down from 0 to 64pt as user pulls; at threshold, hairline flashes and refreshes content; haptic impact.medium at threshold
- The header "Good afternoon, Alex." does NOT collapse on scroll — it stays as a subtle top anchor
- Scroll-linked parallax: NONE (stone doesn't parallax)

#### Home first-open ceremonial animation

On first open of the app each day (tracked by stored timestamp), the Home content fades in with staggered entries:

- t=0ms: void background renders, grain begins, tab bar appears
- t=300ms: alignment ring outline fades in (opacity 0 → 1, 400ms)
- t=500ms: alignment score numeral fades in (opacity 0 → 1, 400ms)
- t=700ms: qualitative word ("Steady") fades in with +4pt translateY (opacity 0 → 1, 350ms)
- t=900ms: "TODAY'S ALIGNMENT" label fades in
- t=1100ms: "TODAY'S HABITS" section fades in (header + rows, staggered 80ms apart)
- t=1800ms: rest of below-fold content prepared (no visible animation needed since scrolled)

Total: 1.8 seconds before Home is fully interactive. On subsequent opens during the same day, content appears instantly (no ceremony).

Skippable via tap (any tap during animation completes it instantly).

### 11.2 Command tab (THE EYE)

Covered in detail in §9. Recap:

- Tapping Command tab takes user full-screen into Eye
- Eye sits vertically at 38% from top, large (takes ~60% of visible height)
- "Tap to talk" primary pill at bottom center + 48pt above tab bar
- Cream text space between Eye bottom and pill for feedback/clarification text
- Tab bar remains visible at all times (fades to 40% opacity during listening mode)
- Status bar always light content

No scrolling on this tab. The Eye is the entire experience.

### 11.3 Orbit tab (calendar + recurring to-dos)

Preserves the existing Orbit layout (calendar month on top, today's recurring tasks below) with material and typography upgrades.

**Header:**
- Minimal: "+ ADD ITEM" gold-outlined button top-right
- No greeting

**Month calendar card:**
- Frosted-glass card (translucent surface + BlurView, luminous-white hairline; grain deferred per §6.4)
- Month/year label in title.section + chevron-right for picker
- Week-day headers in label.tracked.sm (SUN MON TUE...)
- Date numerals in Inter SemiBold 600, 20pt, color: text
- Prev/next chevrons in teal (was blue in shipped app, now teal)
- Today's cell: **teal-filled circle (40pt, teal.bright), text.inverse numeral** (was blue, now teal)
- Selected cell (if different from today): outlined teal circle
- Other month's trailing/leading days: opacity 0.3
- Cells with events: small gold dot beneath numeral (3pt)

**Today's Horizon section:**
- Tracked-caps header "TODAY'S HORIZON" with right-aligned "23 EVENTS" count label
- Gold left accent bar on container
- Calendar events from Apple Calendar, displayed as compact rows:
  - Time in numeric.sm Plex Mono (leftmost)
  - Title in title.card
  - Location in caption if available

**Day's To-Do section:**
- Tracked-caps header "DAY'S TO-DO"
- List of recurring to-dos for today
- Each row: ceremonial checkbox (same treatment as HabitRow §10.3) + title + drag handle (right)
- Drag handles: 3 horizontal bars, 14pt, opacity 0.3, color: text.muted
- Swipe-right actions: Skip, Snooze
- Swipe-left: Edit, Delete
- Long-press: edit sheet

**Adding a to-do:**
- "+ ADD ITEM" button opens bottom sheet (medium detent)
- Sheet contains: title input, cadence picker (Daily / Weekdays / Specific days / N times per week / Custom), optional notes, save button
- Save animation: sheet dismisses, new row animates into list with motion.entry

### 11.4 Inbox tab (one-off to-dos)

The Inbox is for items that don't repeat — things captured via voice or manual entry that need resolution.

**Header:**
- Title: "Inbox" in display.medium, color: text
- Subtitle: item count in caption, color: text.muted — e.g. "12 left · 23 total"
- Right action: "+ ADD" gold-outlined button

**Item list:**
- Each item is a frosted-glass card (slim, 64pt height typically)
- Layout: [checkbox] [title in title.card] [age indicator, right-aligned]
- Age indicator: "2d" in caption, color: text.muted for fresh items; "17d" in state.error for items sitting too long
- Tap on card: expand to reveal notes, date created, source (voice/manual)
- Long-press: swipe actions revealed — Resolve, Defer, Delete

**Cut or Commit items** — items sitting >14 days rise to the top of the Inbox with a gold left accent bar, visually distinguishing them as needing decision (gold = attention-needed; amber retired from utility per §4.6):
- Card border becomes 0.5pt gold at 22% opacity (active-hairline weight)
- Age indicator switches to state.error color
- Body copy subtle beneath title: "Decide: cut it, or commit and schedule it."

**Empty state:**
- "Inbox is clear." in title.screen, text.muted
- Fraunces italic beneath: "Nothing awaits your decision."

### 11.5 Align tab (mandates)

Preserves the existing layout with material/type upgrades.

**Header (sticky):**
- Category filter tabs: ALL / BUSINESS / VISION / PERSONAL
- Active tab indicated by gold underline (2pt, 40pt wide, gold) centered beneath label
- Typography: label.tracked.lg for each, color: text (active) / text.muted (inactive)
- Below filters: "22 mandates across 3 categories" in caption, text.muted, center-aligned

**Category pills (below filter header):**
- Three selectable pills: BUSINESS / VISION / PERSONAL
- Each pill: paddingHorizontal 20pt, height 44pt, borderRadius 9999pt
- Selected: gold outline 1pt + gold.wash background + gold label
- Unselected: subtle gold.hairline outline + transparent + text.muted label
- Tapping switches the filter state

**Add mandate input:**
- Full-width text field styled as a subtle frosted-glass input
- Placeholder: "Add mandate to {CATEGORY}..." in Fraunces italic, text.muted
- On focus: border becomes teal, placeholder disappears
- On submit (return key or done button): mandate adds to top of category list with motion.entry

**Mandate list (grouped by category):**
- Each category has a section header with gold diamond marker + category name + count:
  - ◆ BUSINESS 9
- Mandate cards:
  - Frosted-glass
  - **Category-tinted accent bar (3pt, full card height)** — signature Align treatment; color per §10.18 (gold for Business, teal for Vision, nebula-magenta for Personal)
  - Mandate text in title.section (22pt Inter SemiBold), color: text
  - Tap to expand: reveals Fraunces Light Italic 22pt version of the mandate on an elevated card (ceremonial view), with options to edit or delete
  - Long-press: edit sheet

**Mandate detail view (sheet):**
- Full-screen modal
- Void background, grain
- Mandate text in Fraunces Light Italic 28pt, centered, color: text
- Above: category label in tracked-caps, color: gold
- Below: research citation (if applicable) in body.md, text.secondary
- Actions at bottom: EDIT (secondary button), ARCHIVE (outlined red)
- Dismiss via chevron-down top-left

**Edit warning modal (preserved from shipped app):**
- When user attempts to edit a mandate: "Mandates are meant to stay still while the seasons move. Edit them when they've evolved, not when the week was hard." Keep/Cancel


---

## 12. ONBOARDING — THE 5-MOMENT RITUAL

Preserved from the shipped app. Moment 3 rewritten to use the Eye. All moments receive material upgrades.

### Moment 1 — Arrival

```
Full-screen void (#06060C)
Grain overlay 3%
Star particulates at 1.5% opacity (12 particles, drift slowly)

Center:
  - The gold Ring logo — 120pt diameter, 3pt stroke, gold
  - Breathing animation: scale 1.00 ↔ 1.06, 4s cycle, ease-in-out-sine
  - Ambient glow: gold @ 18%, radius 48pt

Title (above ring, after 1.2s fade-in):
  - Typography: poetic.hero (Fraunces Light Italic 28pt)
  - Color: text
  - Text: "Welcome to Nexus."

Subtitle (below ring, after 2.5s fade-in):
  - Typography: body.lg (Inter Regular 17pt)
  - Color: text.secondary
  - Text: "An operating system for becoming."

CTA (appears after 13s of silence — intentional pause):
  - PrimaryPill style but with gold fill instead of cream
  - Label: "BEGIN" in button.tracked (+0.14em, UPPERCASE)
  - Position: bottom-safe-area + 48pt, center
  - Entry: fade + 8pt rise, motion.entry
```

The 13-second silence is load-bearing. It trains the user that Nexus is an app that respects attention.

### Moment 2 — The Question

```
Full-screen void
Grain 3%

Center:
  - Single question in poetic.hero (Fraunces Light Italic 36pt) — SIZE UPGRADE from shipped 28pt
  - Color: text
  - Text: "Who are you becoming?"
  - No CTA initially — just the question

After 10s mandatory hold:
  - Below the question, fade in: "Tap when ready." in body.md, text.muted
  - The whole screen becomes tappable

Tap transitions to Moment 3 via full-cover fade 400ms
```

The 10-second mandatory hold is intentional confrontation. No skip. No progress indicator.

### Moment 3 — The First Invocation (REWRITTEN FOR THE EYE)

The shipped app has this as a Voice Orb. The overhaul replaces it with the full Eye.

```
Full-screen — the Eye composition (pupil, iris, combustion, nebula)
Tab bar hidden during onboarding

Eye state: ambient (slow breathing, gentle glow)

Positioning: Eye at 38% from top

Above the Eye:
  - Label in tracked-caps: "SPEAK YOUR MANDATE"
  - Color: gold

Below the Eye (feedback text space):
  - "Say who you are becoming." in poetic.md (Fraunces Light Italic 22pt)
  - Color: text.secondary
  - Disappears when user begins speaking

Below feedback text:
  - Primary pill "TAP TO SPEAK" (gold fill, button.tracked label)
  - Position: bottom-safe-area + 48pt

On tap:
  - Mic permission requested (first and only time — user has earned trust by now)
  - If granted: Eye enters listening mode — pupil dilates, combustion intensifies
  - Voice waveform animates across iris scaled to mic level
  - User speaks their mandate

On user stops speaking (detected by SFSpeechRecognizer pause > 1.5s):
  - Eye enters processing mode — pupil holds dilated, combustion pulses
  - Transcript appears below Eye in body.lg, color: text
  - After 600ms processing:
    - Two actions appear: [TAP TO KEEP] (PrimaryPill) and [RECORD AGAIN] (SecondaryButton)

On "KEEP":
  - Eye does a single warm combustion flare (400ms)
  - Mandate commits to storage as first entry in user's Align tab
  - Gold underline draws left-to-right beneath the transcript (400ms, motion.ceremony)
  - Haptic: notification.success
  - Transition to Moment 4 after 1.2s

If mic permission denied:
  - Fallback: text input appears below Eye in frosted-glass container
  - Placeholder: "I am becoming someone who..." in Fraunces italic
  - User types their mandate, keyboard appears
  - Same [TAP TO KEEP] action commits it
```

### Moment 4 — The Mandate

```
Full-screen void, grain, star particulates

Center-top:
  - "YOUR MANDATE" in label.tracked.lg, color: gold
  - Your mandate text in poetic.hero (Fraunces Light Italic 28pt), color: text
    — from Moment 3's capture
  - Gold underline beneath (holds from Moment 3's ceremony)

Below:
  - body.md in text.secondary:
    "This is the first sentence of your operating system. More will come. Mandates are the few sentences you refuse to live in contradiction to."

Bottom:
  - PrimaryPill (gold fill) "CONTINUE"
  - Position: bottom-safe-area + 48pt

Haptic on arrival: impact.medium (feels like something sealed)
```

### Moment 5 — Arrival Complete

```
Full-screen void

Above fold:
  - "You have begun." in poetic.hero (Fraunces Light Italic 36pt), center
  - Color: text
  - Gold underline beneath, 120pt wide, centered, 0.5pt

Middle:
  - A ghost layer of the Home screen at 18% opacity behind the title
  - Shows the user the cathedral before they enter
  - Alignment ring (with a default 40% fill for Day 1), today's habits empty, etc.

Bottom:
  - PrimaryPill "ENTER NEXUS" (cream fill, standard)
  - Below pill: micro subscription note if on paid tier:
    "Your practice begins today." in caption, text.muted

On ENTER NEXUS tap:
  - Ghost layer fades to full opacity (1.5s, motion.standard)
  - User enters Home tab, already scrolled to top
  - First-open ceremonial animation (§11.1 last paragraph) plays
```

Total onboarding time: ~2.5 minutes with the mandatory 13s + 10s + voice recording. Optimized for depth of commitment, not speed of skip.

### Onboarding audio (optional, off by default)

If user allows sound during permissions flow: a single Tibetan singing bowl tone plays on Moment 1 (F3, 800ms tail), and a subtle bowl resonance plays when the mandate commits in Moment 3 (G3, 1.2s tail). No other audio in onboarding.

---

## 13. MIGRATION FROM SHIPPED APP

> **Reconciled to v3 stellar (2026-06).** §13.1 originally described migrating to the warm v2 palette; it was rewritten in this pass for v3 (cool void `#06060C`, cosmic backdrop, frosted glass, amber retired). The migration *mechanics* (§13.2 habit scheduling, §13.3 Voice Orb → Eye, §13.4 preserved data) are unchanged and valid. §4 (Color) and §6 (Material) remain canonical for any value.

The shipped app is in users' hands. The overhaul is v3.0. On first open of v3.0 for an existing user, a migration flow runs in the background:

### 13.1 Automatic migrations (invisible)

- **Color theme switches instantly.** Tokens move from the warm v2 palette (`#0A0A0B` warm void / `#D4A056` gold / `#F5EFDC` cream) to v3 stellar (`#06060C` cool void / `#E5BA6E` gold / `#FFFFFF` white text, with `#E8EEF6` secondary). Net effect is a shift *cooler*, not warmer; user experience is "the whole app reads like starlight now." No data or layout changes.
- **Cosmic backdrop mounts.** The global StarField (galaxy photo + 80 white twinkling stars, §6.6) renders behind every screen. Cards become translucent frosted glass (§6.1) so the cosmos shows through.
- **Typography updates.** Fraunces Light Italic, Inter, IBM Plex Mono loaded if not already. Tracked-caps labels get +0.16em retroactively. No breaking changes.
- **Frosted-glass hairlines added.** Cards gain 0.5pt luminous-white hairlines at 10% opacity (§6.2). Grain is deferred in v3 (§6.4).

### 13.2 Habit scheduling migration (Option 1 from decision log)

On first launch of v3.0:

```
1. Read user's pin history for the last 14 days.
2. For each habit, determine schedule:
   - If pinned 14/14 days → schedule = Daily
   - If pinned on M/W/F pattern → schedule = Specific days (M, W, F)
   - If pinned on T/Th pattern → schedule = Specific days (T, Th)
   - If pinned 2-4 times/week with no clear pattern → schedule = N times per week (where N = observed average)
   - If pinned every day but user occasionally skipped → schedule = Daily
   - If pinned < 7 days of history → schedule = Daily (conservative default)
3. Write schedule to each habit's metadata.
4. On first Home open, show a one-time sheet:
   "We've scheduled your habits based on how you've been pinning them."
   - List each habit with detected schedule
   - "Review" button (opens habit management)
   - "Looks Good" button (dismisses sheet)
5. The old pinning mechanism remains as a dev-only fallback for the first month. Hidden from UI. If a user reports issues, support can re-enable manually.
```

The auto-migration sheet uses:
- Bottom sheet, large detent
- Tracked-caps header "YOUR HABITS, NOW AUTOMATIC"
- Body copy in body.md: "We watched how you pin and scheduled each one automatically. You can adjust anytime."
- Habit list: title + detected schedule inline (e.g. "Yoga — Mon, Wed, Fri")
- Two actions: PrimaryPill "LOOKS GOOD", SecondaryButton "REVIEW"

### 13.3 Voice Orb → Eye migration

The Voice Orb tab (Command) continues to function during v3.0 rollout:
- For users on v3.0, Command opens the Eye
- Voice command processing is unchanged functionally — same STT, same intent parsing, same AI routing
- Visual replacement only
- User may experience a moment of "wait, what?" on first open; no migration sheet — the Eye is self-evident

### 13.4 What does NOT change in migration

- Mandate data, habit data, calendar sync, Inbox items, past reviews, user preferences, notification settings
- Subscription state
- User's identity archetype (if set)
- Morning/evening prompt timing

---

## 14. VOICE COMMAND INTENT SYSTEM

### 14.1 Two-tier parsing

**Tier 1: Deterministic grammar (fast, private, offline)**

Regex + state machine handles common patterns. Confidence scored 0-1.

```ts
// voice/grammars.ts
export const grammars = [
  {
    name: 'reminder_create',
    pattern: /remind me to (.+?) (tonight|tomorrow|today|at \d|on \w+day)/i,
    extract: (match) => ({
      task: match[1].trim(),
      timeContext: match[2],
    }),
    action: 'createReminderInInbox',
    confidence: 0.9,
  },
  {
    name: 'calendar_block',
    pattern: /add (a |an )?(recurring )?calendar (block|event) (at \d+.*?)?(called|named) (.+)/i,
    extract: (match) => ({
      recurring: !!match[2],
      time: match[4],
      title: match[6].trim(),
    }),
    action: 'createCalendarEvent',
    confidence: 0.85,
  },
  {
    name: 'habit_complete',
    pattern: /mark (.+?) (as )?done( for today)?/i,
    extract: (match) => ({ habitName: match[1].trim() }),
    action: 'completeHabit',
    confidence: 0.9,
  },
  {
    name: 'habit_create',
    pattern: /add (a )?new habit[:\-\s]+(.+?)(,?\s+(daily|weekly|\d+ times))?$/i,
    extract: (match) => ({
      name: match[2].trim(),
      cadence: match[4] || 'daily',
    }),
    action: 'createHabit',
    confidence: 0.85,
  },
  {
    name: 'query_streak',
    // NEX-187 §1.5 Law B: `queryStreak` answers with CUMULATIVE progress ("23 total · back
    // after a pause"), never a breakable consecutive-day count. A breakable streak is surfaced
    // only for opt-in Soft Mode users. A default user asking about progress is never routed
    // into the old breakable-streak model.
    pattern: /what'?s my streak (on |for )?(.+?)\??$/i,
    extract: (match) => ({ habitName: match[2].trim() }),
    action: 'queryStreak',
    confidence: 0.9,
  },
  {
    name: 'read_mandates',
    pattern: /read (back )?my mandates?( out loud)?/i,
    extract: () => ({}),
    action: 'displayMandates',
    confidence: 1.0,
  },
  {
    name: 'morning_intention',
    pattern: /(my )?intention (for today )?is (.+)/i,
    extract: (match) => ({ intention: match[3].trim() }),
    action: 'saveMorningIntention',
    confidence: 0.9,
  },
  // ...additional patterns
];
```

**Tier 2: Apple Foundation Models (iOS 18+)**

If no grammar matches above confidence threshold 0.8, pass transcript + context to on-device Foundation Model.

```swift
// Pseudocode for Foundation Models call
let prompt = """
You are a voice command router for Nexus, a personal operating system app.
Parse the following user command into a structured intent.

Context:
  - Time of day: \(timeOfDay)
  - User's mandates: \(mandates.map{$0.title}.joined(separator: ", "))
  - User's active habits: \(habits.map{$0.name}.joined(separator: ", "))

User said: "\(transcript)"

Return JSON: { intent: string, entities: object, confidence: float }
Valid intents: reminder_create, calendar_block, habit_complete, habit_create,
               query_streak, read_mandates, morning_intention, evening_reflection,
               freeform_reflection, ambiguous
"""

let response = await FoundationModel.generate(prompt, structuredOutput: IntentSchema.self)
```

On devices without Foundation Models support: fall back to `ambiguous` and ask clarification.

### 14.2 Action execution

Each intent maps to a typed action function:

```ts
// voice/actions.ts
export async function createReminderInInbox(params: { task: string; timeContext: string }) {
  const dueDate = parseTimeContext(params.timeContext);
  const item = await db.inboxItems.create({
    title: params.task,
    dueDate,
    source: 'voice',
    createdAt: new Date(),
  });
  return {
    success: true,
    confirmText: `Reminder set for ${formatDate(dueDate)}.`,
    feedbackType: 'success',
  };
}

export async function createCalendarEvent(params: { recurring: boolean; time: string; title: string }) {
  const event = {
    title: params.title,
    startDate: parseTime(params.time),
    recurring: params.recurring,
  };
  await AppleCalendarBridge.createEvent(event); // Round-trip to real iOS Calendar
  return {
    success: true,
    confirmText: `${params.recurring ? 'Recurring' : 'Calendar'} block set.`,
    feedbackType: 'success',
  };
}

// ...etc
```

### 14.3 Feedback routing

Every action returns `{ success, confirmText, feedbackType }`. The Eye consumes this:

- `success: true, feedbackType: 'success'` → warm combustion flare + cream confirmText below Eye
- `success: false, feedbackType: 'ambiguous'` → follow-up question below Eye in Fraunces italic
- `success: false, feedbackType: 'error'` → neutral text below Eye with "Tap to try again"

Confirmation text displays for 3 seconds, then Eye returns to ambient. Tab bar re-focuses from 40% opacity.

### 14.4 Morning / evening modes

The Eye detects time of day and biases interpretation:

- **Morning (5am-11am):** Freeform speech after tap is treated as intention-setting unless it matches a utility grammar. "Today I want to focus on shipping the feature" → saved as morning intention, appears on Home.
- **Evening (5pm-10pm):** Freeform speech treated as reflection. The AI responds with a reflection based on how the day went vs. intention.
- **Other times:** Freeform speech defaults to Foundation Models routing.

Utility commands (reminder, calendar, habit completion) work at any time of day regardless of this bias.

---

## 15. REMINDERS & CALENDAR SYSTEM

### 15.1 Internal reminders (Nexus-native)

One-offs and recurring reminders live inside Nexus. Not in Apple Reminders.

**One-offs → Inbox tab.**
- Created via voice ("remind me to call mom tomorrow") or manual entry
- Appear in Inbox with due date badge
- Fire local notifications at due time
- On completion: swipe-right resolve, or tap checkbox

**Recurring → Orbit tab.**
- Created via voice ("add a recurring to-do: take vitamins every morning") or manual entry
- Live in the "Day's To-Do" section of Orbit for the scheduled days
- Fire local notifications at scheduled time
- Completion via ceremonial checkbox (§10.3)

**Notifications:**
- Local only (`UNUserNotificationCenter`)
- Passive interruption level (no sound by default, banner only)
- Copy: quiet, no imperatives — "A reminder awaits." (never "Do this now!")
- User can disable per-reminder in edit sheet

### 15.2 Apple Calendar integration

Calendar blocks created via voice ("add a calendar block at 9pm called bedtime routine") go to real Apple Calendar. They round-trip:

- Created in Nexus → written to Apple Calendar via EventKit
- Created elsewhere (Calendar app, Siri, another device) → synced back to Nexus via EventKit observer
- Displayed in Orbit tab's month calendar and Today's Horizon section
- Editable from either side; changes propagate

**Permissions:** EventKit access requested on first calendar-related voice command. Graceful fallback if denied — reminder-style local event created instead.

### 15.3 Migration considerations

Users who have been using Apple Reminders alongside the shipped Nexus may expect their reminders there. Communication:
- In the v3.0 migration sheet, note: "Reminders created in Nexus live in Nexus. Apple Calendar is synced."
- Setting toggle in Settings: "Sync reminders to Apple Reminders app" (off by default, available as opt-in for users who want cross-app visibility)

---

## 16. iOS 26 LIQUID GLASS RECONCILIATION

iOS 26 introduced Liquid Glass as the system design language. Nexus's aesthetic is partially in tension with it. The rule:

**Accept Liquid Glass in system navigation. Refuse it on Nexus content surfaces where the warm void is the material.**

### 16.1 Surface-by-surface decisions

| Surface | Decision |
|---|---|
| Status bar, Control Center, notification drawer | Accept (system-owned) |
| System share sheet, photo picker, alerts | Accept |
| System action sheets, context menus | Accept |
| **Nexus tab bar** | **Frosted glass** — transparent `tabBarStyle` + `tabBarBackground` BlurView (`tint="dark"`, intensity 75) + faint white top hairline. Updated per NEX-146 (2026-06); supersedes the earlier "solid warm void" decision — the grounding concern didn't bear out at intensity 75. |
| Nexus modals, bottom sheets, composer sheets | Override — Nexus frosted-glass surface (BlurView + translucent dark tint), not iOS Liquid Glass |
| System confirmation alerts (destructive actions) | Accept — destructive reliability beats aesthetic |
| Home/Lock-Screen widgets (SwiftUI WidgetKit) | Adopt Liquid Glass with warm gold tint |
| Floating action button (e.g., "+" on Inbox) | Adopt `.glassEffect(.regular.tint(gold.opacity(0.35)))` — one glass moment per screen, max |

### 16.2 Implementation

```swift
// Widget example — adopts Liquid Glass
.glassEffect(.regular.tint(Color(hex: 0xD4A056).opacity(0.35)))
```

```tsx
// Tab bar — frosted glass (NEX-146, 2026-06)
// tabBarStyle: transparent + tabBarBackground BlurView + faint white top hairline.
<BlurView tint="dark" intensity={75} style={StyleSheet.absoluteFill} />
```

- `expo-glass-effect` for iOS 26+ surfaces; gate behind `isGlassEffectAPIAvailable()`
- `UIDesignRequiresCompatibility` is NOT set in Info.plist (ships as 2026 app)
- Selective opt-in only

### 16.3 Known bugs

- Setting `opacity` on a parent of a `GlassView` breaks rendering — use component's `animate` / `animationDuration` or mount/unmount
- NativeTabs icon tint doesn't update correctly with `DynamicColorIOS` over light/dark content (expo/expo#39930) — use explicit cream
- Header buttons with glass styling flash background on dark-mode tab switch — wrap in `<ThemeProvider value={DarkTheme}>`
- `ScrollView` must be first child of screen, or wrapper needs `collapsable={false}` for edge-to-edge glass

---

## 17. ACCESSIBILITY

### 17.1 Dynamic Type support

- Every Text component includes `allowFontScaling`
- Hero numerals clamp at `.accessibility2`
- Tracking in em scales naturally
- Test matrix: xSmall, large, xxxLarge, accessibility3, accessibility5
- No clipping at accessibility5

### 17.2 VoiceOver

- Every interactive element has `accessibilityLabel` and `accessibilityHint`
- The Eye has custom accessibility announcements (§9.6)
- Alignment ring: "Alignment score 76, steady"
- Habit rows: "Meditation, 18-day streak, not complete, double-tap to complete"
- Bottom sheets trap focus correctly

### 17.3 Reduce Motion

- All custom animations wrapped in Reduce Motion checks
- Eye freezes shader time; mode changes happen via opacity, not animation
- Card entries become opacity-only, no translateY
- Checkbox ceremony becomes instant state swap
- Haptics preserved in all cases

### 17.4 Reduce Transparency

- High-contrast palette activates (§4.10)
- Grain overlay removed
- Hairlines lift from 8% to 22%
- Nebula layer on Eye removed
- Combustion ring on Eye becomes solid gradient
- Fraunces Light 300 → Regular 400 swap

### 17.5 Increase Contrast

- Hairlines bolden
- Tracked-caps labels upgrade from 600 to 700
- Gold brightens from `#E5BA6E` to `goldBright` `#F2D08A` (per §4.12)
- Teal brightens from `#5FE0EA` to `tealBright` `#7FE8F0` (per §4.12)

### 17.6 Color-blind considerations

- All state indication has a secondary carrier (icon + color, never color alone)
- The teal/textMuted debrief bars ALWAYS have numerical labels beneath them
- The state.error red ALWAYS pairs with an error icon
- Completion state distinguished by checkmark + opacity + hairline, not just color

---

## 20. BUILD ORDER — IMPLEMENTATION ROADMAP

Highest leverage first. Do not parallelize early phases.

### Phase 0 — Foundations (Week 1-2)

1. Design tokens file (`theme/tokens.ts`) from §4, §5, §7
2. Fonts loaded via `expo-font`: Fraunces-Light-Italic, Inter-Regular/Medium/SemiBold, IBMPlexMono-Regular/Medium
3. Grain PNGs generated and bundled (`grain_warm_2pct@3x.png`, `grain_warm_4pct@3x.png`)
4. Custom flame glyph exported as SVG/SF Symbol
5. Tab bar icon set redrawn (house, microphone, 2x2 grid, lines, triangle) at 1.5pt stroke
6. Core libraries installed/updated: Reanimated 4, Skia, Expo Haptics, Gorhom bottom-sheet

### Phase 1 — Core components (Week 3-4)

1. Frosted-glass Card component with all layers (§6.1)
2. HabitRow with ceremonial checkbox (§10.3)
3. PrimaryPill, SecondaryButton, IconButton (§10.4, 10.5, 10.7)
4. Text Input variants (§10.8, 10.9)
5. Tab bar refinement (§10.10)
6. Bottom sheet styling (§10.11)
7. Toast / notification pill (§10.16)
8. Alignment Score Ring (§10.13)

### Phase 2 — Home redesign (Week 5-6)

1. Above-the-fold ritual: alignment ring hero + today's habits + today's horizon
2. First-open ceremonial animation
3. Below-the-fold sections: Morning Brief, This Week's Wins, Today's Win, Cut or Commit
4. Weekly Debrief with teal/textMuted palette swap (amber retired)
5. Focus, Your Anchor, Horizon Reviews sections
6. Getting Started & Tip cards

### Phase 3 — The Eye (Week 7-9)

1. Four Skia SkSL shaders (pupil, iris, combustion, nebula)
2. Eye composition in Command tab with motion modes (ambient, listening, processing)
3. Voice STT integration via expo-speech-recognition
4. Deterministic grammar parser
5. Apple Foundation Models integration (iOS 18+)
6. Action execution layer (createReminder, createCalendarEvent, etc.)
7. Feedback patterns and the CTA pill

### Phase 4 — Orbit, Inbox, Align (Week 9-10)

1. Orbit tab: month calendar with palette fix, today's horizon, day's to-do
2. Inbox tab: one-off to-do list with Cut-or-Commit highlighting
3. Align tab: category filters, mandate list with gold accent bar, detail view

### Phase 5 — Onboarding (Week 10-11)

1. All 5 moments with new material treatments
2. Moment 3 rewritten for the Eye
3. Ceremonial audio (if sound permissions granted)

### Phase 6 — Migration & polish (Week 11-12)

1. Habit scheduling auto-migration from pin history
2. v3.0 migration sheet copy and flow
3. Settings for sync-to-Apple-Reminders opt-in
4. Accessibility sweep (Dynamic Type, VoiceOver, Reduce Motion, Reduce Transparency, Increase Contrast)
5. iOS 26 Liquid Glass selective adoption

### Phase 7 — Widgets & Live Activities (Week 12+)

1. Home Screen Widget (small, medium, large) — SwiftUI, adopts Liquid Glass with gold tint
2. Lock Screen Widgets (circular, rectangular, inline)
3. Live Activity during active voice session (Eye pulsing on Lock Screen, Dynamic Island)

---

## 21. FIGMA FILE STRUCTURE

For designers working on the overhaul, organize the Figma file as:

**Page 00 — Foundations**
- Color styles (all tokens from §4)
- Text styles (all tokens from §5)
- Effect styles (frosted-glass ambient gold halo, inset white highlight, luminous-white hairline)
- Grid styles

**Page 01 — Components**
- Every component from §10 as a Figma component with variants

**Page 02 — Onboarding**
- All 5 moments (§12)

**Page 03 — Home**
- Above-the-fold states (new user, returning user, all-complete, partial-complete)
- Below-the-fold full scroll
- First-open ceremonial animation storyboard

**Page 04 — Command / The Eye**
- Ambient state, listening state, processing state, success feedback, clarification feedback, error feedback

**Page 05 — Orbit**
- Calendar view, day's to-do view, add-item sheet

**Page 06 — Inbox**
- List view, Cut-or-Commit highlighted items, empty state, add-item flow

**Page 07 — Align**
- Category filter states (All, Business, Vision, Personal)
- Mandate detail view
- Add mandate flow
- Edit warning modal

**Page 08 — Modals & Sheets**
- All bottom sheets, full-screen modals, alerts

**Page 09 — Widgets**
- Home Screen (small, medium, large)
- Lock Screen (circular, rectangular, inline)

**Page 10 — Motion storyboards**
- Habit checkbox ceremony (§10.3)
- Alignment ring streak milestone animation
- First-open Home ceremonial animation
- Eye motion modes

**Page 99 — Anti-patterns reference**
- Visual "don't" examples of every item in §19

Use Figma variables for token sync so engineers can pull live tokens via Tokens Studio plugin.

---

## 22. CLAUDE CODE BRIEFING PATTERNS

When sending prompts to Claude Code for this project, lead with these patterns:

### 22.1 Reference tokens, never hex values

After this CLAUDE.md is in place, always say `color.gold` or `color.teal`, never `#E5BA6E` or `#5FE0EA`. This forces the semantic layer and makes future palette changes trivial.

### 22.2 Reference named motion curves

Say `motion.standard` or `motion.ceremony`, never "a 250ms ease-out" inline.

### 22.3 Anchor to principles

When describing a new component, cite the governing principle: "Build an empty state for the archive — apply 'ceremonial entry, operational depth' (§1.7) and 'stone doesn't bounce' (§1.4)."

### 22.4 Flag deviations as requiring justification

Include this line in project-level guidance: *"If you need a value that isn't in the tokens, stop and explain why. Don't inline it."*

### 22.5 Version-pin libraries

When asking for Skia / Reanimated / Filament code, cite versions from §9.7 — training data drifts. Pin versions in every implementation prompt.

### 22.6 Use anti-pattern list as negative prompt

"Build the habit row. Per §19: no system checkmark, no drop shadow, no default iOS spring, no emoji in copy, no em dashes."

### 22.7 Three-question check before code

These three questions are the **UI/UX box's** sub-questions for a new screen, not a separate
ritual — see `docs/automation/four-box-gate.md`.

For every new screen, require Claude Code to answer three questions before writing code:
1. What is the single hero element?
2. What is the canonical interaction?
3. What motion curve settles it?

If Claude Code cannot answer all three, the screen is under-specified and needs more design thought.

### 22.8 Migration-specific prompts

When asking Claude Code to retrofit the shipped app:
- Always specify "preserve existing data schema"
- Always specify "preserve existing component names in code, change visuals only"
- Always ask for a diff, not a rewrite
- Always ask for migration tests

---

## CLOSING

Every decision in this document serves one goal: **Nexus should feel like opening a sacred daily instrument for the work of becoming, not a productivity app.**

The Home tab's ceremonial entry, the Eye's cosmic voice surface, the frosted-glass material language, the stellar palette (pure white on cosmic field), the Fraunces italic moments, the tracked-caps headers, the 250ms unhurried motion, the declarative copy, the research citations — all of it serves that one feeling.

When a designer or engineer asks "should I do X or Y," the answer lives in §1 (the seven governing principles) and §19 (the anti-pattern blacklist). When those aren't enough, it lives in the broader thesis: *a sacred daily operating system where your life is suspended in a cosmic field, held in frosted glass and starlight, and your voice is received by a cosmic eye that listens and acts.*

Ship narrow. Ship quietly. Let the instrument speak.

---

