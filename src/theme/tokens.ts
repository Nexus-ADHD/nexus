// NEXUS DESIGN TOKENS — v3.0 STELLAR
// Source of truth: CLAUDE.md §4 (Color), §5 (Typography), §6 (Spacing/Radii), §7 (Motion)
// DO NOT hardcode hex values in components — always import from here.
//
// v3.0 (NEX-43 follow-up): the app now sits on a cosmic backdrop (galaxy
// photo + 128 white twinkling stars). The v2 "warm cream on warm void"
// palette failed against the busy backdrop — cream-paper text against bright
// nebula regions read at ~3:1 contrast. v3 shifts the entire palette to a
// cool stellar register:
//   - Primary text becomes pure white #FFFFFF, matching the star color so
//     the writing and the sky feel made of the same material.
//   - Secondary/muted text shift to cool blue-white tones (moonlight, not
//     paper).
//   - Card surfaces become translucent dark glass (cards = BlurView in
//     phase 2; phase 1 ships the values so cards stay readable without
//     blur).
//   - Gold survives as the one warm thread, slightly brightened, but its
//     screen budget tightens from ≤10% to ≤5% per screen.
//   - Amber retires from default utility — reserved exclusively for streak
//     milestone ceremonies. Galaxy already supplies its own warm regions.
//   - Teal brightens to electric cyan so it pops against the backdrop's
//     own teal-cyan zones.
// CLAUDE.md §4 will be rewritten to ratify these values once the look is
// signed off on the simulator.

