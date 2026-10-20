/**
 * Access mechanism seam (architecture §5 "AccessAdapter"; CLAUDE.md §17). The pilot mechanisms (6-digit code,
 * vehicle number, digital pass) are built in. External systems plug in here without touching bookings:
 *
 * - SMART_LOCK: provision a time-boxed PIN/key for the grant window; deprovision on revoke.
 * - ANPR: camera plate reads arrive as external events → verified by plate → ENTERED.
 * - GATE_SYSTEM: boom barrier / access controller; provision an allow-list entry for the window.
 * - SOCIETY_SYSTEM: MyGate / NoBrokerHood / ADDA visitor pre-approval (D-011).
 *
 * Adapters never decide authorisation: they receive grants the platform issued and report what happened.
 * No adapter is configured for any property yet (no hardware or partner integration in the pilot).
 */
export type ExternalKind = 'SMART_LOCK' | 'ANPR' | 'GATE_SYSTEM' | 'SOCIETY_SYSTEM';

export interface GrantForAdapter {
  grantId: string;
  propertyId: string;
  unitLabel: string | null;
  plateLast4: string;
  validFrom: Date;
  validUntil: Date;
}

export interface AccessAdapter {
  readonly kind: ExternalKind;
  provision(grant: GrantForAdapter): Promise<{ externalRef: string | null }>;
  deprovision(grant: GrantForAdapter & { externalRef: string | null }): Promise<void>;
}

/** An event reported by an external system (e.g. an ANPR read at a property's gate). */
export interface ExternalAccessEvent {
  kind: ExternalKind;
  propertyId: string;
  plate?: string;
  at: number;
}

export type AccessAdapters = (propertyId: string) => readonly AccessAdapter[];
export const noAdapters: AccessAdapters = () => [];
