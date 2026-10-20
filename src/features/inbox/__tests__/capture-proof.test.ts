import { describe, it, expect } from 'vitest';
import { captureProofLine } from '../capture-proof';

const NOW = Date.UTC(2026, 5, 20, 12, 0, 0); // fixed reference instant
const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe('captureProofLine — gating', () => {
  it('returns null for apple_reminders source regardless of createdAt', () => {
    expect(captureProofLine({ source: 'apple_reminders', createdAt: NOW - 5 * M }, NOW)).toBeNull();
    expect(captureProofLine({ source: 'apple_reminders' }, NOW)).toBeNull();
  });

  it('returns null when createdAt is missing, 0 sentinel, or non-finite', () => {
    expect(captureProofLine({ source: 'manual' }, NOW)).toBeNull();
    expect(captureProofLine({ source: 'manual', createdAt: 0 }, NOW)).toBeNull();
    expect(captureProofLine({ source: 'manual', createdAt: NaN }, NOW)).toBeNull();
    expect(captureProofLine({ source: 'manual', createdAt: Infinity }, NOW)).toBeNull();
    expect(captureProofLine({ source: 'manual', createdAt: -5 }, NOW)).toBeNull();
  });

  it('treats undefined source as manual (default capture)', () => {
    expect(captureProofLine({ createdAt: NOW - 5 * M }, NOW)).toBe('Captured 5m ago');
  });
});

describe('captureProofLine — relative buckets', () => {
  it('a future timestamp (clock skew) clamps to just now', () => {
    expect(captureProofLine({ source: 'manual', createdAt: NOW + 10 * M }, NOW)).toBe('Captured just now');
  });

  it('the whole first minute reads "just now" (no "0m ago")', () => {
    expect(captureProofLine({ source: 'manual', createdAt: NOW }, NOW)).toBe('Captured just now');
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 29 * S }, NOW)).toBe('Captured just now');
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 59 * S }, NOW)).toBe('Captured just now');
  });

  it('minutes bucket', () => {
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 60 * S }, NOW)).toBe('Captured 1m ago');
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 59 * M }, NOW)).toBe('Captured 59m ago');
  });

  it('hours bucket', () => {
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 60 * M }, NOW)).toBe('Captured 1h ago');
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 23 * H }, NOW)).toBe('Captured 23h ago');
  });

  it('yesterday bucket (24h–48h)', () => {
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 24 * H }, NOW)).toBe('Captured yesterday');
    expect(captureProofLine({ source: 'manual', createdAt: NOW - 47 * H }, NOW)).toBe('Captured yesterday');
  });

  it('past 48h falls back to an absolute date (no count-of-absence)', () => {
    const out = captureProofLine({ source: 'manual', createdAt: NOW - 5 * D }, NOW);
    expect(out).toMatch(/^Captured /);
    expect(out).not.toMatch(/ago|yesterday|just now/);
  });
});
