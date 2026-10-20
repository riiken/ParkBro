import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DomainEventBus } from '../../platform/events/domain-events.ts';
import type { AssetsModule } from '../assets/index.ts';
import type { BookingModule } from '../booking/index.ts';
import type { IdentityModule } from '../identity/index.ts';
import { createNotificationService, type NotificationService } from './application/notification-service.ts';
import type { MessagingProvider } from './domain/provider.ts';
import { messagingWebhookRoutes, notificationRoutes } from './http/routes.ts';
import type { NotificationsDb } from './infrastructure/tables.ts';

export {
  consoleMessaging,
  memoryMessaging,
  PermanentDeliveryError,
  type MessagingProvider,
} from './domain/provider.ts';

export interface NotificationsModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  deliver: NotificationService['deliver'];
  schedule: NotificationService['schedule'];
}

/** Notifications (Phase 18): outbox rows from domain events, delivery worker, in-app inbox. */
export function createNotificationsModule<DB>(deps: {
  db: Kysely<DB>;
  events: DomainEventBus;
  identity: Pick<IdentityModule, 'contactFor' | 'hostMemberIds'>;
  booking: Pick<BookingModule, 'partiesOf' | 'scheduleFeed'>;
  assets: Pick<AssetsModule, 'bookingContext'>;
  provider: MessagingProvider | null;
  now?: () => number;
}): NotificationsModule {
  const db = deps.db.withTables<NotificationsDb>() as unknown as Kysely<NotificationsDb>;
  const notifications = createNotificationService({ ...deps, db });
  return {
    async registerRoutes(api) {
      await api.register(notificationRoutes, { notifications });
      if (deps.provider)
        await api.register(messagingWebhookRoutes, { notifications, provider: deps.provider.name });
    },
    deliver: notifications.deliver,
    schedule: notifications.schedule,
  };
}
