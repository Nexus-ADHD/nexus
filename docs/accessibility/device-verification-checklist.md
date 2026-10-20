# Accessibility — device verification checklist (NEX-216)

The NEX-216 accessibility epic (VoiceOver, Dynamic Type, hit targets, Reduce
Motion, Reduce Transparency, contrast) shipped as a series of slices that are all
**CI-green but not CI-verifiable**. The behaviors here only confirm on a real
device with the relevant iOS Accessibility setting on. This is the single sweep
to run before trusting the epic.

How to use: enable each setting under **Settings → Accessibility**, walk the
listed screens, confirm the **expected** result. Check the box; note failures
with the screen + what you saw. A failure is a follow-up ticket under NEX-230.

> Simulator note: VoiceOver/Dynamic Type are best verified on a physical device.
> The simulator can approximate Dynamic Type (Environment Overrides) and has an
> Accessibility Inspector, but real VoiceOver focus/announcement order is
> device-only.

---

## 1. VoiceOver  (Settings → Accessibility → VoiceOver)

General per screen: every control is reachable, reads a clear label (not a raw
glyph like "✕" or "✕✕"), decorative art is skipped, and double-tap activates the
expected action.

### Command / the Eye  (NEX-244)
- [ ] The orb is **one** element labeled "Voice command" (idle) / "Listening"
      (recording); hint "Double tap to speak" / "Double tap to stop and send".
- [ ] The decorative orb video is **not** separately focusable.
- [ ] Tapping the orb and speaking → you hear **"Processing your command."** once
      (also when sending via the typed input, not just voice).
- [ ] A successful capture announces **"Added."**; an ambiguous result announces
      **"One quick question."**; an unparseable one **"I didn't catch that. Tap to
      try again."**; mic-denied **"Microphone is off…"**.
- [ ] The command-examples sheet **traps focus** (you can't reach the orb behind
      it); its scrim is not focusable; it has a labeled **Close**.
- [ ] The manual command field reads "Type a command".

### Home  (NEX-249 + NEX-252 polish)
- [ ] Alignment ring reads "Alignment score N, {band word}", hint "Double tap for
      alignment details".
- [ ] Habit rows read as checkboxes with checked/unchecked state + name.
- [ ] **Score modal**: focus traps on the card; the breakdown reads; there is a
      labeled **Close** (the backdrop is not a giant button).
