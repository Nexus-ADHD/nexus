import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Pure-Node unit tests for selector code in src/state/selectors and
// src/utils. No jsdom, no React Native runtime, no Expo native modules.
// If a test file imports anything from app/, components/, features/,
// state/app-state.ts, etc., it will fail loudly at import time — by
// design, so we don't accidentally pull in the RN bundle.
export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" → "./*" path alias so test files and
      // the modules they import resolve identically to the app build.
      '@': path.resolve(__dirname),
    },
  },
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts',
      'tools/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
  },
});
