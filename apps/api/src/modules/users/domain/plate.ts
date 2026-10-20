/**
 * Indian registration plates (V-VEHICLE-FMT): state series (e.g. KA01AB1234, DL3CAB1234) and Bharat series
 * (22BH1234AA). Normalised to upper case without spaces or dashes; null when invalid.
 */
const STATE_SERIES = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
const BHARAT_SERIES = /^\d{2}BH\d{4}[A-Z]{1,2}$/;

export function normalizePlate(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s\-.]/g, '');
  if (compact.length < 6 || compact.length > 11) return null;
  if (BHARAT_SERIES.test(compact)) return compact;
  if (STATE_SERIES.test(compact) && /\d{4}$/.test(compact)) return compact;
  return null;
}

/** Display form for hosts during a booking: "KA 01 AB 1234". */
export function formatPlate(plate: string): string {
  const bh = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/.exec(plate);
  if (bh) return bh.slice(1).join(' ');
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/.exec(plate);
  return m ? m.slice(1).filter(Boolean).join(' ') : plate;
}
