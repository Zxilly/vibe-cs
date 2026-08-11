import { describe, expect, it } from 'vitest';

import { compactToolResults } from './transport.js';

describe('agent tool result transport', () => {
  it('keeps repeated large local evidence out of the complete frame', () => {
    const secretEvidence = 'round-evidence'.repeat(160_000);
    const results = Array.from({ length: 32 }, (_, index) => ({
      payload: {
        toolName: `read_local_evidence_${index}`,
        args: { roundNumbers: [index] },
        output: { available: true, rounds: [{ evidenceId: `round:${index}`, source: secretEvidence }] },
      },
    }));

    const compacted = compactToolResults(results);
    const encoded = JSON.stringify(compacted);
    expect(compacted).toHaveLength(32);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(128 * 1024);
    expect(encoded).not.toContain(secretEvidence.slice(0, 1_000));
    expect(compacted[0]?.output).toMatchObject({ summarized: true, available: true });
  });

  it('preserves a small verified tool result', () => {
    const compacted = compactToolResults([{
      payload: { toolName: 'search_rounds', args: { roundNumbers: [7] }, output: { available: true, rounds: [{ evidenceId: 'round:7' }] } },
    }]);
    expect(compacted[0]).toMatchObject({
      name: 'search_rounds',
      output: { available: true, rounds: [{ evidenceId: 'round:7' }] },
    });
  });
});
