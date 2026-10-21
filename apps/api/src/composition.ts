import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { createAccessModule, type AccessModule } from './modules/access/index.ts';
import { createAdminModule } from './modules/admin/index.ts';
import { createAssetsModule } from './modules/assets/index.ts';
import { createAvailabilityModule, type ReservationSource } from './modules/availability/index.ts';
import {
  createBookingModule,
  createBookingReservations,
  type BookingModule,
} from './modules/booking/index.ts';
import {
  createChargingModule,
  type ChargerIntegrations,
  type ChargingModule,
} from './modules/charging/index.ts';
import { anthropicProvider, createAiModule, type AiModule, type LlmProvider } from './modules/ai/index.ts';
import { createAnalyticsModule, type AnalyticsModule } from './modules/analytics/index.ts';
import { createOpsModule } from './modules/ops/index.ts';
import { createDiscoveryModule } from './modules/discovery/index.ts';
import { createDisputesModule, type DisputesModule } from './modules/disputes/index.ts';
import { createReviewsModule, type ReviewsModule } from './modules/reviews/index.ts';
import { createEarningsModule, type EarningsModule } from './modules/earnings/index.ts';
import {
  createPaymentsModule,
  fakeProvider,
  razorpayProvider,
  type PaymentProvider,
  type PaymentsModule,
} from './modules/payments/index.ts';
import { createIdentityModule, type IdentityModule } from './modules/identity/index.ts';
import {
  consoleMessaging,
  createNotificationsModule,
  type MessagingProvider,
  type NotificationsModule,
} from './modules/notifications/index.ts';
import { createPricingModule } from './modules/pricing/index.ts';
import { createPropertiesModule } from './modules/properties/index.ts';
import { createTrustModule } from './modules/trust/index.ts';
import { createUsersModule } from './modules/users/index.ts';
import type { Env } from './platform/config/env.ts';
import { createDomainEventBus } from './platform/events/domain-events.ts';
import { fixtureGeocoder, type Geocoder } from './platform/providers/geocoding.ts';
import { photonGeocoder } from './platform/providers/photon.ts';
import { localDiskStorage, type ObjectStorage } from './platform/providers/object-storage.ts';
import type { ScheduledJob } from './platform/jobs/job-runner.ts';
import type { OtpSender } from './platform/providers/otp.ts';
import { createPlatformServices } from './platform/runtime.ts';

export interface RouteModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
}

export interface Modules {
  identity: IdentityModule;
  booking: BookingModule;
  charging: ChargingModule;
  payments: PaymentsModule;
  earnings: EarningsModule;
  access: AccessModule;
  notifications: NotificationsModule;
  reviews: ReviewsModule;
  disputes: DisputesModule;
  analytics: AnalyticsModule;
  ai: AiModule;
  /** Periodic maintenance run by the job runner (architecture §7). */
  jobs: ScheduledJob[];
  routeModules: RouteModule[];
}

/**
 * Wires every module (architecture.md §4): the only place module factories meet. Used by main.ts, the CLI and
 * integration tests, so production and tests run the same graph.
 */
