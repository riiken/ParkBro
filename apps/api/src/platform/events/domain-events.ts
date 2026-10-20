import type { AnyKyselyExecutor } from '../audit/audit-log.ts';

/**
 * In-process domain events (architecture.md §4.2). Lets a module react to another module's changes without
 * importing it (no cycles): e.g. properties publishes `property.location_changed`, assets subscribes.
 *
 * Handlers run synchronously inside the publisher's transaction (`executor`), so the reaction is atomic with the
 * change. Cross-process/async delivery (notifications, analytics) will use the transactional outbox (Phase 12).
 *
 * Modules declare their events by augmenting DomainEventMap:
 *   declare module '../../platform/events/domain-events.ts' { interface DomainEventMap { 'x.y': { ... } } }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by module augmentation
export interface DomainEventMap {}

export type DomainEventType = keyof DomainEventMap;
export type DomainEventHandler<T extends DomainEventType> = (
  payload: DomainEventMap[T],
  executor: AnyKyselyExecutor,
) => Promise<void>;

export interface DomainEventBus {
  subscribe<T extends DomainEventType>(type: T, handler: DomainEventHandler<T>): void;
  publish<T extends DomainEventType>(
    type: T,
    payload: DomainEventMap[T],
    executor: AnyKyselyExecutor,
  ): Promise<void>;
}

export function createDomainEventBus(): DomainEventBus {
  const handlers = new Map<DomainEventType, DomainEventHandler<never>[]>();
  return {
    subscribe(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler as DomainEventHandler<never>]);
    },
    async publish(type, payload, executor) {
      for (const handler of handlers.get(type) ?? []) {
        await (handler as DomainEventHandler<typeof type>)(payload, executor);
      }
    },
  };
}
