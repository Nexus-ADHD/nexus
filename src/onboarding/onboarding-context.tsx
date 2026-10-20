/**
 * OnboardingProvider — target-based onboarding engine.
 *
 * Holds:
 *   - a registry of named target refs (Map keyed by string)
 *   - the currently-active flow + step index
 *   - a persisted record of completed step ids
 *
 * The targets registry is a useRef-backed Map (mutating it must not
 * trigger every consumer to re-render). A small `targetsRevision` state
 * is bumped on register/unregister so the overlay re-runs its measure
 * effect when a late-mounting screen registers the next step's anchor.
 *
 * Persistence: completed step ids live in a single AsyncStorage key
 * ('nexus_onboarding_completed') as a flat boolean record. They survive
 * `resetState` (Zustand) by design — completed onboarding doesn't replay
 * after sign-out the same way a tutorial doesn't replay after an account
 * switch on the same install.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { FLOWS, type OnboardingFlow, type OnboardingStep } from './onboarding-flows';

// `View` ref shape varies enough that any-typing the registry value is
// the pragmatic choice — the overlay only ever calls `measureInWindow`.
type TargetRef = unknown;

const COMPLETED_STORAGE_KEY = 'nexus_onboarding_completed';

interface OnboardingContextShape {
  registerTarget: (key: string, ref: TargetRef) => void;
  unregisterTarget: (key: string) => void;
  /** Read-only access to a registered target ref. Returns null if missing. */
  getTarget: (key: string) => TargetRef | null;

  startFlow: (flowId: string) => void;
  nextStep: () => void;
  dismissFlow: () => void;

  currentFlowId: string | null;
  currentStep: OnboardingStep | null;
  completedSteps: Record<string, boolean>;
  /** NEX-36: convenience accessor for callers (e.g. home-screen's
   *  auto-start useFocusEffect) that need to avoid re-triggering a
   *  flow while one is already active. */
  isFlowActive: boolean;

  /** Bumps when a target registers/unregisters. Used by the overlay to
   *  re-measure when a late-mounting screen brings the next anchor on
   *  screen. */
  targetsRevision: number;
}

const OnboardingContext = createContext<OnboardingContextShape | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  // Target registry — useRef to avoid re-renders on register/unregister.
  const targetsRef = useRef<Map<string, TargetRef>>(new Map());
  const [targetsRevision, setTargetsRevision] = useState(0);

  // Active flow state.
  const [activeFlow, setActiveFlow] = useState<OnboardingFlow | null>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(-1);

  // Persisted completion set.
  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>({});
  const completedHydratedRef = useRef(false);

  // ── Hydrate completion record once on mount ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(COMPLETED_STORAGE_KEY);
        if (cancelled) return;
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Defensive: only accept boolean values.
            const cleaned: Record<string, boolean> = {};
            Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
              if (typeof v === 'boolean') cleaned[k] = v;
            });
            setCompletedSteps(cleaned);
          }
        }
      } catch (e) {
        console.warn('[Onboarding] failed to hydrate completed steps:', e);
      } finally {
        if (!cancelled) completedHydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Target registry ──────────────────────────────────────────────────────
  const registerTarget = useCallback((key: string, ref: TargetRef) => {
    if (!key) return;
    targetsRef.current.set(key, ref);
    setTargetsRevision((n) => n + 1);
  }, []);

  const unregisterTarget = useCallback((key: string) => {
    if (!key) return;
    if (targetsRef.current.delete(key)) {
      setTargetsRevision((n) => n + 1);
    }
  }, []);

  const getTarget = useCallback((key: string): TargetRef | null => {
    return targetsRef.current.get(key) ?? null;
  }, []);

  // ── Persistence helper ───────────────────────────────────────────────────
  const persistCompleted = useCallback(async (next: Record<string, boolean>) => {
    try {
      await AsyncStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('[Onboarding] failed to persist completed steps:', e);
    }
  }, []);

  // ── Flow control ─────────────────────────────────────────────────────────
  const startFlow = useCallback(
    (flowId: string) => {
      const flow = FLOWS[flowId];
      if (!flow) {
        console.warn(`[Onboarding] startFlow: unknown flow "${flowId}"`);
        return;
      }
      // Skip past any already-completed steps. If everything is done,
      // there's nothing to show — keep activeFlow null.
      const firstUncompleted = flow.steps.findIndex((s) => !completedSteps[s.id]);
      if (firstUncompleted === -1) {
        return;
      }
      setActiveFlow(flow);
      setActiveStepIndex(firstUncompleted);
    },
    [completedSteps]
  );

  const dismissFlow = useCallback(() => {
    setActiveFlow(null);
    setActiveStepIndex(-1);
  }, []);

  const nextStep = useCallback(() => {
    if (!activeFlow) return;
    const current = activeFlow.steps[activeStepIndex];
    if (!current) {
      dismissFlow();
      return;
    }

    // Mark current id complete + persist.
    const updated = { ...completedSteps, [current.id]: true };
    setCompletedSteps(updated);
    void persistCompleted(updated);

    // Advance to next un-completed step.
    let nextIdx = activeStepIndex + 1;
    while (nextIdx < activeFlow.steps.length && updated[activeFlow.steps[nextIdx].id]) {
      nextIdx += 1;
    }
    if (nextIdx >= activeFlow.steps.length) {
      dismissFlow();
      return;
    }
    setActiveStepIndex(nextIdx);
  }, [activeFlow, activeStepIndex, completedSteps, dismissFlow, persistCompleted]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const currentStep: OnboardingStep | null = useMemo(() => {
    if (!activeFlow || activeStepIndex < 0) return null;
    return activeFlow.steps[activeStepIndex] ?? null;
  }, [activeFlow, activeStepIndex]);

  const value = useMemo<OnboardingContextShape>(
    () => ({
      registerTarget,
      unregisterTarget,
      getTarget,
      startFlow,
      nextStep,
      dismissFlow,
      currentFlowId: activeFlow?.id ?? null,
      currentStep,
      completedSteps,
      targetsRevision,
      isFlowActive: activeFlow !== null,
    }),
    [
      registerTarget,
      unregisterTarget,
      getTarget,
      startFlow,
      nextStep,
      dismissFlow,
      activeFlow,
      currentStep,
      completedSteps,
      targetsRevision,
    ]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextShape {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be called inside <OnboardingProvider>.');
  }
  return ctx;
}
