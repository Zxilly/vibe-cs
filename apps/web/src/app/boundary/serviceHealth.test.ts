import { describe, expect, it } from 'vitest';

import type { ApiHealth } from '../../shared/desktop/dto';
import {
  isServiceDegraded,
  serviceActionBlocked,
  serviceErrorMessage,
  servicePollIntervalMs,
  serviceStatusOf,
  shouldRefreshAfterRecovery,
  SERVICE_HEALTH_KEY,
  SERVICE_POLL_OFFLINE_MS,
  SERVICE_POLL_ONLINE_MS,
} from './serviceHealth';

const ok: ApiHealth = { status: 'ok', version: '0.1.0', started_at: '2026-08-15T09:00:00Z' };
const degraded: ApiHealth = { ...ok, status: 'degraded' };

describe('serviceStatusOf', () => {
  it('is checking before the first probe answers', () => {
    expect(serviceStatusOf({ data: undefined, error: null })).toBe('checking');
    expect(serviceStatusOf({ data: undefined, error: undefined })).toBe('checking');
  });

  it('is online once a payload has landed', () => {
    expect(serviceStatusOf({ data: ok, error: null })).toBe('online');
    expect(serviceStatusOf({ data: degraded, error: null })).toBe('online');
  });

  it('is offline when the probe failed', () => {
    expect(serviceStatusOf({ data: undefined, error: new Error('boom') })).toBe('offline');
  });

  it('is offline even while a stale payload is still cached', () => {
    // The §4.1 client keeps the last good data alongside the new error. A
    // payload from before the service went down is not evidence that it is up.
    expect(serviceStatusOf({ data: ok, error: new Error('service not started') })).toBe('offline');
  });
});

describe('isServiceDegraded', () => {
  it('separates degraded from offline', () => {
    expect(isServiceDegraded(degraded)).toBe(true);
    expect(isServiceDegraded(ok)).toBe(false);
    expect(isServiceDegraded(undefined)).toBe(false);
  });

  it('does not disable actions — degraded still answers', () => {
    expect(serviceActionBlocked(serviceStatusOf({ data: degraded, error: null }))).toBe(false);
  });
});

describe('serviceActionBlocked', () => {
  it('blocks offline and checking, allows online', () => {
    expect(serviceActionBlocked('offline')).toBe(true);
    expect(serviceActionBlocked('checking')).toBe(true);
    expect(serviceActionBlocked('online')).toBe(false);
  });
});

describe('servicePollIntervalMs', () => {
  it('probes faster while down, so recovery needs no user action', () => {
    expect(servicePollIntervalMs('online')).toBe(SERVICE_POLL_ONLINE_MS);
    expect(servicePollIntervalMs('offline')).toBe(SERVICE_POLL_OFFLINE_MS);
    expect(servicePollIntervalMs('checking')).toBe(SERVICE_POLL_OFFLINE_MS);
    expect(SERVICE_POLL_OFFLINE_MS).toBeLessThan(SERVICE_POLL_ONLINE_MS);
  });
});

describe('shouldRefreshAfterRecovery', () => {
  it('fires on offline → online', () => {
    expect(shouldRefreshAfterRecovery('offline', 'online')).toBe(true);
  });

  it('does not fire on a cold start', () => {
    expect(shouldRefreshAfterRecovery('checking', 'online')).toBe(false);
  });

  it('does not fire on any other transition', () => {
    expect(shouldRefreshAfterRecovery('online', 'offline')).toBe(false);
    expect(shouldRefreshAfterRecovery('online', 'online')).toBe(false);
    expect(shouldRefreshAfterRecovery('offline', 'checking')).toBe(false);
    expect(shouldRefreshAfterRecovery('checking', 'offline')).toBe(false);
  });
});

describe('serviceErrorMessage', () => {
  it('passes an Error message through', () => {
    expect(serviceErrorMessage(new Error('本地服务未启动'))).toBe('本地服务未启动');
  });

  it('drops anything that is not a readable message', () => {
    expect(serviceErrorMessage(null)).toBeNull();
    expect(serviceErrorMessage(undefined)).toBeNull();
    expect(serviceErrorMessage({ status: 500 })).toBeNull();
    expect(serviceErrorMessage(new Error(''))).toBeNull();
  });
});

describe('SERVICE_HEALTH_KEY', () => {
  it('has its own namespace so recovery can exclude the probe itself', () => {
    expect(SERVICE_HEALTH_KEY[0]).toBe('service');
  });
});
