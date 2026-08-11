import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { agentRequestSchema, isAllowedProviderBaseUrl } from './protocol.js';

describe('provider URL policy', () => {
  it('allows HTTPS remotes and loopback HTTP only', () => {
    expect(isAllowedProviderBaseUrl('https://api.kimi.com/coding/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('http://example.com/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('https://user:secret@example.com/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('https://example.com/v1?key=secret')).toBe(false);
    expect(isAllowedProviderBaseUrl('https://example.com/v1#fragment')).toBe(false);
  });

  it('accepts the exact Rust-to-sidecar smoke fixture and rejects removed capabilities', () => {
    const fixture = JSON.parse(readFileSync(new URL('../test/smoke-request.json', import.meta.url), 'utf8')) as unknown;
    expect(agentRequestSchema.safeParse(fixture).success).toBe(true);
    const withRemovedCapability = structuredClone(fixture) as { context: Record<string, unknown> };
    withRemovedCapability.context.removedCapability = { available: true };
    expect(agentRequestSchema.safeParse(withRemovedCapability).success).toBe(false);
  });
});
