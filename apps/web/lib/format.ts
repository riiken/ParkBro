/** Display helpers for discovery (ux-architecture §4). Prices are integer paise. */
const UNIT_LABEL: Record<string, string> = {
  PER_HOUR: '/hour',
  PER_DAY: '/day',
  PER_NIGHT: '/night',
  PER_MONTH: '/month',
  PER_SESSION: '/session',
};

export const MODE_LABEL: Record<string, string> = {
  HOURLY: 'Hourly',
  DAILY: 'Daily',
  OVERNIGHT: 'Overnight',
  MONTHLY: 'Monthly',
  CHARGING_SESSION: 'Charging',
};

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function formatPrice(pricePaise: number, unit: string): string {
  return `${rupees.format(pricePaise / 100)}${UNIT_LABEL[unit] ?? ''}`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `~${meters} m` : `~${(meters / 1000).toFixed(1)} km`;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Mon–Fri", "Sat, Sun", "Every day" from ISO weekdays. */
export function formatWeekdays(weekdays: number[]): string {
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Every day';
  const runs: number[][] = [];
  for (const d of sorted) {
    const last = runs.at(-1);
    if (last && d === (last.at(-1) ?? 0) + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) =>
      r.length >= 3
        ? `${DAYS[(r[0] ?? 1) - 1]}–${DAYS[(r.at(-1) ?? 1) - 1]}`
        : r.map((d) => DAYS[d - 1]).join(', '),
    )
    .join(', ');
}

export function formatWindow(start: string, end: string): string {
  return start === end ? 'all day' : `${start}–${end}${end <= start ? ' (next day)' : ''}`;
}

export const LEVEL_LABEL: Record<string, string> = {
  BASEMENT: 'Basement',
  STILT: 'Stilt',
  GROUND: 'Ground level',
  OPEN_LOT: 'Open lot',
  MULTI_LEVEL: 'Multi-level',
};

export const VEHICLE_LABEL: Record<string, string> = {
  HATCHBACK: 'Hatchback',
  SEDAN: 'Sedan',
  SUV: 'SUV',
  MUV: 'MUV / 7-seater',
};

export const CONNECTOR_LABEL: Record<string, string> = {
  TYPE2: 'Type 2',
  CCS2: 'CCS2',
  BHARAT_AC001: 'Bharat AC-001',
  BHARAT_DC001: 'Bharat DC-001',
  IEC_15A: '15A socket',
  GBT: 'GB/T',
};

/** Charging speed label (matches the API's speed classes, charging/domain/session.ts). */
export function chargingSpeed(currentType: string, powerKw: number): string {
  if (currentType === 'DC') return 'Rapid DC charging';
  return powerKw >= 7 ? 'Fast AC charging' : 'Slow charging';
}
