# ParkBro

Marketplace for private parking and EV charging (working name). Read `CLAUDE.md` (constitution),
`PHASES.md` (roadmap), `PROJECT_STATUS.md` (where we are) and `docs/` (design) before changing anything.

## Layout

| Path                  | What                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`            | Fastify modular monolith (TypeScript run natively by Node 24). `src/modules/*` are domain modules, `src/platform/*` shared infrastructure, `src/app.ts` the composition root. |
| `apps/api/migrations` | Forward-only SQL migrations (`NNNN_name.sql`)                                                                                                                                 |
| `apps/web`            | Customer / host / property-admin PWA (Next.js)                                                                                                                                |
| `apps/admin`          | Platform admin console (Next.js, separate origin)                                                                                                                             |
| `packages/contracts`  | Shared Zod contracts (e.g. RFC 9457 problem details)                                                                                                                          |
| `packages/config`     | Shared config (web security headers)                                                                                                                                          |
| `docs/`               | Product, domain, UX, trust & safety, architecture and database design                                                                                                         |

## Prerequisites

- Node.js 24 (`nvm use`) with Corepack (`corepack enable`), which provides pnpm 10
- Docker (local PostgreSQL 17 + PostGIS)

## First run

```sh
cp .env.example .env
pnpm install
pnpm db:up          # PostgreSQL on 127.0.0.1:54329
pnpm db:migrate
pnpm dev:api        # http://127.0.0.1:4101/api/health/ready
pnpm dev:web        # http://127.0.0.1:4100 (proxies /api to the API: same-origin, D-033)
pnpm dev:admin      # http://127.0.0.1:4102
```

## Checks

```sh
pnpm check          # format:check, lint (incl. module boundaries), typecheck, test, build
pnpm test           # unit + integration (integration needs `pnpm db:up`)
pnpm db:status      # applied / pending migrations, checksum problems
pnpm db:new <name>  # create the next numbered migration
```

API docs (non-production): `GET /api/docs/openapi.json`. Conventions and endpoints: `docs/api-design.md`.

### Signing in locally

- OTP codes print to the API's stderr (`OTP_PROVIDER=console`), e.g. `[dev otp] USER_LOGIN for ••••3210: 123456`.
- First admin: register in the web app, then `pnpm --filter @parkbro/api admin:grant <phone> SUPER_ADMIN` and add the
  printed `otpauth://` URI to an authenticator app (shown once). Admin console: http://127.0.0.1:4102.

### End-to-end tests

```sh
pnpm --filter @parkbro/e2e exec playwright install chromium   # once
pnpm e2e    # builds web + admin, runs API on 4111 against a fresh parkbro_e2e database (needs `pnpm db:up`)
```

## Rules of the road

- Secrets live in `.env` (git-ignored) or the deployment secret store. Never commit them; never log them.
- Modules talk to each other only through `modules/<name>/index.ts`; lint enforces it.
- Only erasable TypeScript syntax (no `enum`, no parameter properties): Node runs the sources directly.
- Every state-changing API request needs the `X-Requested-With: fetch` header (CSRF).
