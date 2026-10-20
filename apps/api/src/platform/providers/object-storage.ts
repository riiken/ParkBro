import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Private object storage (architecture.md §5 ObjectStorage). Keys are random and never derived from user input.
 * Pilot/dev: local disk outside any web root. Production: S3-compatible private bucket (Phase 23 / AR-1).
 */
export interface ObjectStorage {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_-]{0,200}\.[a-z0-9]{2,5}$/;

export function localDiskStorage(rootDir: string): ObjectStorage {
  const root = path.resolve(rootDir);
  const resolve = (key: string) => {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('invalid storage key');
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('storage key escapes root');
    return full;
  };
  return {
    name: 'local-disk',
    async put(key, body) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body, { flag: 'wx', mode: 0o600 });
    },
    async get(key) {
      try {
        return await readFile(resolve(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(resolve(key), { force: true });
    },
  };
}

/** Tests: in-memory storage. */
export function memoryStorage(): ObjectStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    name: 'memory',
    objects,
    async put(key, body) {
      if (objects.has(key)) throw new Error('object exists');
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
