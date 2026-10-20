import pg from 'pg';
import { ADMIN_URL } from './helpers/db.ts';

export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `Integration tests need PostgreSQL at ${new URL(ADMIN_URL).host} (run \`pnpm db:up\`, or set TEST_DATABASE_ADMIN_URL). ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
