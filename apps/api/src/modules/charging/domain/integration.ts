/**
 * Charger integration seam (domain-model §3.6, architecture §5 "ChargerIntegration"; CLAUDE.md §4). The application
 * never assumes hardware: a session is driven by the customer (MANUAL) until a smart-charger adapter (OCPP 1.6/2.0.1
 * or a vendor API) is registered for an `integration_kind`. Adapters must be idempotent and must never decide
 * booking, payment or access state; they only report what the charger did.
 */
export type IntegrationKind = 'MANUAL';
export type ChargerStatus = 'AVAILABLE' | 'OCCUPIED' | 'CHARGING' | 'FAULTED' | 'UNKNOWN';

export interface ChargerRef {
  assetId: string;
  /** Adapter-specific charger identity (e.g. charge point id); null for MANUAL. */
  integrationRef: string | null;
}

export interface ChargerIntegration {
  readonly kind: IntegrationKind;
  /** Whether energy readings come from the hardware (CHARGER_API) or not at all (NONE). */
  readonly metering: 'NONE' | 'CHARGER_API';
  getStatus(charger: ChargerRef): Promise<ChargerStatus>;
  /** Asks the charger to start; `accepted: false` means the hardware refused (fault path). */
  startSession(
    charger: ChargerRef,
    session: { sessionId: string; bookingId: string },
  ): Promise<{ accepted: boolean; externalRef: string | null }>;
  stopSession(charger: ChargerRef, session: { sessionId: string; externalRef: string | null }): Promise<void>;
  /** Delivered energy in Wh, or null without metering. */
  readEnergy(
    charger: ChargerRef,
    session: { sessionId: string; externalRef: string | null },
  ): Promise<number | null>;
}

/** Pilot adapter: the customer reports start and stop; there is no meter (D-005). */
export const manualIntegration: ChargerIntegration = {
  kind: 'MANUAL',
  metering: 'NONE',
  getStatus: async () => 'UNKNOWN',
  startSession: async () => ({ accepted: true, externalRef: null }),
  stopSession: async () => undefined,
  readEnergy: async () => null,
};

export type ChargerIntegrations = Record<IntegrationKind, ChargerIntegration>;
export const defaultIntegrations: ChargerIntegrations = { MANUAL: manualIntegration };
