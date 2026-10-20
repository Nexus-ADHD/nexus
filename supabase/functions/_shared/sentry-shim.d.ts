// Local type shim for `@sentry/deno`, referenced via `// @deno-types` on the
// import in sentry.ts. Purpose: stop `deno check` from fetching the SDK's
// published `.d.ts`, which transitively references `npm:@types/node` —
// unresolvable in CI's node_modules mode (the deno-check failure). We only use
// the handful of members below, all loosely typed, so the shim costs nothing.
export interface Scope {
  setTag(key: string, value: string): void;
  setExtras(extras: Record<string, unknown>): void;
}
export function init(options: Record<string, unknown>): void;
export function withScope(callback: (scope: Scope) => void): void;
export function captureException(error: unknown): string;
export function flush(timeout?: number): Promise<boolean>;