// ── Color ─────────────────────────────────────────────────────────────────────
const color = {
  // Void / backgrounds — cool-shifted near-black (v2 warm bias removed).
  // Galaxy backdrop covers most surface area; void only reads briefly at
  // app boot and behind the opaque tab bar. Slight cool bias aligns the
  // family with the stellar palette.
  void:            '#06060C',
  voidDeep:        '#020208',
  // Modal / sheet scrim — cosmic vignette over the cosmic field (§4.10
  // gradient.vignette modal scrim). Sits behind centered modal cards.
  scrim:           'rgba(2,2,8,0.78)',
  // §4.11 floating-text shadow — soft dark halo behind text that floats on the
  // cosmos with no card backdrop (empty states, the mandate echo + cue lines
  // under a habit row). Pairs with textShadowRadius:4 / textShadowOffset:{0,1}.
  floatingTextShadow: 'rgba(0,0,0,0.55)',

  // Card surfaces — translucent dark glass. Cards consume these as
  // backgroundColor + a BlurView wrapper. Alpha values bumped from the
  // initial v3 values (0.55 / 0.72 / 0.40) to (0.68 / 0.82 / 0.50) after
  // first sign-off — at 55% the cosmic backdrop was bleeding through too
  // much and dragging text contrast under bright nebula regions.
  surface:         'rgba(8, 10, 18, 0.68)',
  surfaceElevated: 'rgba(12, 14, 22, 0.82)',
  surfaceSunken:   'rgba(4, 6, 12, 0.50)',
  // Reduce Transparency (§4.10 / §17.4): when the BlurView is removed, cards use
  // these near-opaque tints so the cosmos doesn't bleed through and text
  // contrast holds. Same hues as surface/surfaceElevated, alpha lifted.
  surfaceOpaque:         'rgba(8, 10, 18, 0.95)',
  surfaceElevatedOpaque: 'rgba(12, 14, 22, 0.97)',

  // Text — stellar palette. Primary text is the same pure white as the
  // stars, so writing and sky feel made of the same material.
  // textSecondary brightened from #D8E0EC → #E8EEF6 after first sign-off
  // — it lost too much contrast against bright nebula regions of the
  // backdrop. Still cool blue-white, just closer to luminous white.
  text:            '#FFFFFF',
  textSecondary:   '#E8EEF6', // bright cool blue-white — moonlight, not paper
  textMuted:       '#9AA3B5', // cool gray-blue — slightly brighter than v3.0
  textDisabled:    '#4A5260',
  textInverse:     '#06060C', // for text on cream/white/gold fills

  // Gold (earned ornament — now ≤5% of any screen, was ≤10%).
  // Slightly brightened to assert against cosmic competition.
  gold:            '#E5BA6E',
  goldBright:      '#F2D08A',
  goldDeep:        '#A07A3F',
  // Hairlines shift from warm gold to luminous white — card edge reads as
  // carved from starlight rather than framed in leaf. The token name is
  // kept for compat; the value is no longer gold-tinted.
  goldHairline:    'rgba(255,255,255,0.10)',
  // Crisp luminous-white card edge — the "pixel border" (designer pass, NEX-146).
  // Sibling to goldHairline; brighter so the edge reads against the cosmic field.
  luminousEdge:     'rgba(255,255,255,0.28)',
  luminousEdgeSoft: 'rgba(255,255,255,0.12)',  // faint top hairline (frosted tab bar)
  // §10.11 bottom-sheet drag handle. Named because it was three different
  // things in three sheets: textDisabled, a raw rgba, and a 44pt-wide bar.
  sheetHandle:      'rgba(255,255,255,0.22)',
  // List-row chevron glyph (›) — brighter than the hairlines, dimmer than the
  // card edge, so it reads as a quiet affordance rather than chrome.
  chevron:         'rgba(255,255,255,0.35)',
  goldWash:        'rgba(229,186,110,0.05)',
  // Stellar spectral ramp (StarField). These are COLOUR TEMPERATURES of point
  // sources, not UI accents — a real field spans hot blue-white to cool
  // amber-white, and rendering every star #FFFFFF is what made the old field
  // read as a particle emitter. `starAmber` is NOT tokens.color.amber
  // (#F5A04A, retired to milestone ceremonies per §4.6): it is a far paler,
  // desaturated stellar white, carried by ~10% of stars at <=0.55 opacity.
  starBlue:        '#9BB0FF',
  starBlueWhite:   '#CAD7FF',
  starWhite:       '#FFFFFF',
  starWarmWhite:   '#FFF4E8',
  starAmber:       '#FFD2A1',
  // (goldTrackActive retired 2026-08-08 — every switch is the kit Toggle now,
  // whose ON track is teal. Gold is a seal, not a control state.)

  // Teal (sacred-active — brightened to electric cyan so it pops against
  // the backdrop's own teal-cyan iris zones instead of blending in).
  teal:            '#5FE0EA',
  tealBright:      '#7FE8F0',
  tealDeep:        '#2A8F98',
  tealWash:        'rgba(95,224,234,0.08)',

  // Amber — RETIRED from default utility. Reserved exclusively for streak
  // milestone ceremonies (7/30/66/365 day hits). The galaxy already
  // supplies its own warm combustion regions; a second warm accent on
  // default screens fights with the backdrop. Anywhere amber currently
  // shows up on a default surface (Cut-or-Commit, milestone hints, etc.)
  // should shift to white-on-translucent or to gold.
  amber:           '#F5A04A',
  amberDeep:       '#E88438',
  amberCore:       '#A94520',

  // Nebula (Eye / Command tab only — do not use on other surfaces)
  nebulaMagenta:   '#B83A6E',
  nebulaViolet:    '#6E2A8F',
  nebulaDeep:      '#2A1A3E',

  // Semantic states — cool-shifted to follow the stellar palette.
  stateSuccess:    '#5FE0EA', // teal (success uses teal, never green)
  stateWarning:    '#E5BA6E', // gold (warning uses gold, never yellow)
  stateError:      '#E55B45', // brighter warm red — pops against bright nebula
  stateErrorDeep:  '#A23D28',
  stateInfo:       '#78A5B8', // muted celestial blue-gray
  statePhosphor:   '#39FF7A', // year milestones only — genuinely beyond sRGB on P3
} as const;

// ── Font family keys (must match Font.loadAsync registration in app/_layout.tsx) ──
const font = {
  fraunces:        'Fraunces-LightItalic',
  interRegular:    'Inter-Regular',
  interMedium:     'Inter-Medium',
  interSemiBold:   'Inter-SemiBold',
  interBold:       'Inter-Bold',
  plexMonoRegular: 'IBMPlexMono-Regular',
  plexMonoMedium:  'IBMPlexMono-Medium',
} as const;

