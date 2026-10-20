/**
 * Motion Feature Flags — Nexus Cosmic Pipeline
 * ────────────────────────────────────────────────────────────────────
 * Isolated from app-state.ts on purpose. The cosmic pipeline is
 * experimental; every flag here should be reversible in one line.
 *
 * Usage:
 *   const { homeRingEnabled } = useMotionFlags();
 *   const setHomeRingEnabled = useMotionFlags(s => s.setHomeRingEnabled);
 *
 * Flags default OFF so the app behaves identically to today's build
 * until a tester explicitly opts in via Settings → Debug.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

const MOTION_STORAGE_KEY = 'nexus-motion-flags';
const MOTION_PERSIST_VERSION = 1;

export interface MotionFlagsState {
  /** Master kill switch. When false, no Rive/HEVC assets load regardless of sub-flags. */
  motionPipelineEnabled: boolean;

  /** Home tab accretion ring (Phase 1–3 deliverable). */
  homeRingEnabled: boolean;

  /** Command tab cosmic eye (Phase 4 deliverable). */
  commandEyeEnabled: boolean;

  /** HEVC-alpha nebula underlay on Command (Phase 5 deliverable). */
  commandNebulaEnabled: boolean;

  /** Show diagnostic overlays (asset-load status, fps counter). Dev builds only. */
  motionDebugOverlay: boolean;

  setMotionPipelineEnabled: (v: boolean) => void;
  setHomeRingEnabled: (v: boolean) => void;
  setCommandEyeEnabled: (v: boolean) => void;
  setCommandNebulaEnabled: (v: boolean) => void;
  setMotionDebugOverlay: (v: boolean) => void;

  /** Convenience: disables every motion flag in one call (safety net). */
  killSwitch: () => void;
}

export const useMotionFlags = create<MotionFlagsState>()(
  persist(
    (set) => ({
      motionPipelineEnabled: false,
      homeRingEnabled: false,
      commandEyeEnabled: false,
      commandNebulaEnabled: false,
      motionDebugOverlay: false,

      setMotionPipelineEnabled: (v) => set({ motionPipelineEnabled: v }),
      setHomeRingEnabled: (v) => set({ homeRingEnabled: v }),
      setCommandEyeEnabled: (v) => set({ commandEyeEnabled: v }),
      setCommandNebulaEnabled: (v) => set({ commandNebulaEnabled: v }),
      setMotionDebugOverlay: (v) => set({ motionDebugOverlay: v }),

      killSwitch: () =>
        set({
          motionPipelineEnabled: false,
          homeRingEnabled: false,
          commandEyeEnabled: false,
          commandNebulaEnabled: false,
        }),
    }),
    {
      name: MOTION_STORAGE_KEY,
      version: MOTION_PERSIST_VERSION,
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

/**
 * Resolve the effective home-ring state, honoring the master kill switch.
 * Prefer this over reading `homeRingEnabled` directly.
 */
export function useHomeRingActive(): boolean {
  return useMotionFlags(
    (s) => s.motionPipelineEnabled && s.homeRingEnabled
  );
}

/**
 * Resolve the effective command-eye state, honoring the master kill switch.
 */
export function useCommandEyeActive(): boolean {
  return useMotionFlags(
    (s) => s.motionPipelineEnabled && s.commandEyeEnabled
  );
}
