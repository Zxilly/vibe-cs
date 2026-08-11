import type { AgentResponse } from './protocol.js';

const MAXIMUM_TOOL_CALLS = 32;
const MAXIMUM_TOOL_VALUE_BYTES = 8 * 1024;
const MAXIMUM_TOOL_TRANSPORT_BYTES = 96 * 1024;

type ToolResult = {
  payload: {
    toolName?: string;
    args?: unknown;
    output?: unknown;
  };
};

function byteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function objectSummary(value: unknown, originalBytes: number | null): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { summarized: true, originalBytes, valueType: Array.isArray(value) ? 'array' : typeof value };
  }
  const source = value as Record<string, unknown>;
  const collectionCounts = Object.fromEntries(Object.entries(source)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .slice(0, 16)
    .map(([key, items]) => [key.slice(0, 64), items.length]));
  return {
    summarized: true,
    originalBytes,
    ...(typeof source.available === 'boolean' ? { available: source.available } : {}),
    ...(typeof source.accepted === 'boolean' ? { accepted: source.accepted } : {}),
    collectionCounts,
  };
}

function boundedValue(value: unknown): unknown {
  const size = byteLength(value);
  return size !== null && size <= MAXIMUM_TOOL_VALUE_BYTES ? value : objectSummary(value, size);
}

export function compactToolResults(results: readonly ToolResult[]): AgentResponse['toolCalls'] {
  let usedBytes = 0;
  return results.slice(0, MAXIMUM_TOOL_CALLS).map((entry) => {
    const base = {
      name: entry.payload.toolName?.slice(0, 128) || 'unknown_tool',
      input: boundedValue(entry.payload.args ?? null),
      output: boundedValue(entry.payload.output ?? null),
    };
    let size = byteLength(base) ?? MAXIMUM_TOOL_TRANSPORT_BYTES + 1;
    if (usedBytes + size > MAXIMUM_TOOL_TRANSPORT_BYTES) {
      base.input = { summarized: true };
      base.output = { summarized: true };
      size = byteLength(base) ?? 0;
    }
    usedBytes += size;
    return base;
  });
}
