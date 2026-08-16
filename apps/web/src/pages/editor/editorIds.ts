/*
 * pages/editor — minting wire identities.
 *
 * Every id in an `EditorProject` is a uuid and the service parses them, so an
 * id this page invents has to be *shaped* like one — unlike `data/sessions.ts`,
 * whose request ids are opaque strings and whose fallback is therefore free to
 * be `agent-<timestamp>-<random>`. A clip called `clip-3` would be rejected at
 * the save with a message about a malformed request, several edits after the
 * one that produced it.
 *
 * `crypto.randomUUID` is the answer wherever it exists, which in practice is
 * everywhere this app runs — it needs a secure context, and the desktop shell
 * serves over `tauri://` / `https://`. The two fallbacks below exist for the
 * test environments and for nothing else, and they are ordered by how much
 * entropy they actually have: `getRandomValues` is a real CSPRNG, `Math.random`
 * is not and is the last resort.
 *
 * `mintUuid` is passed *into* `toEditorProject` rather than called by it, so
 * the adapter stays a pure function that a test can drive with a counter.
 */

/** A v4 uuid. */
export function mintUuid(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (typeof getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  // Version 4, variant 1 — the two bit patterns that make the string a
  // *well-formed* v4 rather than 32 random hex digits, which is what
  // `Uuid::parse_str` on the other side checks.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