// ── Type scale (§5.1) ──────────────────────────────────────────────────────────
// letterSpacing: em value as a number. For RN: multiply by fontSize to get pt offset.
// textTransform present only where UPPERCASE is mandated by spec.
const type = {
  // IBM Plex Mono — all numerals and data
  heroNumeric: {
    fontFamily:    'IBMPlexMono-Medium',
    fontSize:      140,
    lineHeight:    130,
    letterSpacing: -0.04,
    fontWeight:    '500' as const,
  },
  numericDisplay: {
    fontFamily:    'IBMPlexMono-Medium',
    fontSize:      36,
    lineHeight:    40,
    letterSpacing: -0.01,
    fontWeight:    '500' as const,
  },
  numericMd: {
    fontFamily:    'IBMPlexMono-Medium',
    fontSize:      18,
    lineHeight:    24,
    letterSpacing: 0,
    fontWeight:    '500' as const,
  },
  numericSm: {
    fontFamily:    'IBMPlexMono-Regular',
    fontSize:      13,
    lineHeight:    18,
    letterSpacing: 0,
    fontWeight:    '400' as const,
  },
  captionTabular: {
    fontFamily:    'IBMPlexMono-Regular',
    fontSize:      13,
    lineHeight:    18,
    letterSpacing: 0,
    fontWeight:    '400' as const,
  },

  // Inter — all UI text
  displayLarge: {
    fontFamily:    'Inter-Bold',
    fontSize:      48,
    lineHeight:    52,
    letterSpacing: -0.03,
    fontWeight:    '700' as const,
  },
  displayMedium: {
    fontFamily:    'Inter-Bold',
    fontSize:      36,
    lineHeight:    40,
    letterSpacing: -0.025,
    fontWeight:    '700' as const,
  },
  titleScreen: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      28,
    lineHeight:    34,
    letterSpacing: -0.02,
    fontWeight:    '600' as const,
  },
  titleSection: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      22,
    lineHeight:    28,
    letterSpacing: -0.01,
    fontWeight:    '600' as const,
  },
  titleCard: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      18,
    lineHeight:    24,
    letterSpacing: 0,
    fontWeight:    '600' as const,
  },
  bodyLg: {
    fontFamily:    'Inter-Regular',
    fontSize:      17,
    lineHeight:    26,
    letterSpacing: -0.005,
    fontWeight:    '400' as const,
  },
  bodyMd: {
    fontFamily:    'Inter-Regular',
    fontSize:      15,
    lineHeight:    22,
    letterSpacing: 0,
    fontWeight:    '400' as const,
  },
  bodyMdEmphasis: {
    fontFamily:    'Inter-Medium',
    fontSize:      15,
    lineHeight:    22,
    letterSpacing: 0,
    fontWeight:    '500' as const,
  },
  caption: {
    fontFamily:    'Inter-Medium',
    fontSize:      13,
    lineHeight:    18,
    letterSpacing: 0.005,
    fontWeight:    '500' as const,
  },
  // Brutalist tracked-uppercase labels — the +0.16em rule (§5.2)
  labelTrackedLg: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      13,
    lineHeight:    16,
    letterSpacing: 0.16,
    fontWeight:    '600' as const,
    textTransform: 'uppercase' as const,
  },
  labelTrackedSm: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      11,
    lineHeight:    14,
    letterSpacing: 0.18,
    fontWeight:    '600' as const,
    textTransform: 'uppercase' as const,
  },
  labelTrackedMicro: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      9.5,
    lineHeight:    12,
    letterSpacing: 0.20,
    fontWeight:    '600' as const,
    textTransform: 'uppercase' as const,
  },
  buttonPrimary: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      16,
    lineHeight:    20,
    letterSpacing: 0.01,
    fontWeight:    '600' as const,
  },
  buttonTracked: {
    fontFamily:    'Inter-SemiBold',
    fontSize:      13,
    lineHeight:    16,
    letterSpacing: 0.14,
    fontWeight:    '600' as const,
    textTransform: 'uppercase' as const,
  },

  // Fraunces Light Italic — identity, reflection, sacred intent (max 1 per screen)
  poeticHero: {
    fontFamily:    'Fraunces-LightItalic',
    fontSize:      28,
    lineHeight:    34,
    letterSpacing: 0.01,
    fontWeight:    '300' as const,
  },
  poeticMd: {
    fontFamily:    'Fraunces-LightItalic',
    fontSize:      22,
    lineHeight:    30,
    letterSpacing: 0.01,
    fontWeight:    '300' as const,
  },
  poeticSm: {
    fontFamily:    'Fraunces-LightItalic',
    fontSize:      18,
    lineHeight:    26,
    letterSpacing: 0.01,
    fontWeight:    '300' as const,
  },
} as const;

