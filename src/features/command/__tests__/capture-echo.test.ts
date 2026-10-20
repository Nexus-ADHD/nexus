import { describe, expect, it } from 'vitest';
import { shouldShowCaptureEcho, type JustCaptured } from '../capture-echo';

const cap: JustCaptured = { id: 'i1', title: 'Buy milk', surface: 'inbox', at: 1000 };
const active = [{ id: 'i1', completed: false, status: 'UNPROCESSED' }];

describe('shouldShowCaptureEcho (NEX-196 Home echo validity gate)', () => {
  it('shows when the captured item is present and active', () => {
    expect(shouldShowCaptureEcho(cap, active)).toBe(true);
  });

  it('hides when justCaptured is null', () => {
    expect(shouldShowCaptureEcho(null, active)).toBe(false);
  });

  it('hides when the captured id is no longer in the inbox (undo / delete)', () => {
    expect(shouldShowCaptureEcho(cap, [{ id: 'other', completed: false }])).toBe(false);
    expect(shouldShowCaptureEcho(cap, [])).toBe(false);
  });

  it('hides when the captured item was completed', () => {
    expect(shouldShowCaptureEcho(cap, [{ id: 'i1', completed: true, status: 'UNPROCESSED' }])).toBe(false);
  });

  it('hides when the captured item was archived', () => {
    expect(shouldShowCaptureEcho(cap, [{ id: 'i1', completed: false, status: 'ARCHIVED' }])).toBe(false);
  });

  it('hides when inbox is missing / not an array', () => {
    expect(shouldShowCaptureEcho(cap, null)).toBe(false);
    expect(shouldShowCaptureEcho(cap, undefined)).toBe(false);
  });
});
