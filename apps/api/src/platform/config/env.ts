import { z } from 'zod';

/**
 * Development-only secrets shipped in .env.example so the stack runs out of the box. They are public, so any
 * non-development environment refuses to start with them.
 */
export const DEV_ONLY_FIELD_ENCRYPTION_KEYS = 'v1:ZGV2LW9ubHktZmllbGQta2V5LW5ldmVyLXVzZS1pdCE=';
export const DEV_ONLY_BLIND_INDEX_KEY = 'ZGV2LW9ubHktYmxpbmQtaW5kZXgta2V5LW5ldmVyLXVzZSE=';

const keyringSpec = z
  .string()
  .regex(/^v\d{1,3}:[A-Za-z0-9+/=]+(,v\d{1,3}:[A-Za-z0-9+/=]+)*$/, 'must look like v1:<base64>[,v2:<base64>]')
  .refine(
    (spec) => spec.split(',').every((part) => Buffer.from(part.split(':')[1] ?? '', 'base64').length === 32),
    'every key must decode to exactly 32 bytes',
  );
const base64Key32 = z
  .string()
  .refine((value) => Buffer.from(value, 'base64').length >= 32, 'must be base64 of at least 32 bytes');

/**
 * Environment contract. The process refuses to start unless this validates (fail fast).
 * Validation errors name the offending keys but never echo their values, because several are secrets.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4101),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // TLS to PostgreSQL: 'url' = as the URL's sslmode says; 'require' (verify cert); 'no-verify' (encrypt, managed
    // providers with private CAs); 'disable' only for staging on a provider's private network (D-172).
    DATABASE_SSL: z.enum(['url', 'require', 'no-verify', 'disable']).default('url'),
    // Staging (D-172): a private, production-built test deployment. Allows the simulators (fake payments, fixture
    // geocoder, fixed OTP, console messaging) but only for STAGING_ALLOWED_PHONES, and never the dev keys.
    STAGING: z.stringbool().default(false),
    STAGING_ALLOWED_PHONES: z
      .string()
      .regex(
        /^\s*(\+?91)?\d{10}\s*(,\s*(\+?91)?\d{10}\s*)*$/,
        'must be comma-separated 10-digit mobile numbers',
      )
      .optional(),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    TRUST_PROXY: z.stringbool().default(false),
    API_DOCS_ENABLED: z.stringbool().optional(),
    FIELD_ENCRYPTION_KEYS: keyringSpec,
    BLIND_INDEX_KEY: base64Key32,
    // 'console' prints codes to stderr; 'dev-fixed' uses OTP_DEV_FIXED_CODE (e2e). Neither is allowed in production.
    OTP_PROVIDER: z.enum(['console', 'dev-fixed']).default('console'),
    OTP_DEV_FIXED_CODE: z
      .string()
      .regex(/^\d{6}$/, 'must be 6 digits')
      .optional(),
    // Local-disk object storage root for photos (dev/pilot); S3-compatible storage before staging (AR-1).
    MEDIA_STORAGE_DIR: z.string().min(1).default('.data/media'),
    // Place search provider. Only the Bengaluru fixture exists until the maps vendor is chosen (AR-3).
    GEOCODER_PROVIDER: z.enum(['fixture', 'photon']).default('fixture'),
    // Photon (OpenStreetMap) place search (D-174): the public instance for the pilot; self-host when volume grows.
    PHOTON_URL: z.url().default('https://photon.komoot.io'),
    // Pilot city (Bengaluru): search bias "lat,lng" and bounding box "minLon,minLat,maxLon,maxLat".
    GEOCODER_BIAS: z
      .string()
      .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
      .default('12.9716,77.5946'),
    GEOCODER_BBOX: z
      .string()
      .regex(/^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/)
      .default('77.30,12.70,77.95,13.30'),
    // Operational tuning (trust-and-safety §5). Raise for NAT-heavy networks or automated test environments.
    OTP_SEND_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(20),
    OTP_VERIFY_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(60),
    // Scheduled maintenance (hold expiry, completion, purges) via pg-boss. Disable for one-off processes.
    JOBS_ENABLED: z.stringbool().default(true),
    // Payments (D-120). 'fake' is an in-process simulator for development and tests; production needs Razorpay.
    PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
    RAZORPAY_KEY_ID: z
      .string()
      .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like rzp_test_… or rzp_live_…')
      .optional(),
    RAZORPAY_KEY_SECRET: z.string().min(16).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(16).optional(),
    RAZORPAY_API_BASE: z.url().default('https://api.razorpay.com'),
    // Notifications (D-143). 'console' prints redacted messages (development); 'none' keeps in-app only.
    MESSAGING_PROVIDER: z.enum(['console', 'none']).default('console'),
    // Controlled pilot (D-168): only customers cleared by trust & safety may book. Recommended on for launch.
    PILOT_CUSTOMER_CLEARANCE: z.stringbool().default(false),
    // Bearer token for GET /api/health/ops (external monitor / alerting, production-readiness §5). Unset = disabled.
    OPS_MONITOR_TOKEN: z.string().min(32).optional(),
    // AI layer (D-163). 'none' uses the deterministic rules parser only; 'anthropic' needs a key.
    AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
    ANTHROPIC_API_KEY: z.string().min(20).optional(),
    AI_MODEL: z.string().min(3).max(80).default('claude-haiku-5-5'),
    AI_API_BASE: z.url().default('https://api.anthropic.com'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(4000),
    // Spend cap per IST day; beyond it every request uses the rules parser (D-165).
    AI_DAILY_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(5),
    // Model prices (USD per million tokens) from the provider's current price list; used for cost tracking.
    AI_COST_INPUT_USD_PER_MTOK: z.coerce.number().min(0).max(1000).default(1),
    AI_COST_OUTPUT_USD_PER_MTOK: z.coerce.number().min(0).max(1000).default(5),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      if (env.FIELD_ENCRYPTION_KEYS.includes(DEV_ONLY_FIELD_ENCRYPTION_KEYS.slice(3))) {
        ctx.addIssue({
          code: 'custom',
          path: ['FIELD_ENCRYPTION_KEYS'],
          message: 'development key is not allowed here',
        });
      }
      if (env.BLIND_INDEX_KEY === DEV_ONLY_BLIND_INDEX_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['BLIND_INDEX_KEY'],
          message: 'development key is not allowed here',
        });
      }
      if (!env.STAGING) {
        ctx.addIssue({
          code: 'custom',
          path: ['OTP_PROVIDER'],
          message: 'no production OTP provider exists yet (DLT-registered SMS/WhatsApp, Phase 18)',
        });
        if (env.GEOCODER_PROVIDER === 'fixture') {
          ctx.addIssue({
            code: 'custom',
            path: ['GEOCODER_PROVIDER'],
            message: 'the fixture geocoder is for development only; use photon (D-174)',
          });
        }
      }
    }
    if (env.STAGING && !env.STAGING_ALLOWED_PHONES) {
      ctx.addIssue({
        code: 'custom',
        path: ['STAGING_ALLOWED_PHONES'],
        message: 'staging is invite-only: list the tester phone numbers',
      });
    }
    if (env.AI_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'required when AI_PROVIDER=anthropic',
      });
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) {
        if (!env[key])
          ctx.addIssue({ code: 'custom', path: [key], message: 'required when PAYMENT_PROVIDER=razorpay' });
      }
    }
    if (env.NODE_ENV === 'production' && !env.STAGING) {
      if (env.PAYMENT_PROVIDER !== 'razorpay') {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYMENT_PROVIDER'],
          message: 'the fake payment provider is not allowed in production',
        });
      }
      if (env.MESSAGING_PROVIDER === 'console') {
        ctx.addIssue({
          code: 'custom',
          path: ['MESSAGING_PROVIDER'],
          message: 'console messaging is for development; use none until a provider is registered (R-46)',
        });
      }
      if (env.PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) {
        ctx.addIssue({
          code: 'custom',
          path: ['RAZORPAY_KEY_ID'],
          message: 'test keys are not allowed in production',
        });
      }
    }
    if (env.OTP_PROVIDER === 'dev-fixed' && env.OTP_DEV_FIXED_CODE === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_DEV_FIXED_CODE'],
        message: 'required when OTP_PROVIDER=dev-fixed',
      });
    }
    const tls =
      env.DATABASE_SSL === 'require' ||
      env.DATABASE_SSL === 'no-verify' ||
      (env.DATABASE_SSL === 'url' && /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(env.DATABASE_URL));
    if (env.NODE_ENV === 'production' && !tls && !(env.STAGING && env.DATABASE_SSL === 'disable')) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must use TLS in production (sslmode=require in the URL, or DATABASE_SSL=require|no-verify)',
      });
    }
  })
  .transform((env) => ({
    ...env,
    API_DOCS_ENABLED: env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production',
  }));

export type Env = z.output<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only key paths and our own messages; never `input`, which may contain secrets.
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}

/** Safe-to-log view of the configuration (credentials removed). */
export function describeEnv(env: Env): Record<string, unknown> {
  const db = new URL(env.DATABASE_URL);
  return {
    NODE_ENV: env.NODE_ENV,
    HOST: env.HOST,
    PORT: env.PORT,
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE: `${db.protocol}//${db.hostname}:${db.port || '5432'}${db.pathname}`,
    DATABASE_POOL_MAX: env.DATABASE_POOL_MAX,
    TRUST_PROXY: env.TRUST_PROXY,
    API_DOCS_ENABLED: env.API_DOCS_ENABLED,
    JOBS_ENABLED: env.JOBS_ENABLED,
    PAYMENT_PROVIDER: env.PAYMENT_PROVIDER, // keys and secrets are never logged
    MESSAGING_PROVIDER: env.MESSAGING_PROVIDER,
    AI_PROVIDER: env.AI_PROVIDER,
    AI_MODEL: env.AI_MODEL,
    OPS_MONITOR_ENABLED: env.OPS_MONITOR_TOKEN !== undefined,
    STAGING: env.STAGING,
    GEOCODER_PROVIDER: env.GEOCODER_PROVIDER,
    DATABASE_SSL: env.DATABASE_SSL,
    PILOT_CUSTOMER_CLEARANCE: env.PILOT_CUSTOMER_CLEARANCE,
  };
}
