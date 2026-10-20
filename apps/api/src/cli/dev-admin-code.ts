import { base32Decode, hotp, TOTP_CIPHER_CONTEXT, totpStep } from '../modules/identity/index.ts';
import { loadEnv } from '../platform/config/env.ts';
import { createFieldCipher, parseKeyring } from '../platform/crypto/field-cipher.ts';
import { createPool } from '../platform/db/database.ts';

/**
 * Development only: prints the current authenticator code for the seeded sample admin (9000000009), so the admin
 * console can be tried locally without an authenticator app. Refuses to run outside development.
 */
const env = loadEnv();
if (env.NODE_ENV !== 'development' && !env.STAGING) {
  console.error('admin:dev-code runs only in development or staging (STAGING=true)');
  process.exit(2);
}
const pool = createPool(env);
try {
  const cipher = createFieldCipher(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
  const row = await pool.query(
    `SELECT m.totp_secret_enc FROM identity.admin_mfa m JOIN identity.users u ON u.id = m.user_id WHERE u.display_name = 'Sample Admin' LIMIT 1`,
  );
  if (!row.rowCount) {
    console.error('No sample admin. Run pnpm db:seed first.');
    process.exitCode = 1;
  } else {
    const secret = cipher.decrypt(row.rows[0].totp_secret_enc as Buffer, TOTP_CIPHER_CONTEXT);
    const now = Math.floor(Date.now() / 1000);
    console.log(
      `Authenticator code for 9000000009: ${hotp(base32Decode(secret), totpStep(now))} (valid ~${30 - (now % 30)} s)`,
    );
  }
} finally {
  await pool.end();
}
