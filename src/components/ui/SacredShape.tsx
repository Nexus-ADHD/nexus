// NEX-75 — Hand-coded sacred-geometry SVG shapes for badge surfaces.
// Replaces emoji badges across Trophies + This Week's Progress.
//
// Five shapes, gold strokes, no fills. Geometry expressed in a 0–100
// normalized viewBox so a single component scales cleanly. Brand-voice
// rule: shapes are NEVER labeled with their esoteric names in the UI —
// they read as luminous geometric badges, not "this is the Flower of
// Life." Mapping happens only here.

import React, { useMemo } from 'react';
import { View, type ViewStyle, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, G, Line } from 'react-native-svg';
import tokens from '@/src/theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShapeName = 'vesica' | 'seed' | 'flower' | 'germ' | 'metatron';

export interface SacredShapeProps {
  name: ShapeName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  opacity?: number;
  /** Wraps the SVG in a 3-layer ambient glow stack (matches HabitRow ring). */
  glow?: boolean;
  /** Renders a small lock icon centered over the shape (use with low opacity). */
  showLockOverlay?: boolean;
  style?: ViewStyle;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

interface CirclePoint { cx: number; cy: number; }

/** Six outer circle centers around a center at distance r (axial angles). */
function ringOfSix(cx: number, cy: number, r: number): CirclePoint[] {
  const out: CirclePoint[] = [];
  for (let i = 0; i < 6; i++) {
    const theta = (Math.PI / 3) * i; // 60° steps starting at 0°
    out.push({
      cx: cx + r * Math.cos(theta),
      cy: cy + r * Math.sin(theta),
    });
  }
  return out;
}

/** Flower of Life: center + ring of 6 (radius r) + outer ring of 12. */
function flowerCenters(cx: number, cy: number, r: number): CirclePoint[] {
  const centers: CirclePoint[] = [{ cx, cy }];
  // Inner ring of 6 at distance r.
  centers.push(...ringOfSix(cx, cy, r));
  // Outer ring of 12. Six "edge-aligned" centers at distance 2r (60° steps,
  // same angles as inner ring) + six "between-aligned" at distance r√3
  // (rotated 30°). Together they form the classic 19-circle Flower.
  for (let i = 0; i < 6; i++) {
    const theta = (Math.PI / 3) * i;
    centers.push({
      cx: cx + 2 * r * Math.cos(theta),
      cy: cy + 2 * r * Math.sin(theta),
    });
    const phi = (Math.PI / 3) * i + Math.PI / 6;
    centers.push({
      cx: cx + Math.sqrt(3) * r * Math.cos(phi),
      cy: cy + Math.sqrt(3) * r * Math.sin(phi),
    });
  }
  return centers;
}

/** Fruit of Life: 13 circles in a tight hex pattern (1 + 6 + 6). */
function fruitCenters(cx: number, cy: number, r: number): CirclePoint[] {
  const centers: CirclePoint[] = [{ cx, cy }];
  centers.push(...ringOfSix(cx, cy, r));
  // Outer ring of 6 at the same 60° angles, distance 2r (NOT all 12 of the
  // Flower's outer ring — Metatron uses just 13 circles).
  for (let i = 0; i < 6; i++) {
    const theta = (Math.PI / 3) * i;
    centers.push({
      cx: cx + 2 * r * Math.cos(theta),
      cy: cy + 2 * r * Math.sin(theta),
    });
  }
  return centers;
}

// ─── Shape primitives (rendered children of a parent Svg) ─────────────────────

function VesicaShape({ color, strokeWidth }: { color: string; strokeWidth: number }) {
  return (
    <G stroke={color} strokeWidth={strokeWidth} fill="none">
      <Circle cx={38} cy={50} r={25} />
      <Circle cx={62} cy={50} r={25} />
    </G>
  );
}

function SeedShape({ color, strokeWidth }: { color: string; strokeWidth: number }) {
  const r = 20;
  const centers = useMemo(() => [{ cx: 50, cy: 50 }, ...ringOfSix(50, 50, r)], []);
  return (
    <G stroke={color} strokeWidth={strokeWidth} fill="none">
      {centers.map((c, i) => (
        <Circle key={i} cx={c.cx} cy={c.cy} r={r} />
      ))}
    </G>
  );
}

function FlowerShape({ color, strokeWidth }: { color: string; strokeWidth: number }) {
  const r = 15;
  const centers = useMemo(() => flowerCenters(50, 50, r), []);
  return (
    <G stroke={color} strokeWidth={strokeWidth} fill="none">
      {centers.map((c, i) => (
        <Circle key={i} cx={c.cx} cy={c.cy} r={r} />
      ))}
    </G>
  );
}

function GermShape({ color, strokeWidth }: { color: string; strokeWidth: number }) {
  // Germ of Life: six circles tangent at the center inside a containing
  // outer circle.
  const innerR = 17.5;
  const centers = useMemo(() => ringOfSix(50, 50, innerR), []);
  return (
    <G stroke={color} strokeWidth={strokeWidth} fill="none">
      <Circle cx={50} cy={50} r={35} />
      {centers.map((c, i) => (
        <Circle key={i} cx={c.cx} cy={c.cy} r={innerR} />
      ))}
    </G>
  );
}

function MetatronShape({
  color,
  strokeWidth,
  size,
}: {
  color: string;
  strokeWidth: number;
  size: number;
}) {
  const r = 8;
  const centers = useMemo(() => fruitCenters(50, 50, r), []);
  // Lines only at size >= 48 — at smaller sizes the 78-edge graph
  // collapses into visual noise.
  const showLines = size >= 48;
  const lines = useMemo(() => {
    if (!showLines) return [] as { x1: number; y1: number; x2: number; y2: number }[];
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        out.push({
          x1: centers[i].cx,
          y1: centers[i].cy,
          x2: centers[j].cx,
          y2: centers[j].cy,
        });
      }
    }
    return out;
  }, [centers, showLines]);

  return (
    <>
      {showLines && (
        <G stroke={color} strokeWidth={strokeWidth * 0.5} opacity={0.45} fill="none">
          {lines.map((l, i) => (
            <Line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
          ))}
        </G>
      )}
      <G stroke={color} strokeWidth={strokeWidth} fill="none">
        {centers.map((c, i) => (
          <Circle key={i} cx={c.cx} cy={c.cy} r={r} />
        ))}
      </G>
    </>
  );
}

