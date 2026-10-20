#!/bin/bash
# NO set -e — handle errors explicitly for better diagnostics

echo "[eas-prebuild] ===== START ====="
echo "[eas-prebuild] Node: $(node --version 2>/dev/null || echo 'not found')"
echo "[eas-prebuild] NPM: $(npm --version 2>/dev/null || echo 'not found')"
echo "[eas-prebuild] PWD: $(pwd)"
echo "[eas-prebuild] Listing project root:"
ls -la 2>/dev/null | head -20

echo "[eas-prebuild] native-targets:"
ls -la native-targets/ 2>/dev/null || echo "  native-targets/ NOT FOUND"

echo "[eas-prebuild] Running: npx expo prebuild --platform ios --clean"
npx expo prebuild --platform ios --clean
PREBUILD_EXIT=$?
echo "[eas-prebuild] expo prebuild exit code: $PREBUILD_EXIT"

if [ $PREBUILD_EXIT -ne 0 ]; then
  echo "[eas-prebuild] ERROR: expo prebuild failed with exit $PREBUILD_EXIT"
  exit 1
fi

echo "[eas-prebuild] ios/ after prebuild:"
ls -la ios/ 2>/dev/null || echo "  ios/ NOT FOUND"

echo "[eas-prebuild] Running: node scripts/add-native-targets.js"
node scripts/add-native-targets.js
PATCH_EXIT=$?
echo "[eas-prebuild] patch script exit code: $PATCH_EXIT"

if [ $PATCH_EXIT -ne 0 ]; then
  echo "[eas-prebuild] ERROR: add-native-targets.js failed with exit $PATCH_EXIT"
  exit 1
fi

echo "[eas-prebuild] ===== DONE ====="
exit 0
