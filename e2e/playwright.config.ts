import { defineConfig, devices } from '@playwright/test';

// Dedicated ports and database so e2e never collides with local development (D-050).
const API_PORT = 4111;
const WEB_PORT = 4110;
export const ADMIN_PORT = 4112;
const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:54329/parkbro_e2e';
export const E2E_OTP_CODE = '246810';

export const apiEnv = {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  DATABASE_URL,
  FIELD_ENCRYPTION_KEYS: 'v1:ZGV2LW9ubHktZmllbGQta2V5LW5ldmVyLXVzZS1pdCE=',
  BLIND_INDEX_KEY: 'ZGV2LW9ubHktYmxpbmQtaW5kZXgta2V5LW5ldmVyLXVzZSE=',
  OTP_PROVIDER: 'dev-fixed',
  OTP_DEV_FIXED_CODE: E2E_OTP_CODE,
  // Every e2e request comes from 127.0.0.1; the production default (20/h per IP) is covered by API tests.
  OTP_SEND_LIMIT_PER_IP_PER_HOUR: '1000',
  OTP_VERIFY_LIMIT_PER_IP_PER_HOUR: '1000',
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: `node scripts/prepare-db.ts && node ../apps/api/src/platform/db/cli.ts migrate && node ../apps/api/src/main.ts`,
      url: `http://127.0.0.1:${API_PORT}/api/health/ready`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Production build: proves the strict nonce CSP and caching behave as deployed.
      command: `pnpm --filter @parkbro/web build && pnpm --filter @parkbro/web exec next start --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command: `pnpm --filter @parkbro/admin build && pnpm --filter @parkbro/admin exec next start --port ${ADMIN_PORT}`,
      url: `http://127.0.0.1:${ADMIN_PORT}/sign-in`,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
