/**
 * RiveCosmicRing — the Rive-powered Home hero.
 * ────────────────────────────────────────────────────────────────────
 * This file is intentionally defensive:
 *   1. If `@rive-app/react-native` (Nitro) is not installed yet, `RiveLib`
 *      stays null and <RiveCosmicRing> renders a placeholder. The app
 *      does not crash.
 *   2. If the .riv asset is missing, the placeholder renders with a
 *      diagnostic message (dev only) or a clean SVG ring (production).
 *   3. Once both are present, the real Rive hero activates.
 *
 * Migrated from `rive-react-native` (legacy) to `@rive-app/react-native`
 * (Nitro) on 2026-04-28. Score data binding is intentionally deferred to
 * the next step — this revision only swaps the SDK and gets the component
 * rendering with the new API.
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { HOME_RING_CONFIG, NEXUS_PALETTE, qualitativeWordFor } from './motion-config';
import tokens from '@/src/theme/tokens';

// ─── Defensive import of @rive-app/react-native (Nitro) ───────────────────
// Using require() in a try/catch so bundler doesn't hard-fail if the
// package is absent. Once `npx expo install @rive-app/react-native
// react-native-nitro-modules` runs and the native build is rebuilt, this
// resolves to the real library.
let RiveLib: any = null;
let RiveImportError: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RiveLib = require('@rive-app/react-native');
} catch (err: any) {
  RiveImportError = String(err?.message ?? err);
}

// ─── .riv asset require (uncomment when the file exists) ─────────────────
// Metro resolves require() statically at bundle time, so a try/catch won't
// save you from a missing file — the bundle itself fails. Leaving the
// require commented until Week 1 is the honest path.
//
// When you drop nexus-cosmic-ring.riv into ./assets/:
//   1. Confirm 'riv' is in metro.config.js `resolver.assetExts` (already done in Phase 0)
//   2. Uncomment the line below
//   3. `npx expo start --clear` to refresh the asset cache
//
let ringAssetModule: any = require('./assets/nexus-cosmic-ring.riv');
const ringAssetError: string | null = null;

export interface RiveCosmicRingProps {
  /** 0–100. Drives arc fill, halo brightness, color temperature, qual word. */
  score: number;
  /** Size of the hero in logical px. Default 280. */
  size?: number;
  /** Show the small debug banner when the asset or package is missing. */
  debug?: boolean;
}

/**
 * The real deal. Only renders if (a) rive-react-native is installed AND
 * (b) the .riv asset is bundled. Otherwise delegates to <RivePlaceholder>.
 */
export function RiveCosmicRing({ score, size = 280, debug = false }: RiveCosmicRingProps) {
  // Fast-path bail-outs first.
  if (!RiveLib) {
    return <RivePlaceholder
      score={score}
      size={size}
      reason="rive-react-native not installed"
      detail={RiveImportError ?? undefined}
      debug={debug}
    />;
  }
  if (!ringAssetModule) {
    return <RivePlaceholder
      score={score}
      size={size}
      reason={`asset missing: ${HOME_RING_CONFIG.assetName}`}
      detail={ringAssetError ?? undefined}
      debug={debug}
    />;
  }

  return <RiveLive score={score} size={size} />;
}

// ─── Live Rive component (hooks only run when lib is present) ─────────────
//
// Nitro pattern: useRiveFile loads the .riv, useRive gives the hybridRef,
// useViewModelInstance binds to the ViewModel and seeds initial values via
// onInit, useRiveNumber returns a setter the React effect drives on score
// changes. RiveView wires file + hybridRef + dataBind together.
// Color and status-text bindings are intentionally NOT wired yet — score
// only. (useRiveString / useRiveEnum land in the next step.)

function RiveLive({ score, size }: { score: number; size: number }) {
  const RiveView = RiveLib.RiveView;
  const useRiveFile = RiveLib.useRiveFile;
  const useRive = RiveLib.useRive;
  const Fit = RiveLib.Fit;
  const Alignment = RiveLib.Alignment;
  const useViewModelInstance = RiveLib.useViewModelInstance;
  const useRiveNumber = RiveLib.useRiveNumber;

  const { riveFile } = useRiveFile(ringAssetModule);
  const { setHybridRef } = useRive();

  // Bind to the ViewModel's `score` number property. onInit seeds the
  // initial value so the very first render isn't a flash of zero. The
  // useEffect below pushes subsequent prop changes through setScore.
  // If the ViewModel exposes the property under a different name in the
  // editor, all three references below must change to match.
  const { instance } = useViewModelInstance(riveFile, {
    onInit: (vmi: any) => {
      const p = vmi.numberProperty('score');
      if (p) p.value = Math.max(0, Math.min(100, score));
    },
  });
  const { setValue: setScore } = useRiveNumber('score', instance);

  React.useEffect(() => {
    if (!setScore) return;
    setScore(Math.max(0, Math.min(100, score)));
  }, [score, setScore]);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <RiveView
        file={riveFile}
        hybridRef={setHybridRef}
        {...(instance ? { dataBind: instance } : {})}
        stateMachineName={HOME_RING_CONFIG.stateMachine}
        fit={Fit.Contain}
        alignment={Alignment.Center}
        style={styles.rive}
        onError={(e: any) => console.warn('[Rive]', e?.type, e?.message)}
      />
    </View>
  );
}

