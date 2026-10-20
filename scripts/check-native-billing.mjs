#!/usr/bin/env node
// Native App Store billing guard (NEX-233).
//
// Why this exists: a trust-destroying pattern called out in competitor App Store
// review mining — "the app redirects you to enter payment on their website, so
// the renewal never shows under your App Store subscriptions." Nexus's rule is
// that the paid `Nexus Pro` entitlement is granted ONLY through native App Store
// IAP via RevenueCat/StoreKit (`react-native-purchases`), never an off-store web
// payment flow. This script is the ratchet that keeps a future PR from quietly
// introducing one. Standing rule + rationale: docs/automation/native-billing-policy.md.
//
// What it checks (whole-repo, like the @ts-nocheck ratchet — a standing
// invariant, not diff-scoped lint):
//   - dependency           : a third-party payment SDK in package.json deps.
//   - import               : an import/require of a third-party payment SDK.
//   - checkoutHost         : a hard-coded URL literal pointing at a payment
//                            vendor's checkout host (Apple hosts are allowlisted).
//   - purchaseCallOutsideService : a raw `Purchases.purchasePackage` /
//                            `purchaseStoreProduct` / `restorePurchases` /
//                            `purchaseProduct` call anywhere other than the one
//                            sanctioned wrapper (src/services/revenuecat.ts).
//                            This is the load-bearing POSITIVE invariant: the
//                            entitlement can only be unlocked through that file,
//                            so a stray web redirect cannot grant Pro.
//
// Documented residual gap (by design — see the policy doc): a fully DYNAMIC
// redirect (`Linking.openURL(remoteConfigUrl)`, or a host assembled by string
// concatenation) is not statically detectable, and this repo legitimately opens
// dynamic URLs (arbitrary calendar `event.url`). That gap is covered by the
// RevenueCat-only entitlement invariant above + code review + Apple review, not
// by this grep. We deliberately do NOT allowlist every openURL call-site.
//
// Run: `node scripts/check-native-billing.mjs` (invoked directly in CI's `lint`
// job; no npm-script wrapper). Pure exports below are unit-tested in
// scripts/__tests__/check-native-billing.test.ts (vitest, pure-Node).

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Policy constants ──────────────────────────────────────────────────────────

// Payment-vendor name tokens. Matched as whole package-name SEGMENTS (split on
// /, @, -, .) — never as free-text substrings — so `square` flags
// `react-native-square` but NOT `squarespace`, and `stripe` never trips on
// `striped`/`payload`/a prose comment. Curated, not exhaustive: a new vendor is
// a one-line add in a reviewable PR.
export const PAYMENT_VENDOR_TOKENS = [
  'stripe',
  'braintree',
  'paddle',
  'lemonsqueezy',
  'razorpay',
  'recurly',
  'chargebee',
  'paypal',
  'adyen',
  'mollie',
  'square',
];

// Payment-vendor checkout hosts. A URL literal is flagged when its hostname
// equals or is a subdomain of one of these (hostname-boundary match, not
// substring). Apple hosts are never on this list.
export const PAYMENT_VENDOR_HOSTS = [
  'stripe.com',
  'paddle.com',
  'lemonsqueezy.com',
  'paypal.com',
  'paypal.me', // PayPal.Me payment links
  'braintreegateway.com',
  'razorpay.com',
  'rzp.io', // Razorpay payment-link shortener
  'recurly.com',
  'chargebee.com',
  'adyen.com',
  'mollie.com',
  'squareup.com',
  'square.com', // Square checkout is also reachable from square.com
  'square.link', // Square payment-link shortener
];

// External hosts/schemes that ARE allowed for billing-adjacent links: Apple's
// native subscription management + the App Store listing, and mailto:. Baked in
// (and asserted by a test) so the compliant baseline provably stays green.
export const ALLOWED_BILLING_HOSTS = ['apps.apple.com', 'apple.com'];

// The single file allowed to invoke raw StoreKit/RevenueCat purchase + restore
// APIs. Everything else must go through this wrapper's exported functions.
export const PURCHASE_SERVICE_PATH = 'src/services/revenuecat.ts';

// Directories scanned (app code + edge functions). The CLI lists these dirs with
// `git ls-files` and filters by isScannedSourcePath, rather than relying on
// `git ls-files 'app/**/*.tsx'` — git's `**/` pathspec requires an intermediate
// directory and so SKIPS direct children like app/_layout.tsx.
export const SCANNED_DIRS = ['src/', 'app/', 'supabase/functions/'];

// Whether a git-tracked path is in scope for the billing scan. Excludes the
// guard's own script + test and any markdown (so the policy doc can name vendors
// without self-tripping), and .nexus-backups/** (tracked frozen source snapshots).
export function isScannedSourcePath(p) {
  if (!p) return false;
  if (p === 'scripts/check-native-billing.mjs') return false;
  if (p === 'scripts/__tests__/check-native-billing.test.ts') return false;
  if (p.startsWith('.nexus-backups/')) return false;
  if (!/\.(ts|tsx|js|jsx)$/.test(p)) return false;
  return SCANNED_DIRS.some((d) => p.startsWith(d));
}

// Raw native purchase/restore APIs that may appear ONLY in PURCHASE_SERVICE_PATH.
const PURCHASE_CALL_RE =
  /\bPurchases\s*\.\s*(purchasePackage|purchaseStoreProduct|purchaseProduct|restorePurchases)\b/g;

// ─── Pure detection helpers ────────────────────────────────────────────────────

