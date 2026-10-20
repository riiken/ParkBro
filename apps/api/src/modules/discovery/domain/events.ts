/** Anonymous discovery signals (Phase 21 analytics). No user, no IP, ≈1 km cells. */
declare module '../../../platform/events/domain-events.ts' {
  interface DomainEventMap {
    'discovery.searched': {
      cell: string;
      areaLabel: string | null;
      assetType: 'PARKING' | 'EV_CHARGING';
      mode: string | null;
      windowed: boolean;
      resultCount: number;
      firstPage: boolean;
    };
    'discovery.listing_viewed': { assetId: string };
  }
}

export {};