// ─── SacredShape ──────────────────────────────────────────────────────────────

export function SacredShape({
  name,
  size = 24,
  color = tokens.color.gold,
  strokeWidth = 1.5,
  opacity = 1,
  glow = false,
  showLockOverlay = false,
  style,
}: SacredShapeProps) {
  const renderShape = (sw: number) => {
    switch (name) {
      case 'vesica':   return <VesicaShape color={color} strokeWidth={sw} />;
      case 'seed':     return <SeedShape color={color} strokeWidth={sw} />;
      case 'flower':   return <FlowerShape color={color} strokeWidth={sw} />;
      case 'germ':     return <GermShape color={color} strokeWidth={sw} />;
      case 'metatron': return <MetatronShape color={color} strokeWidth={sw} size={size} />;
    }
  };

  const lockSize = Math.max(10, Math.round(size * 0.4));

  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      {/* Glow stack — three concentric renders at decreasing strokeWidth
          + opacity. Same idea as HabitRow's ring glow: wider strokes at
          low opacity sit behind the main rendering to fake an ambient
          halo (iOS shadow* doesn't bleed through SVG children). */}
      {glow && (
        <>
          <Svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            style={StyleSheet.absoluteFill}
            opacity={0.15}
          >
            {renderShape(strokeWidth * 2.5)}
          </Svg>
          <Svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            style={StyleSheet.absoluteFill}
            opacity={0.25}
          >
            {renderShape(strokeWidth * 1.8)}
          </Svg>
        </>
      )}
      <Svg width={size} height={size} viewBox="0 0 100 100" opacity={opacity}>
        {renderShape(strokeWidth)}
      </Svg>

      {/* Lock overlay — small Ionicons lock centered on top, slightly
          inset. Used when the badge is locked (combine with low opacity
          on the underlying shape for the "ghost outline" effect). */}
      {showLockOverlay && (
        <View
          style={[
            StyleSheet.absoluteFill,
            { alignItems: 'center', justifyContent: 'center' },
          ]}
          pointerEvents="none"
        >
          <Ionicons name="lock-closed" size={lockSize} color={tokens.color.textMuted} />
        </View>
      )}
    </View>
  );
}

// ─── Badge id → shape mapping ─────────────────────────────────────────────────
//
// Mapping for BADGE_DEFINITIONS (src/state/app-state.ts). Distributes
// the 10 badges across 5 shapes, roughly grouping early/easy badges to
// simpler shapes and ramp-up badges to denser ones.

const BADGE_SHAPE_BY_ID: Record<string, ShapeName> = {
  first_step:     'vesica',
  first_week:     'seed',
  iron_will:      'germ',
  centurion:      'metatron',
  all_in:         'flower',
  early_bird:     'vesica',
  comeback_kid:   'seed',
  triple_threat:  'germ',
  level_5:        'flower',
  level_10:       'metatron',
};

export function shapeForBadgeId(id: string): ShapeName {
  return BADGE_SHAPE_BY_ID[id] ?? 'vesica';
}
