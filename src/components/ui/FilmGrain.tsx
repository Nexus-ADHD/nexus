/**
 * FilmGrain — one grain structure across the whole frame.
 *
 * WHY IT SITS ABOVE EVERYTHING
 * The backdrop already has grain baked in, but that grain is *under* the cards.
 * A camera's grain runs across the entire image — subject and background alike
 * — and that shared high-frequency texture is a large part of what separates
 * "photographed" from "rendered". Grain that stops at the edge of a card tells
 * the eye the card was pasted on.
 *
 * It also does real work on dark UI: 8-bit near-black gradients band visibly on
 * OLED, and dither is the standard fix. Below ~1.5% the banding survives; above
 * ~2% it reads as noise rather than as film.
 *
 * COST
 * One static tiled image, no animation, `pointerEvents="none"` — a single
 * composited layer for the life of the session.
 *
 * WHY THE TILE IS SYMMETRIC
 * React Native has no blend modes on Image, so there is no overlay/soft-light
 * to reach for. The tile therefore carries white speckle on half its pixels and
 * black on the other half, averaging to neutral, so plain source-over
 * compositing nets out as dither instead of lifting or crushing everything
 * underneath. Baked by scripts/bake-starfield.py, which asserts that neutrality.
 */

import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { GRAIN_OVERLAY_OPACITY } from './starfield-optics';

export function FilmGrain() {
  return (
    // The wrapper carries pointerEvents: Image has no such prop, and this layer
    // covers the entire app — it must never intercept a touch.
    <View
      style={[StyleSheet.absoluteFill, { opacity: GRAIN_OVERLAY_OPACITY }]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={require('../../../assets/images/film-grain-tile.png')}
        style={StyleSheet.absoluteFill}
        // Tiles at native pixel size rather than stretching — grain must sit at
        // the panel's resolution or it stops being grain and becomes texture.
        resizeMode="repeat"
        fadeDuration={0}
      />
    </View>
  );
}
