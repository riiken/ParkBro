import path from 'node:path';

/** apps/api/migrations, resolved from this file so it works from any working directory. */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../migrations');