- [ ] **Wins / intention modals**: each field labeled (Win 1/2/3, "Today's
      intention"); Save reads its **disabled** state; Skip labeled.
- [ ] **Today's Win card**: reads "Today's win: …" with completed state; hint reads
      the **result** ("Marks win as complete / not done") — **not** "Double tap to…";
      the VoiceOver rotor exposes an **Edit** action.
- [ ] **Badge unlock**: when a badge unlocks you **hear "Badge unlocked. {name}."**
      (NEX-252 — the toast itself is silent to VoiceOver).
- [ ] **Level up**: announced; CONTINUE labeled; decorative ⚡ skipped.
- [ ] Lead-time checkbox, "+N more in Orbit", day-1 tip (+ its dismiss), settings
      ✕ ("Close settings"), share / dismiss — all labeled.

### Orbit  (NEX-248 + NEX-252 polish)
- [ ] Every interactive/glyph element labeled.
- [ ] Routine-time **clear ✕** reads "Clear routine time" (NEX-252); the ✕ glyph is
      not separately focusable.

### Inbox + Align  (NEX-247)
- [ ] Every interactive/glyph element labeled; decorative glyphs skipped.

---

## 2. Dynamic Type  (Settings → Accessibility → Display & Text Size → Larger Text → Larger Accessibility Sizes, slider near max)

### Home alignment-score hero  (NEX-250 C5a)
- [ ] The score numeral grows but **does not clip** inside the ring; the
      eyebrow + numeral + word + sub stay within the circle (clamped, not shrunk).
- [ ] A **3-digit score ("100")** still fits inside the ring at the max size.
- [ ] No text is silently tiny/capped — the hero honors larger sizes up to the
      clamp, then holds.
- [ ] Body copy and section labels elsewhere still scale and reflow without
      overlap (spot-check Home/Inbox/Align).

> Known scope: this slice covered only the alignment-score hero. The score-modal
> and other display numerals are a planned follow-up — note any clipping there
> but it is expected/untracked-yet, not a regression.

---

## 3. ≥44pt hit targets  (no setting — just tap with a fingertip)

- [ ] Home **settings ✕** (top-right of the settings sheet) is comfortably
      tappable (NEX-251 raised it to ~50pt).
- [ ] Orbit routine-time **clear ✕** is comfortably tappable (NEX-251 → 48pt).
- [ ] Other ✕ closes / icon buttons feel ≥44pt (IconButton enforces this).

> Deferred: small **inline text links** (that rely on row/container padding) were
> not swept. Note any that feel too small — that is the deferred follow-up audit.

---

## 4. Reduce Motion  (Settings → Accessibility → Motion → Reduce Motion)

### StarField + Home ring  (NEX-227 / NEX-228)
- [ ] The global star field **freezes** at a static, pleasing frame (no twinkle).
- [ ] The Home alignment ring does **not** play its entrance bloom / count-up /
      ambient breath — it appears settled (toggle the setting live and reopen Home
      to confirm it reacts).
- [ ] Card entrances are opacity-only (no slide); haptics still fire.
      *(This was asserted here before it was true. An audit on 2026-08-16 found
      nine Moti entrances still carrying `translateY` with no Reduce Motion gate
      at all — Inbox cards, five Command surfaces, both triage-flow steps, and
      the mandate strengthen sheet — plus `BreakdownStack` gating on
      reanimated's `useReducedMotion`, the app-start snapshot that never sees a
      live toggle. All now route through `useEntranceFrom`, which drops the
      slide and keeps the fade.
      The two remaining slides used shared values rather than Moti, so they were
      outside that hook, and are now gated individually: the onboarding
      `InspireScreen`'s 30pt rise in `app/_layout.tsx`, and Home's 8pt
      first-open ceremony in `home-screen.tsx`. Home reads the preference from a
      ref rather than an effect dependency, because that effect also writes
      `nexus_lastDailyOpen` and a live toggle must not re-run a once-per-day
      side effect. Nothing in the app is known to slide ungated now — this box
      is a device confirmation of that, not a discovery pass.)*

---

## 5. Reduce Transparency  (Settings → Accessibility → Display & Text Size → Reduce Transparency)

### Card material  (NEX-243 foundation)
- [ ] Frosted-glass cards become **opaque** (no blur/cosmos bleed-through);
      text contrast holds.
- [ ] N/A — there is **no Eye Reduce-Transparency path to verify.** The §9.2
      nebula/combustion/iris shader Eye was never built; the shipped Command orb
      is a pre-rendered video (`components/VoiceOrb.tsx` → `orb-idle.mp4`) with no
      shader layers and no translucency for Reduce Transparency to act on.
      NEX-256 was closed not-applicable for this reason. (If the §9 shader Eye is
      ever built, its RT behavior per §17.4 becomes a real consumer again.)

---

## 6. Contrast / Increase Contrast  (Settings → Accessibility → Display & Text Size → Increase Contrast)

> The §4.11 contrast audit (C5c) is **not yet shipped** — this section is a
> forward checklist for when it lands.
- [ ] Muted text over bright nebula regions stays readable (the StarField scrim
      should be carrying it).
- [ ] Under Increase Contrast, hairlines/labels strengthen per §4.12; nothing
      becomes illegible.

---

## Slice → PR map (for traceability)

| Area | Ticket | PR |
|---|---|---|
| Reduce Motion foundation + StarField freeze | NEX-227 | merged |
| Ring → useReduceMotion | NEX-228 | merged |
| Voice text-fallback + equivalence doc | NEX-229 | merged |
| Reduce Transparency foundation | NEX-243 | merged |
| Command / Eye VoiceOver | NEX-244 | merged |
| Inbox + Align VoiceOver | NEX-247 | merged |
| Orbit VoiceOver | NEX-248 | merged |
| Home VoiceOver | NEX-249 | merged |
| Dynamic Type hero clamp (C5a) | NEX-250 | #193 |
| ≥44pt hit targets (C5b) | NEX-251 | #196 |
| VoiceOver polish (badge announce, Win hint, Orbit clear) | NEX-252 | #197 |

**Still open under NEX-230:** §4.11 contrast audit (C5c), score-modal/other
display-numeral Dynamic Type, the inline-text-link hit-target audit.

**Closed not-applicable:** Reduce Transparency consumers (Eye nebula removal,
NEX-256) — the Eye is a pre-rendered video, not the §9 shader composition, so
there is no shader layer or translucency to act on (see §5).
