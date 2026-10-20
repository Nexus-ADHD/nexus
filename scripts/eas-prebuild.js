/**
 * eas-prebuild.js
 * Node.js wrapper for EAS prebuildCommand — avoids shell compatibility issues.
 * Runs: expo prebuild --platform ios --clean, then add-native-targets.js
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = process.cwd();

console.log('[eas-prebuild] ===== START =====');
console.log('[eas-prebuild] Node:', process.version);
console.log('[eas-prebuild] CWD:', ROOT);
console.log('[eas-prebuild] Platform:', process.platform);

// Log native-targets presence
const ntDir = path.join(ROOT, 'native-targets');
if (fs.existsSync(ntDir)) {
  console.log('[eas-prebuild] native-targets/ found:', fs.readdirSync(ntDir));
} else {
  console.error('[eas-prebuild] ERROR: native-targets/ NOT FOUND');
  process.exit(1);
}

// Step 1: expo prebuild
console.log('[eas-prebuild] Running expo prebuild --platform ios --clean...');
try {
  execSync('npx expo prebuild --platform ios --clean', {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env }
  });
  console.log('[eas-prebuild] expo prebuild: SUCCESS');
} catch (err) {
  console.error('[eas-prebuild] expo prebuild FAILED:', err.message);
  process.exit(1);
}

// Verify ios/ was created
const iosDir = path.join(ROOT, 'ios');
if (!fs.existsSync(iosDir)) {
  console.error('[eas-prebuild] ERROR: ios/ not created by expo prebuild');
  process.exit(1);
}
console.log('[eas-prebuild] ios/ contents:', fs.readdirSync(iosDir).slice(0, 5));

// Step 2: patch native targets
console.log('[eas-prebuild] Running add-native-targets.js...');
try {
  require('./add-native-targets.js');
  console.log('[eas-prebuild] patch script: SUCCESS');
} catch (err) {
  console.error('[eas-prebuild] patch script FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}

console.log('[eas-prebuild] ===== DONE =====');
