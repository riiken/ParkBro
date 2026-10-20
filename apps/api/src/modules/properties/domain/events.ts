import type { ParticipationStatus } from './participation.ts';

declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    /** The exact location changed: listings at the property need re-review (material change, BR-23). */
    'property.location_changed': { propertyId: string; actorId: string; requestId: string };
    'property.participation_changed': {
      propertyId: string;
      from: ParticipationStatus;
      to: ParticipationStatus;
      actorId: string;
      requestId: string;
    };
    /** A society member host lost membership: their listings there must stop. */
    'property.member_revoked': {
      propertyId: string;
      hostAccountId: string;
      actorId: string;
      requestId: string;
    };
  }
}

export {};
