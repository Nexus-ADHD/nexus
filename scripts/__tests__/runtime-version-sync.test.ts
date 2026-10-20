// NEX-269: guard against OTA runtimeVersion drift.
//
// The OTA compatibility gate lives in TWO places that must stay in lockstep:
//   - app.json  -> expo.runtimeVersion
//   - ios/Nexus/Supporting/Expo.plist -> EXUpdatesRuntimeVersion (the value the
//     manual Xcode archive actually ships)
// Bumping one without the other ships a binary whose advertised runtime differs
// from what the OTA channel publishes — which has bitten this repo twice
// (build-178, and again during the NEX-269 PR1 review). This test fails CI if
// they diverge. Runs in the existing required `test` job (no new CI check).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function readExpoPlistRuntime(): string | undefined {
  const plist = readFileSync(resolve(ROOT, 'ios/Nexus/Supporting/Expo.plist'), 'utf8');
  return plist.match(
    /<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]*)<\/string>/,
  )?.[1];
}

describe('OTA runtimeVersion sync (NEX-269)', () => {
  it('app.json expo.runtimeVersion === ios Expo.plist EXUpdatesRuntimeVersion', () => {
    const appJson = JSON.parse(readFileSync(resolve(ROOT, 'app.json'), 'utf8'));
    const appRuntime = appJson?.expo?.runtimeVersion;

    expect(typeof appRuntime, 'app.json expo.runtimeVersion must be a string').toBe('string');

    const plistRuntime = readExpoPlistRuntime();
    expect(
      plistRuntime,
      'could not parse EXUpdatesRuntimeVersion from ios/Nexus/Supporting/Expo.plist',
    ).toBeDefined();
    expect(
      plistRuntime,
      'Expo.plist EXUpdatesRuntimeVersion must match app.json expo.runtimeVersion — bump both in lockstep',
    ).toBe(appRuntime);
  });
});
