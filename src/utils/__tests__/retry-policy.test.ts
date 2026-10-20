import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  RETRYABLE_HTTP_STATUSES,
  isRetryableNetworkError,
  retryDelayMs,
} from '../retry-policy';

describe('retryDelayMs', () => {
  it('grows with each attempt', () => {
    const mid = () => 0.5; // no jitter
    expect(retryDelayMs(0, mid)).toBe(300);
    expect(retryDelayMs(1, mid)).toBe(800);
    expect(retryDelayMs(2, mid)).toBe(1800);
  });

  it('repeats the last delay past the end of the table', () => {
    const mid = () => 0.5;
    expect(retryDelayMs(9, mid)).toBe(retryDelayMs(RETRY_BACKOFF_MS.length - 1, mid));
  });

  it('keeps jitter inside +/-20% and never negative', () => {
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      const base = RETRY_BACKOFF_MS[attempt];
      expect(retryDelayMs(attempt, () => 0)).toBeCloseTo(base * 0.8, 5);
      expect(retryDelayMs(attempt, () => 1)).toBeCloseTo(base * 1.2, 5);
      expect(retryDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('RETRYABLE_HTTP_STATUSES', () => {
  it('covers rate limits and transient server errors', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(RETRYABLE_HTTP_STATUSES.has(status)).toBe(true);
    }
  });

  it('excludes 401 so the token-refresh path upstream is not starved', () => {
    expect(RETRYABLE_HTTP_STATUSES.has(401)).toBe(false);
  });

  it('excludes caller errors that would fail identically on a retry', () => {
    for (const status of [400, 403, 404, 422]) {
      expect(RETRYABLE_HTTP_STATUSES.has(status)).toBe(false);
    }
  });
});

describe('isRetryableNetworkError', () => {
  it('retries a thrown network failure', () => {
    expect(isRetryableNetworkError(new TypeError('Network request failed'))).toBe(true);
  });

  it('does NOT retry an abort, which is our own deadline or a cancel', () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    expect(isRetryableNetworkError(abort)).toBe(false);
  });

  it('ignores non-Error throws', () => {
    expect(isRetryableNetworkError('boom')).toBe(false);
    expect(isRetryableNetworkError(undefined)).toBe(false);
  });
});

describe('MAX_RETRY_ATTEMPTS', () => {
  it('is the first try plus two retries', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });
});
