import { describe, it, expect } from 'vitest';
// Pure exports only — no git/fs I/O, no RN imports (vitest is pure-Node here).
import {
  findBillingViolations,
  isPaymentVendorPackage,
  matchedVendorHost,
  isScannedSourcePath,
  ALLOWED_BILLING_HOSTS,
  PURCHASE_SERVICE_PATH,
} from '../check-native-billing.mjs';

describe('isPaymentVendorPackage (segment-exact, not substring)', () => {
  it('flags bare, scoped, subpath, and react-native-prefixed payment SDKs', () => {
    expect(isPaymentVendorPackage('stripe')).toBe('stripe');
    expect(isPaymentVendorPackage('@stripe/stripe-react-native')).toBe('stripe');
    expect(isPaymentVendorPackage('@stripe/stripe-react-native/dist/x')).toBe('stripe');
    expect(isPaymentVendorPackage('react-native-braintree')).toBe('braintree');
    expect(isPaymentVendorPackage('react-native-square-reader')).toBe('square');
  });

  it('does NOT flag lookalikes that merely contain a vendor as a substring', () => {
    expect(isPaymentVendorPackage('squarespace')).toBeNull(); // contains "square" but is one segment
    expect(isPaymentVendorPackage('payload')).toBeNull();
    expect(isPaymentVendorPackage('react-native-purchases')).toBeNull(); // the SANCTIONED SDK
    expect(isPaymentVendorPackage('react-native-purchases-ui')).toBeNull(); // NEX-119: RC Paywall UI, allowed (renders the template; purchase still routes through revenuecat.ts)
    expect(isPaymentVendorPackage('@react-native-async-storage/async-storage')).toBeNull();
    expect(isPaymentVendorPackage('')).toBeNull();
    expect(isPaymentVendorPackage(undefined)).toBeNull();
  });

  it('does NOT treat local (non-package) specifiers as packages', () => {
    // Relative / absolute paths, and the repo's `@/* -> ./*` alias, are local
    // modules — a common-word vendor token must not fire on them.
    expect(isPaymentVendorPackage('./square-icon')).toBeNull();
    expect(isPaymentVendorPackage('../paddle-config')).toBeNull();
    expect(isPaymentVendorPackage('/abs/square-thing')).toBeNull();
    expect(isPaymentVendorPackage('@/src/components/square-grid')).toBeNull();
    expect(isPaymentVendorPackage('@/hooks/use-paddle-board')).toBeNull();
    // …but a real scoped vendor package (non-empty scope) is still flagged.
    expect(isPaymentVendorPackage('@stripe/stripe-react-native')).toBe('stripe');
  });
});

describe('matchedVendorHost (hostname-boundary, Apple allowlisted)', () => {
  it('matches a vendor checkout host and its subdomains', () => {
    expect(matchedVendorHost('https://checkout.stripe.com/pay/cs_test_123')).toBe('stripe.com');
    expect(matchedVendorHost('https://buy.stripe.com/abc')).toBe('stripe.com');
    expect(matchedVendorHost('https://www.paypal.com/checkout')).toBe('paypal.com');
  });

  it('catches payment-link / alternate-domain hosts (not just the API host)', () => {
    // Square's checkout/payment-links live on square.com & square.link, not only squareup.com.
    expect(matchedVendorHost('https://square.com/checkout/abc')).toBe('square.com');
    expect(matchedVendorHost('https://square.link/u/xyz')).toBe('square.link');
    expect(matchedVendorHost('https://paypal.me/someuser')).toBe('paypal.me');
    expect(matchedVendorHost('https://rzp.io/i/abc')).toBe('rzp.io');
  });

  it('never flags the allowed Apple hosts or non-vendor hosts', () => {
    expect(matchedVendorHost('https://apps.apple.com/account/subscriptions')).toBeNull();
    expect(matchedVendorHost('https://apps.apple.com/app/id6761865566')).toBeNull();
    expect(matchedVendorHost('https://example.com/foo')).toBeNull();
    // boundary safety: a host that merely ends with the vendor string but not on a label boundary
    expect(matchedVendorHost('https://notstripe.com/x')).toBeNull();
    expect(matchedVendorHost('not a url')).toBeNull();
  });

  it('keeps the Apple allowlist in sync', () => {
    expect(ALLOWED_BILLING_HOSTS).toContain('apps.apple.com');
  });
});

describe('isScannedSourcePath (scan scope — guards the app/_layout.tsx coverage hole)', () => {
  it('includes direct children of scanned dirs (the glob-depth bug)', () => {
    expect(isScannedSourcePath('app/_layout.tsx')).toBe(true);
    expect(isScannedSourcePath('app/index.tsx')).toBe(true);
    expect(isScannedSourcePath('src/services/revenuecat.ts')).toBe(true);
    expect(isScannedSourcePath('app/(tabs)/orbit.tsx')).toBe(true);
    expect(isScannedSourcePath('supabase/functions/ai-proxy/index.ts')).toBe(true);
  });

  it('excludes out-of-scope dirs, markdown, the guard + its own test, and backups', () => {
    expect(isScannedSourcePath('scripts/check-native-billing.mjs')).toBe(false);
    expect(isScannedSourcePath('scripts/__tests__/check-native-billing.test.ts')).toBe(false);
    expect(isScannedSourcePath('docs/automation/native-billing-policy.md')).toBe(false);
    expect(isScannedSourcePath('src/x.md')).toBe(false);
    expect(isScannedSourcePath('.nexus-backups/src/services/revenuecat.ts')).toBe(false);
    expect(isScannedSourcePath('CLAUDE.md')).toBe(false);
    expect(isScannedSourcePath('')).toBe(false);
  });
});