// ─── Placeholder (Phase 0 → Week 4 default) ───────────────────────────────

interface PlaceholderProps {
  score: number;
  size: number;
  reason: string;
  detail?: string;
  debug: boolean;
}

/**
 * Renders while Rive or the .riv asset is absent. Intentionally minimal —
 * a centered score numeral over a subtle ring. The goal is "this screen
 * is alive, just not cinematic yet," not "this screen is broken."
 */
function RivePlaceholder({ score, size, reason, detail, debug }: PlaceholderProps) {
  const qual = qualitativeWordFor(score);
  const ringPct = clamp(score, 0, 100) / 100;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Poor-man's SVG-less ring using two circles via borders */}
      <View
        style={[
          styles.ringOuter,
          {
            width: size * 0.88,
            height: size * 0.88,
            borderRadius: (size * 0.88) / 2,
            opacity: 0.15 + ringPct * 0.55,
          },
        ]}
      />
      <View style={styles.center}>
        <Text style={styles.scoreNumeral}>{Math.round(score)}</Text>
        <Text style={styles.qualWord}>{qual.toUpperCase()}</Text>
      </View>

      {debug && (
        <View style={styles.debugBanner}>
          <Text style={styles.debugBannerText}>COSMIC PIPELINE · PLACEHOLDER</Text>
          <Text style={styles.debugBannerReason}>{reason}</Text>
          {detail && (
            <Text style={styles.debugBannerDetail} numberOfLines={2}>
              {detail}
            </Text>
          )}
          <Text style={styles.debugBannerHint}>
            {Platform.OS === 'ios'
              ? 'Install via: npx expo install @rive-app/react-native react-native-nitro-modules · then rebuild native'
              : 'Platform not yet supported in this scaffold'}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

// Exported so the outer wrapper can check availability without re-trying require().
export const RIVE_RUNTIME_AVAILABLE = Boolean(RiveLib);
export const RIVE_ASSET_AVAILABLE = Boolean(ringAssetModule);

// ─── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  rive: {
    ...StyleSheet.absoluteFillObject,
  },
  ringOuter: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: NEXUS_PALETTE.gold,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // FIXME(nex-56): off-scale 68pt fontSize (decorative hero numeral) — design review (heroNumeric token is 140pt; this is a placeholder fallback, may consolidate later)
  scoreNumeral: {
    color: NEXUS_PALETTE.cream,
    fontSize: 68,
    fontWeight: '200',
    letterSpacing: -2,
    // Use Fraunces Light Italic once fonts are loaded in app entry.
    // fontFamily: 'Fraunces-LightItalic',
    fontStyle: 'italic',
  },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  qualWord: {
    color: NEXUS_PALETTE.gold,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 3,
    marginTop: tokens.spacing.xs,
    // fontFamily: 'IBMPlexMono-Regular',
  },
  debugBanner: {
    position: 'absolute',
    bottom: -8,
    left: -8,
    right: -8,
    // FIXME(nex-56): black-alpha debug bg, no token (diagnostic only) — design review
    backgroundColor: 'rgba(15, 15, 15, 0.92)',
    borderWidth: 1,
    // FIXME(nex-56): neutral #333 debug border, no token (diagnostic only) — design review
    borderColor: tokens.color.textDisabled,
    borderRadius: 10,
    padding: tokens.spacing.sm,
  },
  // FIXME(nex-56): off-scale 8pt fontSize — design review
  debugBannerText: {
    color: NEXUS_PALETTE.gold,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 2,
  },
  // FIXME(nex-56): off-scale gray #CCC + 11pt fontSize + 2pt margin — design review (debug-only)
  debugBannerReason: {
    color: tokens.color.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  // FIXME(nex-56): off-scale gray #666 + 9pt fontSize — design review (debug-only)
  debugBannerDetail: {
    color: tokens.color.textMuted,
    fontSize: 9,
    marginTop: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale gray #444 + 9pt fontSize + 6pt margin — design review (debug-only)
  debugBannerHint: {
    color: tokens.color.textDisabled,
    fontSize: 9,
    marginTop: 6,
    fontStyle: 'italic',
  },
});

// Keep ActivityIndicator imported so the eventual loading-state branch
// doesn't need another edit. (No-op reference.)
void ActivityIndicator;
