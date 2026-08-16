/**
 * Reading the free-form bags the wire carries.
 *
 * A Rust `serde_json::Value` field generates as `JsonValue`, a recursive union
 * that includes `null`, an array and the four scalars. It is strictly narrower
 * than the `unknown` the hand-written mirror used, but it still has to be
 * narrowed before a member can be read — `attributes['position']` is not a
 * legal index on a `string`.
 *
 * These two helpers are the one place that narrowing happens, so no call site
 * reaches for a cast.
 */

import type { JsonValue } from './dto';

/** The value as a JSON object, or `null` when it is anything else. */
export function jsonObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

/** One member of a JSON object, or `undefined` when there is no object. */
export function jsonMember(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const object = jsonObject(value);
  return object === null ? undefined : object[key];
}
