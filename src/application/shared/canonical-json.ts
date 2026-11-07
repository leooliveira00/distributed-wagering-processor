import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` members omitted, no whitespace.
 * Two payloads with the same business content produce the same string regardless of key order.
 * Only plain JSON values are accepted; anything else (Date, NaN, functions...) is a programming
 * error and must be converted by the caller first, so the hash never depends on implicit coercion.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

/** SHA-256 of the canonical JSON, as 64 lowercase hex characters. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function serialize(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, `${path}[${String(index)}]`)).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${serialize(member, `${path}.${key}`)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`Unsupported value at ${path}: only plain JSON values can be hashed`);
}
