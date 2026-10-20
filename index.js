// index.js — custom app entry (NEX-269).
//
// Initializes Sentry as a side effect BEFORE the Expo Router entry registers
// the root component, so Sentry's JS error handler is installed before app
// modules (app/_layout.tsx and its imports) evaluate. Order matters: the
// sentry-init import must come first.
//
// `package.json` "main" points here instead of "expo-router/entry".
import './src/sentry-init';
import 'expo-router/entry';