// ── Spacing (8pt grid, 4pt half-steps) ───────────────────────────────────────
const space = {
  xxs:  4,
  xs:   8,
  sm:   12,
  md:   16,
  lg:   24,
  xl:   32,
  xxl:  48,
  xxxl: 72,
  huge: 96,
} as const;

// ── Radii ──────────────────────────────────────────────────────────────────────
const radii = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  xxl:  24,
  // §10.11 specifies 28pt top corners for a bottom sheet. It lived as a
  // hardcoded 28 in LeadTimeCreateSheet and as a wrong 24 elsewhere; naming it
  // here makes the scale honest and lets the box-1 ratchet, which reads this
  // object, accept the value it is supposed to accept.
  sheet: 28,
  full: 9999,
} as const;

// ── Material / stone-morphism (§6) ───────────────────────────────────────────
// Stone-morphism cards: gold hairline + grain + inset highlight + ambient warm glow.
// Replaces all default iOS drop shadows. Never use shadow:black anywhere.
const material = {
  // 0.5pt gold-tinted hairline border at 8% opacity — the signature stone-morphism stroke.
  hairline: {
    width:   0.5,
    color:   color.goldHairline,
    // On active/selected states, lift opacity to 22% and warm to solid gold.
    active:  {
      width: 0.5,
      color: color.gold,
    },
  },

  // Inset highlight glow — fakes "lit from above" carved feel.
  // v3 stellar: was cream-tinted (rgba(245,239,220,...)); shifted to pure
  // luminous white to match the new card-edge-as-starlight register.
  insetHighlight: {
    angle:       180,
    stops:       [
      { offset: 0.00, color: 'rgba(255,255,255,0.04)' },
      { offset: 0.18, color: 'rgba(255,255,255,0.00)' },
    ],
    blendMode:   'screen' as const,
  },

  // Corner glows (NEX-158) — opt-in luminous WHITE corner accents on primary
  // card surfaces. Each corner traces the rounded edge (line → arc → line) with
  // a 1px apex stroke + a 3pt soft-glow duplicate, both fading from the corner
  // apex outward via a per-corner radial gradient. White, not gold, so they
  // don't eat the ≤5% gold budget (§4.4). Static — no shimmer (§1.4).
  // One-place-tunable here; consumed by src/components/ui/CornerGlows.tsx.
  cornerGlow: {
    edgeLength:      20,   // pt traced along each edge from the corner apex
    apexOpacity:     0.55, // peak opacity of the 1px edge stroke at the apex
    glowOpacity:     0.12, // peak opacity of the 3pt soft-glow stroke
    strokeWidth:     1,    // crisp apex edge stroke
    glowStrokeWidth: 3,    // soft glow stroke
  },

  // Grain texture overlay — pre-baked PNG at the listed opacity, repeat-tiled.
  // Use 'soft-light' on surface cards, 'overlay' on gradient cards.
  grain: {
    defaultOpacity:   0.02, // 2% on standard cards
    elevatedOpacity:  0.04, // 4% on hero / pedestal cards
    milestoneOpacity: 0.10, // 10% on gradient milestone cards
    blendModeDefault: 'soft-light' as const,
    blendModeGradient:'overlay' as const,
  },

  // Ambient warm glow — replaces all drop shadows. Sits beneath every
  // card-like surface (Card primitive + any manual card-shaped View),
  // gold-tinted to match tokens.color.gold (#E5BA6E). RN: spread these
  // into shadowColor / shadowRadius / shadowOffset / shadowOpacity
  // (iOS) and provide an elevation fallback for Android.
  //
  // v3 stellar follow-up (v3.5): values dialed in iteratively.
  //   v2 spec:  rgba(212,160,86,0.08), radius 32, offset +12 — spec but
  //             essentially invisible against a cosmic backdrop.
  //   v3.3:     rgba(229,186,110,0.40), radius 40, offset +8 — visible
  //             but too aggressive on default cards.
  //   v3.5:     rgba(229,186,110,0.28), radius 36, offset +8 — visible
  //             aura around every section without competing with the
  //             content inside. Apply uniformly to every card-like
  //             surface so the "lit from within" feel reads everywhere.
  shadow: {
    ambient: {
      shadowColor:   'rgba(229,186,110,0.28)',
      shadowRadius:  36,
      shadowOffset:  { width: 0, height: 8 },
      shadowOpacity: 1,
    },
    // Android fallback — RN ignores shadowColor etc on Android, uses
    // the elevation prop. Six matches the visible radius of the iOS
    // shadow well enough.
    ambientAndroidElevation: 6,
    // Soft halo tier (owner-approved §2 amendment, 2026-08-06 — "spend light
    // like money"; spec: docs/design/NEXUS-DESIGN-SYSTEM.md §4.9): ordinary
    // list cards get this quieter halo so only one object per surface reads
    // as lit. Hero/elevated surfaces keep the full `ambient` above.
    // Exported as `ambientGlowSoft` from src/theme/glow.ts.
    ambientSoft: {
      shadowColor:   'rgba(229,186,110,0.10)',
      shadowRadius:  20,
      shadowOffset:  { width: 0, height: 4 },
      shadowOpacity: 1,
    },
    ambientSoftAndroidElevation: 3,
    // Used on the cream PrimaryPill (Tolan-style)
    pillCream: {
      shadowColor:   'rgba(245,239,220,0.14)',
      shadowRadius:  20,
      shadowOffset:  { width: 0, height: 0 },
      shadowOpacity: 1,
    },
    // Used on milestone amber gradient cards
    pillAmber: {
      shadowColor:   'rgba(245,160,74,0.18)',
      shadowRadius:  40,
      shadowOffset:  { width: 0, height: 0 },
      shadowOpacity: 1,
    },
    // Toast / floating popups
    floating: {
      shadowColor:   'rgba(0,0,0,0.45)',
      shadowRadius:  24,
      shadowOffset:  { width: 0, height: 12 },
      shadowOpacity: 1,
    },
  },

  // Hero bloom (owner-approved §2 amendment, 2026-08-06 — "spend light like
  // money"; spec: docs/design/NEXUS-DESIGN-SYSTEM.md §4.9, rationale:
  // docs/design/explorations/2026-08-06-opal-visual-system.md §7 (landing in
  // #376)): a radial glow rendered BEHIND exactly one hero object per screen,
  // so the bloom — not a shadow under every card — carries the light
  // hierarchy. Teal, not gold: the hero bloom borrows the sacred-active hue
  // so it never spends the ≤5% gold budget (§4.4). Shape matches
  // insetHighlight's stops.
  heroBloom: {
    stops: [
      { offset: 0.00, color: 'rgba(95,224,234,0.10)' },  // center
      { offset: 0.60, color: 'rgba(95,224,234,0.00)' },  // transparent by 60% radius
      { offset: 1.00, color: 'rgba(95,224,234,0.00)' },
    ],
  },

  // Card padding defaults (matches §10.1 spec)
  padding: {
    default: 20,
    hero:    24,
  },
} as const;

