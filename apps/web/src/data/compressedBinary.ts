import { t } from '@lingui/core/macro';

export const MAXIMUM_BINARY_BYTES = 128 * 1024 * 1024;
const checksumTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ checksumTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}

/** Shared bounded zlib/CRC envelope for ARPL and VMAP. */
export async function inflateVerified(bytes: Uint8Array<ArrayBuffer>, length: number, checksum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_BINARY_BYTES) throw new Error(t`二进制数据超过大小限制。`);
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const reader = stream.pipeThrough(new DecompressionStream('deflate')).getReader();
  const output = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.length > length) { await reader.cancel(); throw new Error('Inflated size exceeds its bound'); }
      output.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } catch {
    throw new Error(t`二进制数据解压失败，请重试。`);
  } finally {
    reader.releaseLock();
  }
  if (offset !== length || crc32(output) !== checksum) throw new Error(t`二进制数据不完整或校验失败，请重试。`);
  return output;
}
