/** Events the charging module publishes (notifications, Phase 18). */
declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    'charging.started': { bookingId: string; customerId: string };
    'charging.completed': { bookingId: string; customerId: string; energyKwh: number | null };
  }
}

export {};