export function createModules<DB>(
  env: Env,
  db: Kysely<DB>,
  overrides: {
    otpSender?: OtpSender;
    storage?: ObjectStorage;
    random?: () => number;
    geocoder?: Geocoder;
    now?: () => number;
    /** Defaults to the booking module's holding reservations. */
    reservations?: ReservationSource;
    /** Payment provider (default from env: the fake simulator, or Razorpay with keys). */
    paymentProvider?: PaymentProvider;
    /** Messaging provider (default from env: console in development, none otherwise). */
    messaging?: MessagingProvider | null;
    llm?: LlmProvider | null;
    /** Smart-charger adapters by integration kind (default: MANUAL only). */
    chargerIntegrations?: ChargerIntegrations;
  } = {},
): Modules {
  const platform = createPlatformServices(
    env,
    db,
    overrides.otpSender ? { otpSender: overrides.otpSender } : {},
  );
  const events = createDomainEventBus();
  const storage = overrides.storage ?? localDiskStorage(env.MEDIA_STORAGE_DIR);

  const identity = createIdentityModule({ db, ...platform });
  const reservations = overrides.reservations ?? createBookingReservations(db);
  const pricing = createPricingModule({ db });
  const availability = createAvailabilityModule({ db });
  const users = createUsersModule({
    db,
    cipher: platform.cipher,
    hasher: platform.hasher,
    audit: platform.audit,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const properties = createPropertiesModule({
    db,
    cipher: platform.cipher,
    audit: platform.audit,
    events,
    hosts: identity.hosts,
    ...(overrides.random ? { random: overrides.random } : {}),
  });
  const trust = createTrustModule({
    db,
    audit: platform.audit,
    clearanceRequired: env.PILOT_CUSTOMER_CLEARANCE,
  });
  const assets = createAssetsModule({
    db,
    cipher: platform.cipher,
    audit: platform.audit,
    events,
    storage,
    rateLimiter: platform.rateLimiter,
    hosts: identity.hosts,
    properties,
    pricing,
    availability,
    trust,
    reservations,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const geocoder = overrides.geocoder ?? geocoderFromEnv(env);
  const discovery = createDiscoveryModule({
    db,
    geocoder,
    rateLimiter: platform.rateLimiter,
    hasher: platform.hasher,
    reservations,
    events,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const booking = createBookingModule({
    db,
    audit: platform.audit,
    events,
    rateLimiter: platform.rateLimiter,
    identity,
    users,
    properties,
    assets,
    availability,
    pricing,
    ...(env.PILOT_CUSTOMER_CLEARANCE ? { customerCleared: trust.customerCleared } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const charging = createChargingModule({
    db,
    audit: platform.audit,
    events,
    booking,
    assets,
    hosts: identity.hosts,
    ...(overrides.chargerIntegrations ? { integrations: overrides.chargerIntegrations } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const provider = overrides.paymentProvider ?? paymentProviderFromEnv(env);
  const payments = createPaymentsModule({
    db,
    audit: platform.audit,
    rateLimiter: platform.rateLimiter,
    events,
    booking,
    provider,
    // The simulated checkout exists only for the fake provider and never in production (env.ts refuses fake there).
    ...(provider.name === 'FAKE' && env.NODE_ENV !== 'production'
      ? { fakeCheckout: provider as ReturnType<typeof fakeProvider> }
      : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  // Disputes are built after access (their evidence pack reads it); earnings asks them lazily (release hold).
  const late: { disputes?: DisputesModule } = {};
  const earnings = createEarningsModule({
    hasOpenDispute: (bookingId) => late.disputes?.hasOpenDispute(bookingId) ?? Promise.resolve(false),
    db,
    audit: platform.audit,
    cipher: platform.cipher,
    events,
    booking,
    payments,
    hosts: identity.hosts,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const access = createAccessModule({
    db,
    audit: platform.audit,
    cipher: platform.cipher,
    hasher: platform.hasher,
    rateLimiter: platform.rateLimiter,
    events,
    booking,
    users,
    assets,
    properties,
    hosts: identity.hosts,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const reviews = createReviewsModule({
    db,
    audit: platform.audit,
    booking,
    identity,
    hosts: identity.hosts,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const disputes = createDisputesModule({
    db,
    audit: platform.audit,
    events,
    storage,
    booking,
    identity,
    payments,
    access,
    reviews,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  late.disputes = disputes;

  const notifications = createNotificationsModule({
    db,
    events,
    identity,
    booking,
    assets,
    provider:
      overrides.messaging !== undefined
        ? overrides.messaging
        : env.MESSAGING_PROVIDER === 'console'
          ? consoleMessaging()
          : null,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const admin = createAdminModule({ db, env, booking, assets, payments });
  const analytics = createAnalyticsModule({ db, events, ...(overrides.now ? { now: overrides.now } : {}) });
  const ai = createAiModule({
    db,
    geocoder,
    rateLimiter: platform.rateLimiter,
    hasher: platform.hasher,
    llm: overrides.llm !== undefined ? overrides.llm : llmFromEnv(env),
    config: {
      timeoutMs: env.AI_TIMEOUT_MS,
      dailyBudgetUsd: env.AI_DAILY_BUDGET_USD,
      inputUsdPerMTok: env.AI_COST_INPUT_USD_PER_MTOK,
      outputUsdPerMTok: env.AI_COST_OUTPUT_USD_PER_MTOK,
    },
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const jobs: Modules['jobs'] = [
    { name: 'expire-holds', cron: '* * * * *', run: booking.expireLapsedHolds },
    { name: 'booking-transitions', cron: '*/5 * * * *', run: booking.completeFinished },
    { name: 'booking-series', cron: '*/5 * * * *', run: booking.seriesTick },
    { name: 'charging-sessions', cron: '*/5 * * * *', run: charging.closeFinished },
    { name: 'payments-refunds', cron: '* * * * *', run: payments.submitRefunds },
    { name: 'payments-reconcile', cron: '*/5 * * * *', run: payments.reconcile },
    { name: 'payments-settlements', cron: '30 3 * * *', run: () => payments.importSettlements() },
    { name: 'earnings-release', cron: '15 * * * *', run: earnings.releaseEarnings },
    { name: 'booking-issues', cron: '* * * * *', run: booking.autoResolveIssues },
    { name: 'notifications-deliver', cron: '* * * * *', run: notifications.deliver },
    { name: 'notifications-schedule', cron: '*/5 * * * *', run: notifications.schedule },
    { name: 'reviews-publish', cron: '20 * * * *', run: reviews.publishDue },
    { name: 'earnings-backfill', cron: '45 * * * *', run: earnings.backfill },
    // Weekly payout run, Monday 05:00 IST (23:30 UTC Sunday).
    { name: 'payouts-weekly', cron: '30 23 * * 0', run: () => earnings.runPayouts() },
    { name: 'purge-rate-limits', cron: '7 * * * *', run: platform.rateLimiter.purgeExpired },
    { name: 'purge-quotes', cron: '17 * * * *', run: pricing.purgeOldQuotes },
    { name: 'purge-otp-challenges', cron: '27 * * * *', run: identity.purgeOldChallenges },
    { name: 'purge-analytics-events', cron: '37 2 * * *', run: analytics.purgeOldEvents },
    { name: 'purge-ai-invocations', cron: '47 2 * * *', run: ai.purgeOldInvocations },
  ];

  return {
    identity,
    booking,
    charging,
    payments,
    earnings,
    access,
    notifications,
    reviews,
    disputes,
    analytics,
    ai,
    jobs,
    routeModules: [
      identity,
      users,
      trust,
      properties,
      assets,
      discovery,
      booking,
      charging,
      payments,
      earnings,
      access,
      notifications,
      reviews,
      disputes,
      admin,
      analytics,
      ai,
      createOpsModule({
        db,
        monitorToken: env.OPS_MONITOR_TOKEN,
        ...(overrides.now ? { now: overrides.now } : {}),
      }),
    ],
  };
}

function geocoderFromEnv(env: Env): Geocoder {
  if (env.GEOCODER_PROVIDER !== 'photon') return fixtureGeocoder();
  const [latitude, longitude] = env.GEOCODER_BIAS.split(',').map(Number) as [number, number];
  return photonGeocoder({
    baseUrl: env.PHOTON_URL,
    bias: { latitude, longitude },
    bbox: env.GEOCODER_BBOX.split(',').map(Number) as [number, number, number, number],
    userAgent: 'ParkBro/1.0 (https://parkbro.pathly.in)',
    fallback: fixtureGeocoder(),
  });
}

function llmFromEnv(env: Env): LlmProvider | null {
  if (env.AI_PROVIDER !== 'anthropic' || !env.ANTHROPIC_API_KEY) return null;
  return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL, apiBase: env.AI_API_BASE });
}

function paymentProviderFromEnv(env: Env): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    return razorpayProvider({
      keyId: env.RAZORPAY_KEY_ID ?? '',
      keySecret: env.RAZORPAY_KEY_SECRET ?? '',
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '',
      apiBase: env.RAZORPAY_API_BASE,
    });
  }
  return fakeProvider();
}
