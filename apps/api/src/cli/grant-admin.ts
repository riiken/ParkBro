import { ADMIN_PERMISSIONS, type AdminPermission } from '../platform/auth/actor.ts';
import { loadEnv } from '../platform/config/env.ts';
import { createDb, createPool } from '../platform/db/database.ts';
import { createModules } from '../composition.ts';

/**
 * Grants PLATFORM_ADMIN + permissions to an already-registered user and enrols TOTP on first grant.
 * Usage: pnpm --filter @parkbro/api admin:grant <phone> <PERMISSION>[,<PERMISSION>...]
 * The otpauth URI is printed once: scan it into an authenticator app, then it is unrecoverable.
 */
const [phone, permissionList] = process.argv.slice(2);
const permissions = (permissionList ?? '').split(',').filter(Boolean) as AdminPermission[];
if (!phone || permissions.length === 0 || permissions.some((p) => !ADMIN_PERMISSIONS.includes(p))) {
  console.error(`usage: admin:grant <phone> <${ADMIN_PERMISSIONS.join('|')}>[,...]`);
  process.exit(2);
}

const env = loadEnv();
const pool = createPool(env);
try {
  const db = createDb(pool);
  const { identity } = createModules(env, db);
  const result = await identity.grantPlatformAdmin({ phone, permissions, grantedBy: null });
  console.log(`granted PLATFORM_ADMIN (${permissions.join(', ')}) to user ${result.userId}`);
  if (result.enrollmentUri) {
    console.log('\nTOTP enrolment (shown once; add it to an authenticator app now):');
    console.log(result.enrollmentUri);
  } else {
    console.log('TOTP already enrolled; existing authenticator stays valid.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
