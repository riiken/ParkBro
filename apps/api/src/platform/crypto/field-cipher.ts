import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for sensitive columns (D-037): AES-256-GCM with a key version prefix so keys can
 * rotate. Ciphertext layout: [1 byte key version][12 byte IV][16 byte auth tag][ciphertext].
 *
 * Pilot: keys come from the environment. Production target: data keys wrapped by the cloud KMS (Phase 23).
 */
export interface FieldCipher {
  encrypt(plaintext: string, context: string): Buffer;
  decrypt(ciphertext: Buffer, context: string): string;
}

export class FieldCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldCipherError';
  }
}

/** keys: version → 32-byte key; the highest version encrypts, any listed version decrypts. */
export function createFieldCipher(keys: ReadonlyMap<number, Buffer>): FieldCipher {
  if (keys.size === 0) throw new FieldCipherError('at least one encryption key is required');
  for (const [version, key] of keys) {
    if (version < 1 || version > 255) throw new FieldCipherError(`invalid key version ${version}`);
    if (key.length !== 32) throw new FieldCipherError(`key v${version} must be 32 bytes`);
  }
  const current = Math.max(...keys.keys());

  return {
    // `context` (e.g. "identity.users.phone") is bound as additional authenticated data, so a ciphertext
    // copied into another column fails to decrypt.
    encrypt(plaintext, context) {
      const key = keys.get(current) as Buffer;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([current]), iv, cipher.getAuthTag(), body]);
    },
    decrypt(ciphertext, context) {
      if (ciphertext.length < 1 + 12 + 16) throw new FieldCipherError('ciphertext too short');
      const key = keys.get(ciphertext[0] ?? 0);
      if (!key) throw new FieldCipherError(`unknown key version ${ciphertext[0]}`);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(1, 13));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(ciphertext.subarray(13, 29));
        return Buffer.concat([decipher.update(ciphertext.subarray(29)), decipher.final()]).toString('utf8');
      } catch {
        throw new FieldCipherError('decryption failed (wrong key, wrong context or tampered data)');
      }
    },
  };
}

/** Parses "v1:<base64>,v2:<base64>" into a key map. */
export function parseKeyring(spec: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const part of spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const match = /^v(\d{1,3}):([A-Za-z0-9+/=]+)$/.exec(part);
    if (!match) throw new FieldCipherError('keyring entries must look like v1:<base64 32 bytes>');
    keys.set(Number(match[1]), Buffer.from(match[2] ?? '', 'base64'));
  }
  return keys;
}
