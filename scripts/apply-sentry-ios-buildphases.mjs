#!/usr/bin/env node
// scripts/apply-sentry-ios-buildphases.mjs
//
// Wires Sentry source-map + dSYM upload into the COMMITTED iOS project so release
// App Hang / crash stacks symbolicate. This repo is NOT `expo prebuild`-managed
// (committed ios/, prebuild --clean would destroy the NexusWidget target), so the
// `@sentry/react-native/expo` config plugin never runs — this script applies the
// SAME two pbxproj mutations the plugin's withSentryIOS would, idempotently, using
// the `xcode` package so the serialization is byte-correct.
//
// What it does (mirrors node_modules/@sentry/react-native/plugin/build/withSentryIOS.js):
//   1. Adds a "Upload Debug Symbols to Sentry" PBXShellScriptBuildPhase (dSYM upload).
//      The script self-skips *Debug* configurations and never fails the build.
//   2. Wraps the existing "Bundle React Native code and images" phase with
//      sentry-xcode.sh so JS source maps (with Debug IDs from metro.config.js) upload.
//
// Credentials are read by the Sentry scripts from ios/sentry.properties (gitignored,
// used by local Xcode archives) OR the SENTRY_* env vars (EAS builds). For a credless
// LOCAL Release build, add `export SENTRY_DISABLE_AUTO_UPLOAD=true` to a gitignored
// ios/.xcode.env.local (the bundle phase already sources it).
//
// Idempotent: re-running after a pbxproj regeneration re-applies cleanly and is a
// no-op if the wiring is already present. Run: `node scripts/apply-sentry-ios-buildphases.mjs`

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const xcode = require('xcode');

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PBXPROJ = path.join(PROJECT_ROOT, 'ios', 'Nexus.xcodeproj', 'project.pbxproj');

// Exact strings from withSentryIOS.js (do not edit — must match the plugin's form).
const SENTRY_XCODE_PATH =
  "`\"$NODE_BINARY\" --print \"require('path').dirname(require.resolve('@sentry/react-native/package.json')) + '/scripts/sentry-xcode.sh'\"`";
const SENTRY_DEBUG_FILES_PATH =
  "`${NODE_BINARY:-node} --print \"require('path').dirname(require.resolve('@sentry/react-native/package.json')) + '/scripts/sentry-xcode-debug-files.sh'\"`";

// The dSYM phase resolves the sentry script path via `${NODE_BINARY:-node}` BEFORE
// the script itself sources with-environment.sh — so source the RN `.xcode.env`
// files first (exactly like the bundle phase does), or a local archive whose Node
// lives only in `.xcode.env` fails with `node: command not found` and blocks the
// archive before the upload runs (Greptile PR #303). EAS / PATH-node setups are
// unaffected. This is the one deliberate addition over the plugin's bare form.
const DSYM_SHELL = [
  'if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then',
  '  source "$PODS_ROOT/../.xcode.env"',
  'fi',
  'if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then',
  '  source "$PODS_ROOT/../.xcode.env.local"',
  'fi',
  `/bin/sh ${SENTRY_DEBUG_FILES_PATH}`,
].join('\n');

// Mirrors addSentryWithBundledScriptsToBundleShellScript in withSentryIOS.js.
function wrapBundleShellScript(code) {
  return code.replace(
    /^.*?(packager|scripts)\/react-native-xcode\.sh\s*(\\'\\\\")?/m,
    (match) => `/bin/sh ${SENTRY_XCODE_PATH} ${match}`,
  );
}

const proj = xcode.project(PBXPROJ);
proj.parseSync();

let changed = false;

// 1. dSYM upload phase (idempotent — pbxItemByComment returns it if already present).
const existingDsymPhase = proj.pbxItemByComment(
  'Upload Debug Symbols to Sentry',
  'PBXShellScriptBuildPhase',
);
if (!existingDsymPhase) {
  proj.addBuildPhase([], 'PBXShellScriptBuildPhase', 'Upload Debug Symbols to Sentry', null, {
    shellPath: '/bin/sh',
    shellScript: DSYM_SHELL,
  });
  changed = true;
  console.log('[sentry-ios] added "Upload Debug Symbols to Sentry" build phase');
} else if (!existingDsymPhase.shellScript.includes('.xcode.env')) {
  // Upgrade an older dSYM phase that lacks the `.xcode.env` sourcing.
  existingDsymPhase.shellScript = JSON.stringify(DSYM_SHELL);
  changed = true;
  console.log('[sentry-ios] updated dSYM phase to source .xcode.env before resolving Node');
} else {
  console.log('[sentry-ios] dSYM upload phase already present — skipping');
}

// 2. Wrap the bundle phase with sentry-xcode.sh (idempotent).
const bundlePhase = proj.pbxItemByComment(
  'Bundle React Native code and images',
  'PBXShellScriptBuildPhase',
);
if (!bundlePhase) {
  throw new Error('[sentry-ios] "Bundle React Native code and images" phase not found');
}
if (!/(packager|scripts)\/react-native-xcode\.sh\b/.test(bundlePhase.shellScript)) {
  throw new Error('[sentry-ios] react-native-xcode.sh not found in the bundle phase');
}
if (bundlePhase.shellScript.includes('sentry-xcode.sh')) {
  console.log('[sentry-ios] bundle phase already wrapped with sentry-xcode.sh — skipping');
} else if (bundlePhase.shellScript.includes('@sentry')) {
  // Mirrors withSentryIOS.js: an outdated/custom Sentry script is present but not
  // the current sentry-xcode.sh — don't double-wrap; surface it for manual review.
  console.warn(
    '[sentry-ios] outdated/custom Sentry script found in the bundle phase — leaving as-is. Regenerate to update.',
  );
} else {
  const decoded = JSON.parse(bundlePhase.shellScript);
  bundlePhase.shellScript = JSON.stringify(wrapBundleShellScript(decoded));
  changed = true;
  console.log('[sentry-ios] wrapped bundle phase with sentry-xcode.sh');
}

if (changed) {
  const fs = require('node:fs');
  fs.writeFileSync(PBXPROJ, proj.writeSync());
  console.log('[sentry-ios] wrote', path.relative(PROJECT_ROOT, PBXPROJ));
} else {
  console.log('[sentry-ios] no changes needed');
}
