import pg from 'pg';

/** Recreates the dedicated e2e database (never the development database). */
const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
const client = new pg.Client({ connectionString: admin });
await client.connect();
await client.query('DROP DATABASE IF EXISTS parkbro_e2e WITH (FORCE)');
await client.query('CREATE DATABASE parkbro_e2e');
await client.end();
console.log('e2e database recreated');
