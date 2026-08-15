/**
 * `unit` project — the health probe.
 *
 * `vi.mock` rather than the `DesktopClientProvider` seam, because this is the
 * one call in the layer that deliberately does *not* go through the seam:
 * `ServiceGate` uses it as a default prop value, outside any React context.
 * There is no Tauri host under vitest, so the bridge is replaced wholesale and
 * the assertion is about delegation, not about the wire.
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { ApiHealth } from '../shared/desktop/dto';

const bridge = vi.hoisted(() => ({ health: vi.fn() }));

vi.mock('../shared/desktop/client', () => ({ commands: { health: bridge.health } }));

const { invalidateServiceHealth, probeServiceHealth, serviceHealthKey } = await import('./health');

const HEALTH: ApiHealth = { status: 'ok', version: '0.1.0', started_at: '2026-08-15T09:00:00Z' };

describe('probeServiceHealth', () => {
  it('delegates to the desktop command and returns its answer', async () => {
    bridge.health.mockResolvedValueOnce(HEALTH);
    await expect(probeServiceHealth()).resolves.toEqual(HEALTH);
  });

  it('forwards the abort signal, so an unmounting gate cancels its probe', async () => {
    bridge.health.mockResolvedValueOnce(HEALTH);
    const controller = new AbortController();
    await probeServiceHealth(controller.signal);
    expect(bridge.health).toHaveBeenLastCalledWith(controller.signal);
  });

  it('lets the bridge’s rejection through untouched', async () => {
    const failure = new Error('本地服务未启动');
    bridge.health.mockRejectedValueOnce(failure);
    await expect(probeServiceHealth()).rejects.toBe(failure);
  });
});

describe('serviceHealthKey / invalidateServiceHealth', () => {
  it('is the key the shell probes on', () => {
    expect(serviceHealthKey()).toEqual(['service', 'health']);
  });

  it('invalidates the probe and leaves the rest of the cache alone', async () => {
    const client = new QueryClient();
    client.setQueryData(serviceHealthKey(), HEALTH);
    client.setQueryData(['demos', 'list', {}], { items: [] });

    await invalidateServiceHealth(client);

    expect(client.getQueryState(serviceHealthKey())?.isInvalidated).toBe(true);
    expect(client.getQueryState(['demos', 'list', {}])?.isInvalidated).toBe(false);
    client.clear();
  });
});
