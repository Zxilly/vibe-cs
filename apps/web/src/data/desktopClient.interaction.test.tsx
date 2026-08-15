/**
 * `interaction` project — the injectable bridge.
 *
 * The seam itself is what makes every other test in this layer possible, so it
 * gets its own assertions: the provider wins inside its subtree, nesting works
 * (a page-level fake can be narrowed for one panel), and the default outside
 * any provider is the real `commands` object — checked by identity, never
 * called, because there is no Tauri host here.
 */

import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { commands } from '../shared/desktop/client';
import { DesktopClientProvider, useDesktopClient, type DesktopClient } from './desktopClient';

function fake(label: string): Partial<DesktopClient> {
  return { health: () => Promise.reject(new Error(label)) };
}

describe('useDesktopClient', () => {
  it('defaults to the real desktop client when no provider is mounted', () => {
    const { result } = renderHook(() => useDesktopClient());
    // Identity, not a call: invoking it would need a Tauri host.
    expect(result.current).toBe(commands);
  });

  it('returns the injected client inside a provider', () => {
    const injected = fake('injected') as DesktopClient;
    const { result } = renderHook(() => useDesktopClient(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DesktopClientProvider client={injected}>{children}</DesktopClientProvider>
      ),
    });

    expect(result.current).toBe(injected);
    expect(result.current).not.toBe(commands);
  });

  it('lets an inner provider narrow the client for one subtree', () => {
    const outer = fake('outer') as DesktopClient;
    const inner = fake('inner') as DesktopClient;

    const { result } = renderHook(() => useDesktopClient(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DesktopClientProvider client={outer}>
          <DesktopClientProvider client={inner}>{children}</DesktopClientProvider>
        </DesktopClientProvider>
      ),
    });

    expect(result.current).toBe(inner);
  });
});