describe('findBillingViolations', () => {
  it('passes a clean, compliant codebase (the baseline)', () => {
    const v = findBillingViolations({
      sourceFiles: [
        // The sanctioned wrapper may use raw Purchases.* APIs.
        {
          path: PURCHASE_SERVICE_PATH,
          content:
            "import Purchases from 'react-native-purchases';\n" +
            'const { customerInfo } = await Purchases.purchasePackage(pkg);\n' +
            'await Purchases.restorePurchases();\n',
        },
        // Paywall calls the LOCAL exported wrapper, not raw Purchases.*.
        {
          path: 'src/features/paywall/paywall-screen.tsx',
          content:
            "import { purchasePackage, restorePurchases } from '../../services/revenuecat';\n" +
            'const result = await purchasePackage(pkg);\n',
        },
        // Benign dynamic + Apple + mailto URL sinks (the documented allowed set).
        {
          path: 'app/(tabs)/orbit.tsx',
          content:
            'Linking.openURL(event.url);\n' +
            "Linking.openURL('https://apps.apple.com/account/subscriptions');\n" +
            "Linking.openURL('mailto:admin@thecircleoflight.net');\n",
        },
        // Settings reads the app-user id — NOT a purchase/restore call.
        {
          path: 'src/features/settings/settings-screen.tsx',
          content: 'const id = await Purchases.getAppUserID();\n',
        },
        // The word "payment" in prose must not trip the guard.
        { path: 'src/x.ts', content: '// handle the payment confirmation copy here\n' },
      ],
      packageJson: {
        dependencies: { 'react-native-purchases': '^8.0.0', expo: '^54.0.0' },
        devDependencies: { vitest: '^2.0.0' },
      },
    });
    expect(v).toEqual([]);
  });

  it('flags a third-party payment SDK dependency', () => {
    const v = findBillingViolations({
      sourceFiles: [],
      packageJson: { dependencies: { '@stripe/stripe-react-native': '^0.37.0' } },
    });
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('dependency');
    expect(v[0].path).toBe('package.json');
  });

  it('flags an import of a payment SDK', () => {
    const v = findBillingViolations({
      sourceFiles: [
        {
          path: 'src/features/paywall/paywall-screen.tsx',
          content: "import { confirmPayment } from '@stripe/stripe-react-native';\n",
        },
      ],
      packageJson: {},
    });
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('import');
    expect(v[0].line).toBe(1);
  });

  it('flags a require() of a payment SDK', () => {
    const v = findBillingViolations({
      sourceFiles: [{ path: 'src/x.ts', content: "const s = require('stripe');\n" }],
      packageJson: {},
    });
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('import');
  });

  it('does NOT flag local imports whose path contains a vendor word', () => {
    const v = findBillingViolations({
      sourceFiles: [
        {
          path: 'src/components/square-grid.tsx',
          content:
            "import { Grid } from './square-icon';\n" +
            "import cfg from '../paddle-config';\n" +
            "import { X } from '@/src/components/square-grid';\n",
        },
      ],
      packageJson: {},
    });
    expect(v).toEqual([]);
  });

  it('flags dynamic import() and side-effect import of a payment SDK', () => {
    const dyn = findBillingViolations({
      sourceFiles: [{ path: 'src/x.ts', content: "const s = await import('stripe');\n" }],
      packageJson: {},
    });
    expect(dyn).toHaveLength(1);
    expect(dyn[0].category).toBe('import');

    const sideEffect = findBillingViolations({
      sourceFiles: [{ path: 'src/x.ts', content: "import '@paddle/paddle-js';\n" }],
      packageJson: {},
    });
    expect(sideEffect).toHaveLength(1);
    expect(sideEffect[0].category).toBe('import');
  });

  it('flags a hard-coded vendor checkout URL literal', () => {
    const v = findBillingViolations({
      sourceFiles: [
        {
          path: 'src/x.ts',
          content: "WebBrowser.openBrowserAsync('https://checkout.stripe.com/pay/cs_123');\n",
        },
      ],
      packageJson: {},
    });
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('checkoutHost');
  });

  it('flags raw Purchases.purchasePackage OUTSIDE the sanctioned service', () => {
    const v = findBillingViolations({
      sourceFiles: [
        {
          path: 'src/features/paywall/paywall-screen.tsx',
          content: 'await Purchases.purchasePackage(pkg);\n',
        },
      ],
      packageJson: {},
    });
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('purchaseCallOutsideService');
  });

  it('does NOT flag raw Purchases.* inside the sanctioned service', () => {
    const v = findBillingViolations({
      sourceFiles: [
        {
          path: PURCHASE_SERVICE_PATH,
          content:
            'await Purchases.purchaseStoreProduct(p);\nawait Purchases.restorePurchases();\n',
        },
      ],
      packageJson: {},
    });
    expect(v).toEqual([]);
  });

  it('reports multiple violations across categories together', () => {
    const v = findBillingViolations({
      sourceFiles: [
        {
          path: 'src/x.ts',
          content:
            "import s from 'stripe';\n" +
            "const u = 'https://buy.stripe.com/x';\n" +
            'await Purchases.purchaseProduct(p);\n',
        },
      ],
      packageJson: { dependencies: { paddle: '^1.0.0' } },
    });
    const cats = v.map((x) => x.category).sort();
    expect(cats).toEqual(['checkoutHost', 'dependency', 'import', 'purchaseCallOutsideService']);
  });
});
