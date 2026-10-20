// NEX-269: getSentryExpoConfig wraps Expo's default Metro config and injects
// Sentry's serializer so JS bundles + Hermes source maps carry Debug IDs
// (required for release symbolication). Drop-in replacement for getDefaultConfig.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

// annotateReactComponents: a babel transformer tags frames/events with the React
// component name, so an App Hang / crash points at a component (helps triage a
// hang to a surface). Build-time only; requires a clean Metro cache.
const config = getSentryExpoConfig(__dirname, { annotateReactComponents: true });
config.resolver.assetExts.push('riv');

module.exports = config;
