import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { reloadAppAsync } from 'expo';
import * as Sentry from '@sentry/react-native';
import tokens from '@/src/theme/tokens';
import { PrimaryPill } from './ui/PrimaryPill';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>⚠</Text>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.message}>
        {error?.message || 'An unexpected error occurred'}
      </Text>
      <PrimaryPill onPress={onRetry}>RESTART APP</PrimaryPill>
    </View>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    // NEX-269: report render-tree crashes to Sentry (no-op when Sentry was not
    // initialized). The componentStack identifies which subtree threw.
    Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    reloadAppAsync().catch(() => {});
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.voidDeep,
    justifyContent: 'center',
    alignItems: 'center',
    padding: tokens.spacing.xl,
  },
  // FIXME(nex-56): off-scale 48pt fontSize (decorative warning glyph) — design review
  icon: {
    fontSize: 48,
    marginBottom: tokens.spacing.md,
  },
  // FIXME(nex-56): off-scale 20pt fontSize — design review
  title: {
    color: tokens.color.gold,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: tokens.spacing.sm,
  },
  // FIXME(nex-56): off-scale gray #888 + 14pt fontSize — design review
  message: {
    color: tokens.color.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: tokens.spacing.xl,
  },
});
