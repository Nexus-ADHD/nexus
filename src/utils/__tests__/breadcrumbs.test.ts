import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn() }));

vi.mock('@sentry/react-native', () => ({
  addBreadcrumb: sentry.addBreadcrumb,
}));

import { addAppBreadcrumb } from '../breadcrumbs';

describe('addAppBreadcrumb', () => {
  beforeEach(() => {
    sentry.addBreadcrumb.mockReset();
  });

  it('forwards category, message, info level, and data to Sentry', () => {
    addAppBreadcrumb('command', 'orb_pressed', { orbState: 'idle' });
    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'command',
      message: 'orb_pressed',
      level: 'info',
      data: { orbState: 'idle' },
    });
  });

  it('omits data when not provided (passes undefined)', () => {
    addAppBreadcrumb('home', 'mounted');
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'home',
      message: 'mounted',
      level: 'info',
      data: undefined,
    });
  });

  it('never throws when Sentry.addBreadcrumb throws', () => {
    sentry.addBreadcrumb.mockImplementation(() => {
      throw new Error('sentry boom');
    });
    expect(() => addAppBreadcrumb('home', 'scrolled')).not.toThrow();
  });
});