// Split a package specifier into name segments and test against the vendor token
// set. Handles bare (`stripe`, `react-native-stripe`), scoped
// (`@stripe/stripe-react-native`), and subpath (`@stripe/x/y`) specifiers.
export function isPaymentVendorPackage(specifier, tokens = PAYMENT_VENDOR_TOKENS) {
  if (!specifier) return null;
  // Local (non-package) specifiers must never be treated as packages, else a
  // common-word vendor token like `square`/`paddle` would falsely flag an
  // innocuous path. Covers relative (./foo, ../foo), absolute (/foo), and this
  // repo's `@/* -> ./*` alias (@/components/square-grid). A real scoped package
  // is `@scope/name` with a non-empty scope (e.g. @stripe/…), so only `@/` is
  // excluded, not `@`.
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) {
    return null;
  }
  const denied = new Set(tokens);
  const segments = specifier.toLowerCase().split(/[/@.\-]+/).filter(Boolean);
  for (const seg of segments) {
    if (denied.has(seg)) return seg;
  }
  return null;
}

// Return the matched vendor host (or null) for a URL string, honoring the Apple
// allowlist. Hostname-boundary match: `checkout.stripe.com` and `stripe.com`
// match `stripe.com`; `notstripe.com` does NOT.
export function matchedVendorHost(
  urlString,
  hosts = PAYMENT_VENDOR_HOSTS,
  allowed = ALLOWED_BILLING_HOSTS,
) {
  let hostname;
  try {
    hostname = new URL(urlString).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname) return null;
  const isHost = (h, base) => h === base || h.endsWith('.' + base);
  if (allowed.some((a) => isHost(hostname, a))) return null;
  for (const base of hosts) {
    if (isHost(hostname, base)) return base;
  }
  return null;
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

// Extract import/require specifiers and http(s) URL literals from a source file.
// Covers four specifier forms: `… from '<x>'`, `require('<x>')`, dynamic
// `import('<x>')`, and side-effect `import '<x>'`. (Truly computed specifiers —
// `require(varName)` — are a documented residual gap; the dependency +
// purchase-call invariants are the backstop.)
const IMPORT_RE =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const URL_RE = /https?:\/\/[^\s'"`)\]]+/g;

// Core: given the scanned source files and the parsed package.json, return all
// violations. `sourceFiles` is [{ path, content }] already filtered to scanned
// paths (callers exclude markdown, this guard + its test, and .nexus-backups).
export function findBillingViolations({ sourceFiles = [], packageJson = {} } = {}) {
  const violations = [];

  // 1. Dependency keys.
  const depGroups = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const group of depGroups) {
    const deps = packageJson[group];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      const token = isPaymentVendorPackage(name);
      if (token) {
        violations.push({
          path: 'package.json',
          line: null,
          category: 'dependency',
          token: `${name} (matched vendor "${token}")`,
        });
      }
    }
  }

  // 2–4. Per source file.
  for (const { path, content } of sourceFiles) {
    if (typeof content !== 'string') continue;
    const isService = path === PURCHASE_SERVICE_PATH;

    // 2. Imports / requires of a payment SDK.
    for (const m of content.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      const token = isPaymentVendorPackage(spec);
      if (token) {
        violations.push({
          path,
          line: lineOf(content, m.index),
          category: 'import',
          token: `${spec} (matched vendor "${token}")`,
        });
      }
    }

    // 3. Hard-coded payment-vendor checkout hosts.
    for (const m of content.matchAll(URL_RE)) {
      const host = matchedVendorHost(m[0]);
      if (host) {
        violations.push({
          path,
          line: lineOf(content, m.index),
          category: 'checkoutHost',
          token: `${m[0]} (host ${host})`,
        });
      }
    }

    // 4. Raw native purchase/restore calls outside the sanctioned service.
    if (!isService) {
      for (const m of content.matchAll(PURCHASE_CALL_RE)) {
        violations.push({
          path,
          line: lineOf(content, m.index),
          category: 'purchaseCallOutsideService',
          token: `Purchases.${m[1]} — only allowed in ${PURCHASE_SERVICE_PATH}`,
        });
      }
    }
  }

  return violations;
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

const POLICY_DOC = 'docs/automation/native-billing-policy.md';

function gitTrackedSourceFiles(repoRoot) {
  // Whole-repo scan (git-tracked only). List the scanned dirs by directory
  // pathspec — which recurses to ALL depths including direct children — then
  // filter by isScannedSourcePath. (Directory pathspecs avoid git's `**/`
  // intermediate-dir requirement that would skip app/_layout.tsx & siblings.)
  const out = execSync('git ls-files src app supabase/functions', {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isScannedSourcePath);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const paths = gitTrackedSourceFiles(repoRoot);
  const sourceFiles = paths.map((p) => {
    let content = '';
    try {
      content = readFileSync(resolve(repoRoot, p), 'utf8');
    } catch {
      content = '';
    }
    return { path: p, content };
  });

  let packageJson = {};
  try {
    packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  } catch {
    packageJson = {};
  }

  const violations = findBillingViolations({ sourceFiles, packageJson });

  if (violations.length) {
    console.error(
      `\n[native-billing guard] FAIL: ${violations.length} off-store-billing violation(s):`,
    );
    for (const v of violations) {
      const loc = v.line == null ? v.path : `${v.path}:${v.line}`;
      console.error(`  + [${v.category}] ${loc} — ${v.token}`);
    }
    console.error(
      `\nNexus bills ONLY through native App Store IAP (RevenueCat/StoreKit). No off-store`,
    );
    console.error(
      `web payment, no third-party payment SDK. Route paid purchases through ${PURCHASE_SERVICE_PATH}.`,
    );
    console.error(`Standing rule: ${POLICY_DOC} (NEX-233).`);
    process.exit(1);
  }

  console.log(
    `[native-billing guard] OK — scanned ${sourceFiles.length} source file(s); billing is native-only.`,
  );
}

// Only run main() as a CLI; importing for tests must not execute it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