// ── Iconography (§10.7, §10.10) ──────────────────────────────────────────────
// Stack: expo-symbols (iOS native SF Symbols) + @expo/vector-icons fallback.
// Custom icons (flame, etc.) must match SF Symbols stroke weight.
const icon = {
  // SF Symbols weights — only these two are allowed app-wide.
  weight: {
    default: 'regular' as const, // SF Symbols "Regular" — matches 1.5pt stroke target
    bold:    'semibold' as const,// for active/selected states; never heavier than this
  },

  // Hit targets and visible icon sizes (visible ≤ hit).
  size: {
    inline:  10,  // streak chip flame
    sm:      14,  // habit row inline
    md:      18,  // IconButton default, button leftIcon (§10.4, §10.7)
    lg:      20,  // toast / chip leading icon
    tab:     24,  // tab bar (§10.10)
    hero:    32,  // ceremonial / empty-state artifact
  },

  hitTarget: {
    minimum: 44,  // iOS HIG floor — never below
    icon:    44,  // IconButton wrapper (§10.7)
    // NEX-255 (§10.2 follow-up): hitSlop for discrete inline text-link tap
    // targets that rely on container padding and render < 44pt tall. Spread
    // into a Pressable's hitSlop so the touch area clears the 44pt floor
    // without changing layout. `linkSlop` for isolated links; `linkSlopTight`
    // for horizontally-adjacent pairs (Cancel/Save, action rows) where a wide
    // left/right slop would overlap the neighbour.
    linkSlop:      { top: 16, bottom: 16, left: 10, right: 10 },
    linkSlopTight: { top: 16, bottom: 16, left: 4,  right: 4  },
  },

  // Custom-stroke icons (flame, ring, eye) must match this.
  strokePt: 1.5,
} as const;

