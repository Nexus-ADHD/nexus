# Motion Assets — Nexus Cosmic Pipeline

Drop `.riv` and `.mov` hero assets here. The app loads them by filename.

Every asset has a **contract** (state machine name, input names, text runs). If you rename anything in Rive or After Effects, update `motion-config.ts` to match, or the hero will silently fall back to the placeholder.

---

## `nexus-cosmic-ring.riv` — Home accretion ring

**Target ship:** Week 4 · **Phase:** 1–3

### State machine: `CosmicRing`

### Inputs

| Name | Type | Range | Purpose |
|---|---|---|---|
| `score` | number | 0–100 | Drives arc fill %, halo brightness, color temperature |
| `pulse` | trigger | — | Fires on habit check-off for a subtle flare (optional) |

### Text runs

| Name | Bound to | Values |
|---|---|---|
| `qualWord` | centered below the numeral | `Drifting` · `Steady` · `Rising` |

### Visual spec

- Obsidian base `#0A0A0B`
- Arc starts at 12 o'clock, fills clockwise
- Color temperature interpolated with score:
  - score < 33 → cream `#F5EFDC` with low opacity
  - 33 ≤ score < 66 → gold `#D4A056`
  - score ≥ 66 → teal `#3FC9D4` (peak signal)
- Vector Feathering on the halo (this is the feature that makes the aesthetic possible)
- Breathing loop: 6-second sine, ±3% scale on the halo layer
- Clockwise fill rule on the arc
- Typography rendered in RN `<Text>` on top — the .riv file does NOT draw the numeral

### Size budget

- Target: **≤ 200 KB**
- Hard limit: 300 KB (CI will block anything larger)

### Authoring notes

- Fraunces Light Italic for the qualitative word if you embed it in Rive; otherwise leave typography to RN
- IBM Plex Mono is handled by RN, not Rive
- Test your data binding at score = 0, 33, 66, 100 — the transitions between bins are where it looks good or doesn't

---

## `nexus-cosmic-eye.riv` — Command tab cosmic iris

**Target ship:** Week 6 · **Phase:** 4

### State machine: `CosmicEye`

### Inputs

| Name | Type | Range | Purpose |
|---|---|---|---|
| `audioLevel` | number | 0–1 | Drives pupil dilation, combustion intensity |
| `startListening` | trigger | — | Transitions idle → listening |
| `stopListening` | trigger | — | Transitions listening → idle |
| `startSpeaking` | trigger | — | Transitions any → speaking |
| `stopSpeaking` | trigger | — | Transitions speaking → idle |

### States

1. **idle** — slow breathing, subtle iris pulse
2. **listening** — pupil dilates ~0.3×, particulates accelerate, combustion intensifies
3. **speaking** — iris brightens, combustion pulses to audio amplitude

### Size budget

- Target: **≤ 300 KB**
- Hard limit: 500 KB (the eye has more layers than the ring — higher ceiling)

---

## `nexus-command-nebula.mov` — HEVC-alpha background

**Target ship:** Week 7 · **Phase:** 5

### Encoding contract

- Format: HEVC with alpha, `hvc1` tag
- `alpha_quality`: 0.9 (drop to 0.85 if file exceeds target)
- Duration: 4–8 seconds, seamless loop (frame 0 = frame N)
- Resolution: 1170×2532 (iPhone 15 Pro native) or 4K equivalent
- Frame rate: 30 fps

### Encoding command (reference)

```bash
ffmpeg -i nebula_source.mov \
  -c:v hevc_videotoolbox \
  -tag:v hvc1 \
  -alpha_quality 0.9 \
  -pix_fmt yuva420p \
  -b:v 4M \
  nexus-command-nebula.mov
```

Or via Apple Compressor: select the "HEVC with Alpha" setting, leave defaults, set bitrate to 4 Mbps.

### Size budget

- Target: **≤ 1.5 MB**
- Hard limit: 2 MB

### Playback

Played via `react-native-transparent-video` at `loop={true}`, `muted={true}`, `resizeMode="cover"`. Paused when the screen backgrounds (battery preservation).

---

## Git-ignore policy

- `.riv` files — **committed** to the repo (they're the source of truth for the visual layer)
- `.mov` HEVC-alpha loops — **committed** to the repo (small enough, critical for build)
- Raw `.c4d`, `.aep`, `.blend` source files — **not committed** (kept in `~/nexus-motion/` or cloud storage)

When in doubt: if the app needs it at runtime, commit it. If it's an authoring source file, keep it out.
