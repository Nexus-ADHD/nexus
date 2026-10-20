/**
 * Motion Debug Panel — internal settings for cosmic pipeline development.
 * ────────────────────────────────────────────────────────────────────
 * Mount this inside settings-screen.tsx (or a debug-only route) so the
 * team can flip Rive/HEVC flags on device without rebuilding.
 *
 * Usage:
 *   import { MotionDebugPanel } from './motion-debug-panel';
 *   ...
 *   <MotionDebugPanel />
 *
 * Recommended: gate behind __DEV__ or a TestFlight-only check, e.g.
 *   {__DEV__ && <MotionDebugPanel />}
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { ListRow, TRAILING_MAX_SCALE } from '@/src/components/ui/ListRow';
import { Toggle } from '@/src/components/ui/Toggle';
import { ListSection } from '@/src/components/ui/ListSection';
import { haptic } from '@/src/utils/haptics';
import { useMotionFlags } from '../../state/motion-flags';
import {
  RIVE_RUNTIME_AVAILABLE,
  RIVE_ASSET_AVAILABLE,
} from '../motion/RiveCosmicRing';
import tokens from '@/src/theme/tokens';

// v3 stellar: muted gray #555 → tokens.color.textMuted.
// (BORDER/SURFACE/TEXT retired with the hand-rolled card and row styles —
// the kit ListSection/ListRow own that material now.)
const MUTED = tokens.color.textMuted;

export function MotionDebugPanel() {
  const flags = useMotionFlags();

  // Toggle owns the value-change haptic — no haptic here or it double-fires.
  const toggle = (setter: (v: boolean) => void, current: boolean) => {
    setter(!current);
  };

  const confirmKill = () => {
    Alert.alert(
      'Kill cosmic pipeline?',
      'Turns off every motion flag in one tap. Safe to use.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kill',
          style: 'destructive',
          onPress: () => {
            haptic('voiceAmbiguous');
            flags.killSwitch();
          },
        },
      ]
    );
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>COSMIC PIPELINE · DEBUG</Text>

      {/* Runtime status. The old hand-rolled card carried the horizontal
          margin; ListSection has none, so the panel keeps it here or it goes
          full-bleed while its section label stays inset. */}
      <ListSection style={styles.group}>
        <StatusRow label="rive-react-native" ok={RIVE_RUNTIME_AVAILABLE} />
        <StatusRow label="nexus-cosmic-ring.riv" ok={RIVE_ASSET_AVAILABLE} />
      </ListSection>

      {/* Master switch */}
      <ListSection style={styles.groupSpaced}>
        <SwitchRow
          label="Motion pipeline (master)"
          hint="Kill switch for all motion work"
          value={flags.motionPipelineEnabled}
          onToggle={() =>
            toggle(flags.setMotionPipelineEnabled, flags.motionPipelineEnabled)
          }
        />
        <SwitchRow
          label="Home ring"
          hint="Phase 1–3 · Rive accretion ring"
          value={flags.homeRingEnabled}
          onToggle={() =>
            toggle(flags.setHomeRingEnabled, flags.homeRingEnabled)
          }
          disabled={!flags.motionPipelineEnabled}
        />
        <SwitchRow
          label="Command eye"
          hint="Phase 4 · Rive cosmic iris"
          value={flags.commandEyeEnabled}
          onToggle={() =>
            toggle(flags.setCommandEyeEnabled, flags.commandEyeEnabled)
          }
          disabled={!flags.motionPipelineEnabled}
        />
        <SwitchRow
          label="Command nebula"
          hint="Phase 5 · HEVC-alpha underlay"
          value={flags.commandNebulaEnabled}
          onToggle={() =>
            toggle(flags.setCommandNebulaEnabled, flags.commandNebulaEnabled)
          }
          disabled={!flags.motionPipelineEnabled}
        />
        <SwitchRow
          label="Debug overlay"
          hint="Show asset-status banner on hero"
          value={flags.motionDebugOverlay}
          onToggle={() =>
            toggle(flags.setMotionDebugOverlay, flags.motionDebugOverlay)
          }
        />
      </ListSection>

      {/* Kill switch */}
      <Pressable style={styles.killBtn} onPress={confirmKill}>
        <Text style={styles.killBtnText}>KILL ALL MOTION FLAGS</Text>
      </Pressable>
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function SwitchRow({
  label,
  hint,
  value,
  onToggle,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <ListRow
      title={label}
      subtitle={hint}
      disabled={disabled}
      trailing="toggle"
      trailingAccessory={
        <Toggle
          value={value}
          onValueChange={onToggle}
          disabled={disabled}
          accessibilityLabel={label}
        />
      }
    />
  );
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <ListRow
      title={label}
      trailing="custom"
      // Static badge: a custom accessory is never auto-announced, so the
      // READY/MISSING state has to be named (§10.19).
      accessoryLabel={ok ? 'ready' : 'missing'}
      trailingAccessory={
        <Text
          style={[
            styles.statusBadge,
            ok ? styles.statusOk : styles.statusMissing,
          ]}
          maxFontSizeMultiplier={TRAILING_MAX_SCALE}
        >
          {ok ? 'READY' : 'MISSING'}
        </Text>
      }
    />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

// FIXME(nex-56): status palette — 2 semantic colors (green ok / orange missing) plus alpha bg variants, no tokens — design review (CLAUDE.md uses teal for success, no equivalent for "missing")
const styles = StyleSheet.create({
  section: { marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale 9pt fontSize, design review (matches labelTrackedMicro 9.5pt — close)
  // FIXME(nex-56): off-scale 10pt margin, design review
  sectionLabel: {
    color: MUTED,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 2,
    marginBottom: 10,
    paddingHorizontal: tokens.spacing.md,
  },
  // Row group inset — the card/row/rowLabel/rowHint/divider styles are gone,
  // replaced by kit ListSection + ListRow (§10.19).
  group: { marginHorizontal: tokens.spacing.md },
  // ListSection's `style` is a plain ViewStyle (not StyleProp), so a spaced
  // group is its own entry rather than an inline array.
  groupSpaced: { marginHorizontal: tokens.spacing.md, marginTop: tokens.spacing.sm },
  // FIXME(nex-56): off-scale 9pt fontSize, design review
  statusBadge: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 2,
    paddingHorizontal: tokens.spacing.xs,
    paddingVertical: tokens.spacing.xxs,
    borderRadius: 6,
    overflow: 'hidden',
  },
  // v3 stellar: semantic status — ok=teal, missing=stateError (warm red).
  statusOk: { color: tokens.color.teal, backgroundColor: tokens.color.tealWash },
  statusMissing: { color: tokens.color.stateError, backgroundColor: 'rgba(229,91,69,0.12)' },
  killBtn: {
    marginHorizontal: tokens.spacing.md,
    marginTop: tokens.spacing.sm,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    // v3 stellar: destructive btn red tints retoned to stateError-rgba.
    borderColor: 'rgba(229,91,69,0.35)',
    backgroundColor: 'rgba(229,91,69,0.06)',
    alignItems: 'center',
  },
  killBtnText: {
    color: tokens.color.stateError,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 2,
  },
});
