#!/usr/bin/env node
/**
 * verify-ipa.mjs — the pre-upload gate for a Nexus iOS build.
 *
 * WHY THIS EXISTS. app.json tells you nothing about what actually got baked
 * into the binary. `supportsTablet: true` only reaches the IPA via the
 * REGENERATED pbxproj, and the tracked ios/ skeleton still carries
 * TARGETED_DEVICE_FAMILY = 1 for the main app target. Any reset/checkout that
 * touches tracked ios/ after a prebuild silently restores the iPhone-only
 * skeleton while leaving the untracked prebuild output in place — a half-old
 * native project that still compiles, so nothing fails loudly.
 *
 * That is not hypothetical: TestFlight build 251 shipped iPhone-only and
 * opened letterboxed on iPad (2026-08-25, LEARNINGS.md). The EAS pipeline
 * grew an inline guard the same day, but the LOCAL archive flow — which is
 * what actually shipped builds 250, 252 and 253 while the EAS free-plan quota
 * was exhausted — had none. A guard that only covers one of two release paths
 * is not a guard. This script is the shared implementation both call.
 *
 * Checks what is IN the artifact, never what the config claims:
 *   - UIDeviceFamily contains 2 (iPad). Always enforced.
 *   - CFBundleIdentifier, and optionally CFBundleVersion / runtime / channel.
 *
 * Usage:
 *   node scripts/verify-ipa.mjs --ipa build/export-254/Nexus.ipa
 *   node scripts/verify-ipa.mjs --app "$APP" --build 254 \
 *        --runtime 1.2.3 --channel production
 *
 * Exits 0 on pass, 1 on any failure, 2 on bad usage. Prints one line per
 * check so a CI log shows what was actually verified.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPECTED_BUNDLE_ID = 'com.jhuff.nexus';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function plutilExtract(plistPath, key, fmt) {
  try {
    return execFileSync('plutil', ['-extract', key, fmt, '-o', '-', plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
}

/**
 * Read a container (array/dict) key as JSON.
 *
 * `plutil -extract ... raw` is deliberately NOT used for arrays: it prints one
 * entry per line, and the inline guard this script replaces (`... | grep -q 2`)
 * would also pass on a "12", or on a stray 2 anywhere in the output. Parsing
 * real JSON and testing array membership cannot be fooled that way.
 */
function plistJson(plistPath, key) {
  const out = plutilExtract(plistPath, key, 'json');
  if (out === undefined) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/**
 * Read a scalar key. plutil refuses to emit a bare top-level string as JSON
 * ("Invalid object in plist for JSON format"), so scalars must go through
 * `raw` — which is unambiguous for a single value.
 */
function plistScalar(plistPath, key) {
  const out = plutilExtract(plistPath, key, 'raw');
  return out === undefined ? undefined : out.trim();
}

function resolveAppDir() {
  const appArg = arg('app');
  if (appArg) {
    if (!existsSync(appArg)) fail(`--app path does not exist: ${appArg}`);
    return { appDir: appArg, cleanup: () => {} };
  }

  const ipa = arg('ipa');
  if (!ipa) {
    console.error('usage: verify-ipa.mjs (--ipa <path.ipa> | --app <path.app>) [--build N] [--runtime R] [--channel C]');
    process.exit(2);
  }
  if (!existsSync(ipa)) fail(`--ipa path does not exist: ${ipa}`);

  const dir = mkdtempSync(join(tmpdir(), 'verify-ipa-'));
  try {
    execFileSync('unzip', ['-qq', '-o', ipa, 'Payload/*', '-d', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    fail(`could not unzip ${ipa}: ${e.message}`);
  }

  const payload = join(dir, 'Payload');
  const app = existsSync(payload) && readdirSync(payload).find(n => n.endsWith('.app'));
  if (!app) {
    rmSync(dir, { recursive: true, force: true });
    fail(`no .app inside ${ipa}`);
  }
  return { appDir: join(payload, app), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const { appDir, cleanup } = resolveAppDir();
const infoPlist = join(appDir, 'Info.plist');
if (!existsSync(infoPlist)) {
  cleanup();
  fail(`no Info.plist in ${appDir}`);
}

const problems = [];
const skipped = [];
const check = (label, actual, expected) => {
  // An omitted expectation is a SKIPPED check, not a passing one. It is
  // reported at the end so a partial invocation can never read as a full pass
  // — the failure mode being that the local flow checks less than the EAS
  // flow and the two silently disagree about the same artifact.
  if (expected === undefined) {
    skipped.push(label);
    return;
  }
  const ok = String(actual) === String(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) problems.push(`${label} is ${actual}, expected ${expected}`);
};

console.log(`Verifying ${appDir}`);

// ── The load-bearing one. Always enforced, never optional. ──────────────────
const families = plistJson(infoPlist, 'UIDeviceFamily');
if (!Array.isArray(families)) {
  problems.push('UIDeviceFamily missing or not an array — cannot prove the build is universal');
  console.log('  FAIL UIDeviceFamily: missing');
} else {
  const universal = families.map(Number).includes(2);
  console.log(`  ${universal ? 'ok  ' : 'FAIL'} UIDeviceFamily: [${families.join(',')}]${universal ? ' (universal)' : ' — iPHONE ONLY'}`);
  if (!universal) {
    problems.push(
      `IPA is not universal (UIDeviceFamily=[${families.join(',')}]). ` +
      'The tracked pbxproj skeleton was almost certainly restored after prebuild — ' +
      're-run `npx expo prebuild --platform ios --clean`, then add-native-targets + signing, and re-archive.'
    );
  }
}

check('CFBundleIdentifier', plistScalar(infoPlist, 'CFBundleIdentifier'), EXPECTED_BUNDLE_ID);
check('CFBundleVersion', plistScalar(infoPlist, 'CFBundleVersion'), arg('build'));

const expoPlist = join(appDir, 'Expo.plist');
if (existsSync(expoPlist)) {
  check('EXUpdatesRuntimeVersion', plistScalar(expoPlist, 'EXUpdatesRuntimeVersion'), arg('runtime'));
  check(
    'expo-channel-name',
    plistJson(expoPlist, 'EXUpdatesRequestHeaders')?.['expo-channel-name'],
    arg('channel')
  );
} else if (arg('runtime') || arg('channel')) {
  problems.push('Expo.plist missing, but --runtime/--channel were requested');
  console.log('  FAIL Expo.plist: missing');
} else {
  skipped.push('EXUpdatesRuntimeVersion', 'expo-channel-name');
}

cleanup();

if (skipped.length) {
  console.warn(`\n  NOT CHECKED (no expectation passed): ${skipped.join(', ')}`);
  console.warn('  A release upload should pass every expectation — see docs/ios/local-archive.md.');
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) — DO NOT UPLOAD:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(skipped.length ? 'IPA verified (partial — see NOT CHECKED above).' : 'IPA verified.');
