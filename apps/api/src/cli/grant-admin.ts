import { ADMIN_PERMISSIONS, type AdminPermission } from '../platform/auth/actor.ts';
import { loadEnv } from '../platform/config/env.ts';
import { createDb, createPool } from '../platform/db/database.ts';
import { createModules } from '../composition.ts';

/**
 * Grants PLATFORM_ADMIN + permissions to an already-registered user and enrols TOTP on first grant.
 * Usage: pnpm --filter @parkbro/api admin:grant <phone> <PERMISSION>[,<PERMISSION>...] [--reset-authenticator]
 * The otpauth URI and setup key are printed once: add them to an authenticator app, then they are unrecoverable.
 * --reset-authenticator: lost phone or never saved it; issues a new secret and signs out their admin sessions.
 */
const args = process.argv.slice(2);
const resetAuthenticator = args.includes('--reset-authenticator');
const [phone, permissionList] = args.filter((a) => !a.startsWith('--'));
const permissions = (permissionList ?? '').split(',').filter(Boolean) as AdminPermission[];
if (!phone || permissions.length === 0 || permissions.some((p) => !ADMIN_PERMISSIONS.includes(p))) {
  console.error(`usage: admin:grant <phone> <${ADMIN_PERMISSIONS.join('|')}>[,...] [--reset-authenticator]`);
  process.exit(2);
}

const env = loadEnv();
const pool = createPool(env);
try {
  const db = createDb(pool);
  const { identity } = createModules(env, db);
  const result = await identity.grantPlatformAdmin({
    phone,
    permissions,
    grantedBy: null,
    resetAuthenticator,
  });
  console.log(`granted PLATFORM_ADMIN (${permissions.join(', ')}) to user ${result.userId}`);
  if (result.enrollmentUri) {
    const key = new URL(result.enrollmentUri).searchParams.get('secret') ?? '';
    console.log(`\nAuthenticator ${resetAuthenticator ? 'reset' : 'enrolment'} (shown once; add it now):`);
    console.log(`  Setup key (Google Authenticator: + → Enter a setup key, time-based): ${key}`);
    console.log(`  Or this link (1Password, Authy desktop…): ${result.enrollmentUri}`);
  } else {
    console.log('Authenticator already set up; the existing one stays valid.');
    console.log('Lost it or never saved it? Run again with --reset-authenticator.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