// ── Haptics (§8.1) ───────────────────────────────────────────────────────────
// Vocabulary map: every haptic moment in the app routes to one of these keys.
// Implementation: import * as Haptics from 'expo-haptics' and call the resolved type.
// Never call Haptics directly with a literal type — go through this map.
const haptic = {
  // Selection — soft, neutral. Use for tab changes, toggles, picker scrolls.
  selection:        'selection' as const, // Haptics.selectionAsync()

  // Light impact — for primary button taps, swipe-action threshold reveal.
  light:            'impactLight' as const, // Haptics.impactAsync(Light)

  // Medium impact — for habit-complete press-in, drag-drop commit, voice tap-start.
  medium:           'impactMedium' as const,

  // Heavy impact — RESERVED for destructive confirms and long-press start only.
  heavy:            'impactHeavy' as const,

  // Soft impact — modal present, scroll bounce.
  soft:             'impactSoft' as const,

  // Success notification — habit completion resolve phase, voice command success.
  success:          'notificationSuccess' as const,

  // Warning notification — input validation, ambiguous voice. Gentle, never Error.
  warning:          'notificationWarning' as const,

  // BANNED — never use Error on routine interactions (too punitive per §8.1).
  // BANNED — never escalate haptics cumulatively (reads gamified).
  // BANNED — no per-frame haptics outside Eye ceremony.
} as const;

// Interaction → haptic mapping. Lookup table consumers can read from to stay aligned.
const hapticMap = {
  tabChange:           haptic.selection,
  buttonPrimary:       haptic.light,
  buttonSecondary:     haptic.selection,
  iconButton:          haptic.selection,
  habitPressIn:        haptic.medium,
  habitResolve:        haptic.success,
  streakMilestone:     haptic.success, // + custom CHHapticEngine pattern at call site
  longPressStart:      haptic.heavy,
  dragReorderSwap:     haptic.selection,
  dragDrop:            haptic.medium,
  swipeRevealThresh:   haptic.light,
  swipeCommit:         haptic.medium,
  pullRefreshTrigger:  haptic.medium,
  modalPresent:        haptic.soft,
  scrollBounceLimit:   haptic.soft,
  inputError:          haptic.warning,
  voiceStart:          haptic.medium,
  voiceEnd:            haptic.light,
  voiceSuccess:        haptic.success,
  voiceAmbiguous:      haptic.warning,
} as const;

