import { DateTime } from 'luxon';
import { z } from 'zod';

export const ZONE = 'Asia/Kolkata';
export const MAX_TEXT_LENGTH = 300;
/** Furthest ahead a natural-language date may land (BR-04 lead limits are checked again by the search itself). */
export const MAX_DAYS_AHEAD = 90;

export const PARKING_MODES = ['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY'] as const;
export const VEHICLE_CLASSES = ['HATCHBACK', 'SEDAN', 'SUV', 'MUV'] as const;
export const CONNECTORS = ['TYPE2', 'CCS2', 'BHARAT_AC001', 'BHARAT_DC001', 'IEC_15A', 'GBT'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * What the model (or the rules parser) may say about a search: filters only. `.strict()` rejects anything else, so
 * an output that tries to carry an action, an id or coordinates is invalid as a whole and falls back (D-164).
 * Places are words, never coordinates: only the geocoder turns them into a point.
 */
export const searchIntentSchema = z
  .object({
    assetType: z
      .enum(['PARKING', 'EV_CHARGING'])
      .describe('PARKING, or EV_CHARGING when they want to charge'),
    place: z
      .string()
      .min(2)
      .max(80)
      .nullable()
      .describe('Locality or landmark exactly as written, e.g. "Indiranagar"; null if none'),
    nearMe: z.boolean().describe('True for "near me", "nearby", "around here"'),
    mode: z
      .enum([...PARKING_MODES, 'CHARGING_SESSION'])
      .nullable()
      .describe(
        'Parking: HOURLY, DAILY (all day), OVERNIGHT, MONTHLY. Charging: CHARGING_SESSION. Null if unsaid',
      ),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .describe('Local date YYYY-MM-DD resolved against today; null if unsaid'),
    from: hhmm.nullable().describe('Local start time HH:MM (24 h); null if unsaid'),
    to: hhmm.nullable().describe('Local end time HH:MM (24 h); null if unsaid'),
    maxPriceRupees: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .nullable()
      .describe(
        'Highest acceptable price in rupees per hour / day / night / month of the mode; null if unsaid',
      ),
    covered: z.boolean().nullable().describe('True if they want covered parking'),
    security: z
      .array(z.enum(['CCTV', 'GUARD', 'GATED']))
      .max(3)
      .describe('Security features asked for'),
    evReady: z.boolean().nullable().describe('Parking with an EV charging socket'),
    vehicleClass: z.enum(VEHICLE_CLASSES).nullable().describe('Car size if stated'),
    connector: z.enum(CONNECTORS).nullable().describe('Charging connector if stated'),
    currentType: z.enum(['AC', 'DC']).nullable().describe('DC for fast charging, AC for slow'),
    minPowerKw: z.number().min(1).max(400).nullable().describe('Minimum charger power in kW if stated'),
    notUnderstood: z
      .array(z.string().max(80))
      .max(5)
      .describe('Short phrases of the request that none of these fields can express (e.g. "near a metro")'),
  })
  .strict();
export type SearchIntent = z.infer<typeof searchIntentSchema>;

export const emptyIntent = (assetType: SearchIntent['assetType'] = 'PARKING'): SearchIntent => ({
  assetType,
  place: null,
  nearMe: false,
  mode: null,
  date: null,
  from: null,
  to: null,
  maxPriceRupees: null,
  covered: null,
  security: [],
  evReady: null,
  vehicleClass: null,
  connector: null,
  currentType: null,
  minPowerKw: null,
  notUnderstood: [],
});

/**
 * Strip contact details and plates before text leaves the platform (privacy, D-166). Searches never need them.
 */
export function redact(text: string): string {
  return text
    .slice(0, MAX_TEXT_LENGTH)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b/gi, '[plate]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The filters the web search form understands; this is what the client applies and then searches with. */
export interface SearchFilters {
  type: 'PARKING' | 'EV_CHARGING';
  place: { name: string; latitude: number; longitude: number } | null;
  useMyLocation: boolean;
  mode: string | null;
  date: string | null;
  from: string | null;
  to: string | null;
  maxPricePaise: number | null;
  covered: boolean;
  security: ('CCTV' | 'GUARD' | 'GATED')[];
  evReady: boolean;
  vehicleClass: string | null;
  connector: string | null;
  currentType: 'AC' | 'DC' | null;
  minPowerKw: number | null;
}

/**
 * Deterministic clean-up of a validated intent: drop filters that don't apply to the asset type, keep dates in the
 * bookable range, never invent an end time. Returns notes for anything dropped. The place is resolved separately.
 */
export function normalise(
  intent: SearchIntent,
  nowMs: number,
): { filters: Omit<SearchFilters, 'place'>; notes: string[] } {
  const notes: string[] = [];
  const ev = intent.assetType === 'EV_CHARGING';
  let mode = intent.mode;
  if (mode && ev !== (mode === 'CHARGING_SESSION')) {
    notes.push(ev ? 'Charging is booked per session.' : 'That booking type is for charging only.');
    mode = null;
  }
  const today = DateTime.fromMillis(nowMs, { zone: ZONE }).startOf('day');
  let date = intent.date;
  if (date) {
    const d = DateTime.fromISO(date, { zone: ZONE });
    if (!d.isValid || d < today || d > today.plus({ days: MAX_DAYS_AHEAD })) {
      notes.push(`We can only search dates from today to ${MAX_DAYS_AHEAD} days ahead.`);
      date = null;
    }
  }
  const { from } = intent;
  let { to } = intent;
  if (!date && (from || to)) {
    date = today.toISODate();
    // A time earlier than now today means tomorrow ("at 8 am" said in the evening).
    const start = from ? DateTime.fromISO(`${date}T${from}`, { zone: ZONE }) : null;
    if (start && start.toMillis() < nowMs) date = today.plus({ days: 1 }).toISODate();
  }
  if (from && to === from) to = null;
  let maxPricePaise = intent.maxPriceRupees != null ? intent.maxPriceRupees * 100 : null;
  if (maxPricePaise != null && !mode) mode = ev ? 'CHARGING_SESSION' : 'HOURLY'; // the search needs a priced mode
  if (maxPricePaise != null && maxPricePaise < 100) maxPricePaise = null;
  return {
    filters: {
      type: intent.assetType,
      useMyLocation: intent.nearMe && !intent.place,
      mode,
      date,
      from,
      to,
      maxPricePaise,
      covered: !ev && intent.covered === true,
      security: ev ? [] : [...new Set(intent.security)],
      evReady: !ev && intent.evReady === true,
      vehicleClass: ev ? null : intent.vehicleClass,
      connector: ev ? intent.connector : null,
      currentType: ev ? intent.currentType : null,
      minPowerKw: ev ? intent.minPowerKw : null,
    },
    notes,
  };
}

const MODE_TEXT: Record<string, string> = {
  HOURLY: 'Hourly',
  DAILY: 'All day',
  OVERNIGHT: 'Overnight',
  MONTHLY: 'Monthly',
  CHARGING_SESSION: 'Charging session',
};
const PER: Record<string, string> = {
  HOURLY: 'hour',
  DAILY: 'day',
  OVERNIGHT: 'night',
  MONTHLY: 'month',
  CHARGING_SESSION: 'hour',
};
const CONNECTOR_TEXT: Record<string, string> = {
  TYPE2: 'Type 2',
  CCS2: 'CCS2',
  BHARAT_AC001: 'Bharat AC-001',
  BHARAT_DC001: 'Bharat DC-001',
  IEC_15A: '15 A socket',
  GBT: 'GB/T',
};

/**
 * What we understood, as chips (CLAUDE.md §22: the reply is generated from validated fields, not by the model, so it
 * can't claim availability, prices or anything else the search hasn't checked).
 */
export function describe(f: SearchFilters): string[] {
  const chips: string[] = [f.type === 'PARKING' ? 'Parking' : 'EV charging'];
  if (f.place) chips.push(`Near ${f.place.name}`);
  else if (f.useMyLocation) chips.push('Near you');
  if (f.mode) chips.push(MODE_TEXT[f.mode] ?? f.mode);
  if (f.date) {
    const d = DateTime.fromISO(f.date, { zone: ZONE });
    chips.push(
      `${d.toFormat('ccc d LLL')}${f.from ? `, ${f.from}` : ''}${f.from && f.to ? `–${f.to}` : f.to ? ` until ${f.to}` : ''}`,
    );
  }
  if (f.maxPricePaise != null) chips.push(`Up to ₹${f.maxPricePaise / 100}/${PER[f.mode ?? 'HOURLY']}`);
  if (f.covered) chips.push('Covered');
  for (const s of f.security) chips.push(s === 'CCTV' ? 'CCTV' : s === 'GUARD' ? 'Guard' : 'Gated');
  if (f.evReady) chips.push('EV-ready socket');
  if (f.vehicleClass)
    chips.push(
      `Fits ${f.vehicleClass === 'SUV' || f.vehicleClass === 'MUV' ? f.vehicleClass : f.vehicleClass.toLowerCase()}`,
    );
  if (f.connector) chips.push(CONNECTOR_TEXT[f.connector] ?? f.connector);
  if (f.currentType) chips.push(f.currentType === 'DC' ? 'DC fast' : 'AC');
  if (f.minPowerKw != null) chips.push(`${f.minPowerKw} kW+`);
  return chips;
}

/** Number of filters set beyond the asset type (evaluation and usage metrics). */
export const fieldsUnderstood = (f: SearchFilters) =>
  [
    f.place || f.useMyLocation,
    f.mode,
    f.date,
    f.from,
    f.to,
    f.maxPricePaise != null,
    f.covered,
    f.security.length > 0,
    f.evReady,
    f.vehicleClass,
    f.connector,
    f.currentType,
    f.minPowerKw != null,
  ].filter(Boolean).length;
