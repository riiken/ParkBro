import { createHash } from 'node:crypto';

/**
 * Keyset pagination cursors bound to the query that produced them: a cursor from another search (different
 * origin, filters or sort) is rejected instead of silently returning a wrong page.
 */
export interface CursorPosition {
  key: number[]; // sort key values (e.g. [distance] or [price, distance])
  id: string;
}

export function queryFingerprint(query: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(query)
      .sort()
      .map((k) => [k, query[k]]),
  );
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

export function encodeCursor(position: CursorPosition, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ k: position.key, i: position.id, q: fingerprint })).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string, fingerprint: string): CursorPosition | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      k?: unknown;
      i?: unknown;
      q?: unknown;
    };
    if (raw.q !== fingerprint || typeof raw.i !== 'string' || !Array.isArray(raw.k)) return null;
    if (!raw.k.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return { key: raw.k as number[], id: raw.i };
  } catch {
    return null;
  }
}

/** Lexicographic comparison of (key…, id). */
export function isAfter(item: CursorPosition, cursor: CursorPosition): boolean {
  for (let i = 0; i < item.key.length; i++) {
    const a = item.key[i] ?? 0;
    const b = cursor.key[i] ?? 0;
    if (a !== b) return a > b;
  }
  return item.id > cursor.id;
}