// ── Motion ────────────────────────────────────────────────────────────────────
// No springs anywhere; 250ms ease is the baseline. Three continuous-animation
// exceptions, all named in CLAUDE.md §2: the Eye, the StarField, and the
// loading-surface MatrixRain (`rain` below). This comment previously named only
// the Eye and so already understated the exception list before the rain landed.
const motion = {
  standard: {
    duration: 250,
    easing:   'cubic-bezier(0.2, 0, 0, 1)',
  },
  entry: {
    duration:       350,
    easing:         'cubic-bezier(0.2, 0, 0, 1)',
    fromOpacity:    0,
    fromTranslateY: 8,
  },
  exit: {
    duration: 200,
    easing:   'cubic-bezier(0.4, 0, 1, 1)',
  },
  quick: {
    duration: 140,
    easing:   'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  ceremony: {
    duration: 680,
    easing:   'cubic-bezier(0.19, 1, 0.22, 1)',
  },
  // Loading-surface glyph rain (NEX-303) — one of the three continuous
  // exceptions noted above.
  //
  // §19 UPDATE (owner, 2026-07-22): the ≤6% lit-gold carve-out is LIFTED for
  // this surface. It was the binding constraint on how dense the field could
  // be, and the owner's call is that a 2-second, non-interactive ceremony
  // screen should be judged on how good it looks, not on a budget written for
  // interactive screens. The seal rule (§19 Palette) still binds everywhere
  // else in the app — nothing here licenses gold on an interactive surface.
  //
  // What limits the field NOW is the render cost of the cold-start gate, not
  // gold. See the note on the two-layer field below.
  rain: {
    // NEX-304 established the TWO-LAYER field: a bright near field, plus a
    // dimmer far field (far* keys) behind it at farLayerOpacity. Both layers
    // are now full-bleed walls of code — every column runs (columnFill 1) at a
    // pitch equal to the glyph width, so there are no vertical gaps to read as
    // stripes, and trails are long enough to span most of the screen.
    //
    // WHAT LIMITS THIS FIELD. Not gold any more (see the §19 note above) —
    // render cost. This mounts on the cold-start auth gate, before fonts
    // resolve and outside the <ErrorBoundary>, so mount time is the budget.
    // The renderer was changed to make that affordable: a column is ONE native
    // text view holding an attributed string, not one view per glyph (see
    // MatrixRain.tsx). That is what pays for these numbers — 64 native text
    // views for ~2600 glyphs, where the old renderer would have needed ~2600
    // views. If the splash ever gets slow to APPEAR, cut column counts (native
    // views) before trail lengths (attributed runs, far cheaper).
    //
    // Animated transforms — the other real cost, one per column on the UI
    // thread — total 64 here, against StarField's proven 80. NOTE the rain and
    // StarField both run on the splash, so the device is carrying ~144 animated
    // nodes together. That is the number to watch if the splash ever janks, and
    // it is the reason this field is ONE stream per column rather than two:
    // doubling the streams would double the transforms, not the glyphs.
    //
    // Measured on 393x852 by stepping the real motion model (see glyphAlpha /
    // columnHeadY): 55% of the screen is occupied at any instant by a legible
    // glyph, against 17% for the field this replaces, with horizontal reach
    // 93% (near) and 100% (far) against 57%. Lit gold lands around 16.5% on
    // the scale the old carve-out was measured in — roughly 3x the retired
    // ceiling, which is the point of lifting it.
    //
    // NEAR FIELD — the bright foreground streams, white-hot heads.
    columns:        28,     // 14.0pt pitch vs a 13pt glyph: adjacent, no gaps
    columnFill:     1,      // every column runs; phase variation does the work
    trailGlyphs:    34,     // ~544pt of trail on an 852pt screen
    glyphSizePt:    13,
    glyphLeadingPt: 16,     // vertical pitch between glyphs in a column
    // Per-column fall speed, randomized in range. Tuned against the real
    // cycle time, not by feel: a column's wrap span is
    // fieldHeight + 2*trail*leading (~1940pt on a 393x852 device), so these
    // give a ~4.6-10.8s full pass. An earlier 38-96 pt/s draft looked
    // reasonable in isolation and was badly wrong in situ — a 21-27s cycle
    // reads as a static frame with a faint drift.
    speedMinPtPerS: 180,
    speedMaxPtPerS: 420,
    // Glyph mutation. NOT per frame, and no longer one glyph per tick: the
    // old 120ms/1-glyph cadence changed ~17 characters over an entire splash
    // (out of ~700), so the field read as falling wallpaper rather than
    // churning code. Characters flickering in place is a defining property of
    // the effect, and it is FREE against every budget except JS-thread time —
    // swapping which character sits in a slot changes no alpha and no area.
    // Cost is one React re-render per affected column, so this is priced in
    // column-renders/sec (~110 here), not in glyphs.
    swapIntervalMs: 55,
    swapsPerTick:   6,
    // Alpha of the glyph directly behind the head. Now that gold is not
    // rationed this sits where the reference footage does — the wake reads as
    // bright code, not as a faint smear.
    trailAlphaMax:  0.75,
    // Bends the trail ramp; see glyphAlpha. A straight ramp over a 34-glyph
    // trail reads as a uniform grey bar, which is the single most artificial
    // thing a long trail can do. Front-loading the decay gives the hot head +
    // long faint wake the effect is actually made of.
    trailFalloff:   1.6,
    tickMs:         16,     // ~60fps shared clock
    // FAR FIELD — the defocused background plane. Denser, smaller and slower
    // than the near field, and held well below it in brightness so the two
    // read as depth rather than as one noisy layer.
    farColumns:        36,    // 10.9pt pitch vs an 11pt glyph
    farColumnFill:     1,
    farTrailGlyphs:    46,    // ~598pt — the background runs nearly full-height
    farGlyphSizePt:    11,
    farGlyphLeadingPt: 13,
    farAlphaMax:       0.85,
    // Much gentler than the near field's 1.6, for two reasons that agree: a
    // defocused distant plane genuinely has lower contrast, and this is the
    // layer whose job is to FILL — a flatter ramp keeps more of each trail
    // above the legibility floor. Measured +2pp of screen fill vs 1.2, with no
    // cost to the near field's hot-head read.
    farTrailFalloff:   0.8,
    // 0.12 → 0.30. At the old value everything past the far head sat under the
    // legibility floor, so the layer measured as texture rather than code (3%
    // of the screen). It is the plane that actually fills the screen, so it
    // has to be readable. A far head is still ~3.3x dimmer than a near head,
    // which is what preserves the depth read.
    farLayerOpacity:   0.3,
    // Faster than the old 70-170: the wrap span grew to ~2050pt with the long
    // trail, and the old floor would have taken ~29s for a full pass — the
    // static-frame failure the near-field comment above warns about. Still
    // well under the near field, so the parallax read holds.
    farSpeedMinPtPerS: 110,
    farSpeedMaxPtPerS: 260,
    // NEX-304: minimum time the cold-start splash holds once mounted — dismiss
    // on the LATER of (data ready, floor elapsed), the same contract as
    // preparing-interstitial's MIN_DISPLAY_MS. Without it, a warm signed-in
    // launch resolves auth + cached RevenueCat in ~100-400ms and the rain is
    // gone before the native splash's fade even finishes. Deliberate friction
    // spend, owner-retuned 2026-07-17 on-device (1500 felt too quick), then
    // trimmed 2200→2000 on 2026-07-22 alongside the denser field — a fuller
    // screen reads as "more" in less time, so the floor buys the same weight
    // in a shorter hold. The floor only ever EXTENDS the splash, never
    // truncates a slow launch.
    splashFloorMs:  2000,
  },
} as const;

