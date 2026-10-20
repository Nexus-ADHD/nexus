/**
 * Nexus AI Model Routing — re-export shim.
 *
 * The canonical routing table now lives in src/ai/models.js (pure ESM, zero
 * React Native imports) so the Node eval harness and the RN app share one
 * source of truth. This file stays as the app-facing entry point; existing
 * importers (`import { MODELS } from '.../ai-models'`) are unchanged.
 *
 * See src/ai/models.js for the routing table, the per-tier rationale, and the
 * rules it enforces (DEFAULT is standalone; every id must be PROXY-routable).
 *
 * NEX-305 removed the `isAnthropicModel` / `isOpenAIModel` exports — both had
 * zero consumers, and `isOpenAIModel` was a deny-list-shaped check that passed
 * any unrecognized id. `isOpenAIRoutable` / `assertOpenAIRoutable` replaced them
 * with an allow-list that fails closed.
 *
 * NEX-314 added the provider-aware pair `isProxyRoutable` / `assertProxyRoutable`
 * once NEX-311 gave the proxy a real Anthropic route: the OpenAI-only guard would
 * otherwise reject every claude-* id before it left the device. The dispatch path
 * now gates on the proxy-routable pair; the OpenAI-specific ones remain exported.
 */
export {
  MODELS,
  MODEL_TIER_NAMES,
  isOpenAIRoutable,
  assertOpenAIRoutable,
  isAnthropicRoutable,
  isKimiRoutable,
  isProxyRoutable,
  assertProxyRoutable,
} from '@/src/ai/models';
