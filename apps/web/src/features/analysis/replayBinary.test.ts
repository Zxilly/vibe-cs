import { describe, expect, it } from 'vitest';

import { decodeReplayBinary } from './replayBinary';

describe('binary replay decoder', () => {
  it('rejects unknown or truncated payloads', () => {
    expect(() => decodeReplayBinary(new Uint8Array([1, 2, 3]).buffer)).toThrow();
    expect(() => decodeReplayBinary(new TextEncoder().encode('ARPL\x01').buffer)).toThrow();
  });
});