// ── Compat aliases ─────────────────────────────────────────────────────────────
// Maps old token names to new values so existing consumers keep building during
// migration. Do NOT add new usages against these keys — use `color.*` directly.
const compat = {
  basalt:      color.void,
  obsidian:    color.surface,
  andesite:    color.surfaceElevated,
  granite:     color.goldHairline,
  gold:        color.gold,           // v1 #C9A14D → v2 #D4A056 → v3 #E5BA6E (stellar — brighter so gold asserts against cosmic backdrop)
  goldWarm:    color.goldBright,
  goldPressed: color.goldDeep,
  goldGlow:    color.goldWash,
  goldGhost:   color.goldHairline,   // v2 gold-tint 8% → v3 luminous white 10% (cosmic edge register)
  parchment:   color.text,           // v1 #F0F0F0 → v2 #F5EFDC cream → v3 #FFFFFF pure white (matches new pure-white stars)
  dusk:        color.textSecondary,
  sanctum:     color.textDisabled,
  ember:       color.textMuted,
  error:       color.stateError,
  background:  color.void,
  surface:     color.surface,
  border:      color.goldHairline,
  text:        color.text,
  mutedText:   color.textMuted,
  accent:      color.gold,
} as const;

// ── Root export ────────────────────────────────────────────────────────────────
const tokens = {
  color,
  font,
  type,
  spacing: space,
  radii,
  motion,
  material,
  icon,
  haptic,
  hapticMap,
  GOLD_USAGE_BUDGET: 0.10,
  compat,
} as const;

export type TokenType = typeof tokens;
export default tokens;

// ── Named exports for consumers using the old import shape ────────────────────
// These let existing files using `import { colors, spacing, typography }` keep
// building while the migration to `tokens.color.*` / `tokens.type.*` proceeds.
// Prefer `tokens.color.*` and `tokens.type.*` in all new code.

/** Flat color map: all new color tokens + all compat aliases. */
export const colors = { ...compat, ...color } as const;

/** Spacing scale (unchanged shape). */
export const spacing = space;

/** Type scale: all new type tokens + old shape aliases for existing consumers. */
export const typography = {
  // All new tokens
  ...type,
  // Old key → nearest new equivalent
  display:      type.poeticHero,
  displayLarge: type.poeticMd,
  label:        type.labelTrackedSm,
  labelLarge:   type.labelTrackedLg,
  body:         type.bodyMd,
  bodySmall:    type.bodyMd,
  numeral:      type.numericSm,
  numeralLarge: type.numericDisplay,
  button:       type.buttonPrimary,
} as const;
