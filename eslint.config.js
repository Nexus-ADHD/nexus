// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const fourBoxDesign = require('./eslint-rules/four-box-design');

// Node globals for repo tooling under scripts/ (inlined rather than depending on the
// `globals` package, which is only a transitive dep of eslint-config-expo).
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'readonly',
  exports: 'writable',
  global: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
};

module.exports = defineConfig([
  expoConfig,
  {
    // supabase/functions/** is Deno (URL imports, Deno globals) — it has its own
    // `deno check` gate in CI and is not RN/Expo code, so the app eslint config
    // (which can't resolve https:// imports) should not lint it. See NEX-170.
    ignores: ['dist/*', 'supabase/functions/**', '.nexus-backups/**'],
  },
  {
    // Repo tooling in scripts/, tools/ and eslint-rules/ runs under Node, not the Expo/RN
    // runtime, so it
    // needs Node globals (process, console, __dirname, Buffer, …) to avoid spurious no-undef
    // errors. Covers the diff-aware lint gate (scripts/lint-changed-lines.mjs, NEX-115) and the
    // Apple Search Ads tooling (tools/asa/**).
    files: ['scripts/**', 'tools/**', 'eslint-rules/**'],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    // Four-box gate, box 1 (UI/UX): the design-drift ratchet.
    // docs/automation/four-box-gate.md. Allowed values are read from
    // src/theme/tokens.ts by the plugin, never copied here.
    //
    // These are plain errors on purpose. The `lint` job runs
    // scripts/lint-changed-lines.mjs (NEX-115), which filters ESLint errors to
    // the PR's changed lines, so this is a ratchet on new drift and never a
    // cleanup mandate — a file's existing violations do not block a PR that
    // merely touches it. A full `npm run lint` will surface the standing debt;
    // that is the honest number, not a regression.
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    ignores: [
      // The scale itself has to state raw values; it is where they come from.
      'src/theme/tokens.ts',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
    ],
    plugins: { 'four-box': fourBoxDesign },
    rules: {
      'four-box/no-raw-hex': 'error',
      'four-box/no-off-scale-font-size': 'error',
      'four-box/no-off-scale-spacing': 'error',
      'four-box/no-off-scale-radius': 'error',
      'four-box/no-raw-modal': 'error',
    },
  },
  {
    // Sheet.tsx IS the primitive the no-raw-modal rule points at, so it is the
    // one file that must render a transparent <Modal> itself. The design-scale
    // rules stay on: the primitive is held to them like everything else.
    files: ['src/components/ui/Sheet.tsx'],
    rules: { 'four-box/no-raw-modal': 'off' },
  },
  {
    // `react/no-unescaped-entities` flags raw ' and " inside JSX text — purely stylistic and
    // very noisy. It was the keystone blocker for the autonomous harness: the changed-files
    // `lint` gate lints whole touched files, so a worker PR that touches a file carrying these
    // pre-existing violations fails lint on debt it never introduced — even at Greptile 5/5
    // (e.g. NEX-173 / PR #121). Rather than relax the rule GLOBALLY (which would let new JSX
    // introduce violations unnoticed), the downgrade is scoped to the exact set of files that
    // already carry violations today. The rule stays `error` everywhere else, so new code is
    // still gated. As each file below is touched, escape its entities and drop it from this list.
    // The proper fix is a diff-aware (changed-lines-only) lint gate — tracked as the (c)
    // follow-up to NEX-115; this scoped allowlist is the zero-risk interim unblock.
    files: [
      'app/(tabs)/align.tsx',
      'app/(tabs)/inbox.tsx',
      'app/redesign/voice.tsx',
      'app/settings/apple-reminders.tsx',
      'src/components/comeback-screen.tsx',
      'src/components/mandate-strengthen-sheet.tsx',
      'src/features/home/horizon-review.tsx',
      'src/features/settings/legal-screen.tsx',
      'src/features/this-week/this-week-screen.tsx',
      'src/features/voice/voice-journal.tsx',
    ],
    rules: {
      'react/no-unescaped-entities': 'warn',
    },
  },
]);
