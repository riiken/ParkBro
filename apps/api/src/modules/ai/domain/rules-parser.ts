import { DateTime } from 'luxon';
import { ZONE, emptyIntent, type SearchIntent } from './search-intent.ts';

/**
 * Deterministic fallback for natural-language search (D-165): used when no model is configured, the budget is spent,
 * or the model fails or answers invalidly. It understands the common phrasings in the evaluation set; anything else
 * is left for the regular filters. Same output contract as the model (SearchIntent).
 */
export function parseSearchText(raw: string, nowMs: number): SearchIntent {
  const original = ` ${raw.replace(/[’']/g, "'").replace(/\s+/g, ' ')} `;
  const text = original.toLowerCase(); // same length, so spans line up with the original
  const has = (re: RegExp) => re.test(text);
  const now = DateTime.fromMillis(nowMs, { zone: ZONE });

  const evReadyParking = /\b(ev[- ]ready|ev socket|charging socket|plug point)\b/;
  const ev =
    !(has(evReadyParking) && has(/\bpark/)) &&
    has(/\b(ev charg\w*|charg(e|er|ers|ing)\b|charge my|kw\b|ccs|type ?2|bharat (ac|dc)|gb\/?t|fast charg)/);
  const intent = emptyIntent(ev ? 'EV_CHARGING' : 'PARKING');

  // Place: "near / in / at / around / close to <words>" up to the next phrase that isn't part of a name.
  const place =
    /\b(?:near|in|at|around|close to|next to|opposite)\s+([a-z][a-z .&-]{1,60}?)(?=\s+(?:(?:tomorrow|today|tonight|from|for|under|below|less|max|with|between|on|by|after|before|this|next|that|which|and|covered|cctv|guarded|gated|every|per|monthly|daily|overnight|all|at|till|until|ccs2?|type|fast|slow|dc|ac|suv|sedan|hatchback|parking|charging|charger|ev|kw|guard|cctv|please)\b|\d)|[,.!?]|\s*$)/d.exec(
      text,
    );
  const NOT_PLACES =
    /^(me|my location|here|the area|this area|night|the night|morning|evening|noon|the morning|the evening)$/;
  const span = place?.indices?.[1];
  if (place?.[1] && span && !NOT_PLACES.test(place[1].trim())) {
    const written = original.slice(span[0], span[1]).trim();
    intent.place = written === written.toLowerCase() ? titleCase(written) : written; // keep "HSR Layout" as typed
  }
  if (has(/\b(near me|nearby|around me|close to me|around here|near here|my location)\b/))
    intent.nearMe = true;

  // Booking type.
  if (ev) intent.mode = has(/\b(session|charge|charging|charger)\b/) ? 'CHARGING_SESSION' : null;
  else if (has(/\b(monthly|per month|a month|every month|for a month|month-long)\b/)) intent.mode = 'MONTHLY';
  else if (has(/\b(overnight|tonight|for the night|night parking|all night)\b/)) intent.mode = 'OVERNIGHT';
  else if (has(/\b(all day|full day|whole day|daily|for the day|per day)\b/)) intent.mode = 'DAILY';
  else if (has(/\b(hourly|per hour|an hour|\d+ ?(hours?|hrs?)|couple of hours)\b/)) intent.mode = 'HOURLY';

  // Date.
  let day: DateTime | null = null;
  if (has(/\bday after tomorrow\b/)) day = now.plus({ days: 2 });
  else if (has(/\btomorrow\b/)) day = now.plus({ days: 1 });
  else if (has(/\b(today|tonight|now|right now)\b/)) day = now;
  const weekday = /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|rsday|urday|r|rs)?\b/.exec(text);
  if (!day && weekday?.[1]) {
    const target = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(weekday[1]) + 1;
    const ahead = (target - now.weekday + 7) % 7 || 7;
    day = now.plus({ days: ahead });
  }
  const months = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${months})[a-z]*\\b`).exec(text);
  const md = new RegExp(`\\b(${months})[a-z]* (\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
  const dmy = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
  if (!day && (dm || md)) {
    const d = Number(dm ? dm[1] : md?.[2]);
    const m = months.split('|').indexOf((dm ? dm[2] : md?.[1]) ?? '') + 1;
    day = upcoming(now, m, d);
  } else if (!day && dmy) {
    day = upcoming(now, Number(dmy[2]), Number(dmy[1]));
  }
  if (day?.isValid) intent.date = day.toISODate();

  // Times: ranges first ("9am to 6pm", "9 to 6 pm", "18:00-21:00", "from 10"), then "for N hours", "at 8", "after 7".
  const T = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
  const range = new RegExp(String.raw`\b(?:from |between )?${T}\s*(?:to|-|–|till|until|and)\s*${T}`).exec(
    text,
  );
  const words = { noon: '12:00', midnight: '00:00' } as const;
  if (range && (range[3] || range[6] || range[2] || range[5])) {
    const endMer = range[6]?.[0];
    const startMer = range[3]?.[0] ?? (endMer === 'p' && Number(range[1]) > Number(range[4]) ? 'a' : endMer);
    intent.from = clock(Number(range[1]), Number(range[2] ?? 0), startMer);
    intent.to = clock(Number(range[4]), Number(range[5] ?? 0), endMer);
  } else {
    const single = new RegExp(String.raw`\b(?:at|from|after|by|starting) ${T}`).exec(text);
    if (single && (single[3] || single[2] || /\b(at|from) \d/.test(text)))
      intent.from = clock(Number(single[1]), Number(single[2] ?? 0), single[3]?.[0]);
    for (const [word, value] of Object.entries(words))
      if (has(new RegExp(`\\b(at|from) ${word}\\b`))) intent.from = value;
    const hours = /\bfor (\d{1,2}|an|one|two|three|four|five|six) ?(hours?|hrs?)\b/.exec(text);
    if (intent.from && hours?.[1]) {
      const n = { an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[hours[1]] ?? Number(hours[1]);
      const end = DateTime.fromISO(`2000-01-01T${intent.from}`).plus({ hours: n });
      intent.to = end.toFormat('HH:mm');
    }
  }
  if (intent.from === null && intent.to === null) {
    if (has(/\bright now\b|\bnow\b/)) intent.from = roundUp(now).toFormat('HH:mm');
  }

  // Price.
  const price =
    /(?:under|below|less than|max(?:imum)?|upto|up to|within|budget(?: of)?|<)\s*(?:rs\.?|inr|₹)?\s*(\d{2,6})\b/.exec(
      text,
    );
  if (price?.[1]) intent.maxPriceRupees = Number(price[1]);

  // Parking features.
  if (has(/\b(covered|indoor|basement|stilt|shaded|under a roof|roofed)\b/)) intent.covered = true;
  if (has(/\bcctv|camera/)) intent.security.push('CCTV');
  if (has(/\b(guard|guarded|security guard|watchman)\b/)) intent.security.push('GUARD');
  if (has(/\b(gated|gate)\b/)) intent.security.push('GATED');
  if (!ev && has(evReadyParking)) intent.evReady = true;
  if (has(/\b(suv|xuv|fortuner|creta)\b/)) intent.vehicleClass = 'SUV';
  else if (has(/\b(muv|innova|ertiga|7[- ]seater)\b/)) intent.vehicleClass = 'MUV';
  else if (has(/\b(sedan|city|verna|dzire)\b/)) intent.vehicleClass = 'SEDAN';
  else if (has(/\b(hatchback|hatch|swift|i10|i20|alto)\b/)) intent.vehicleClass = 'HATCHBACK';

  // Charging.
  if (has(/\bccs ?2?\b/)) intent.connector = 'CCS2';
  else if (has(/\btype ?2\b/)) intent.connector = 'TYPE2';
  else if (has(/\bbharat ?dc/)) intent.connector = 'BHARAT_DC001';
  else if (has(/\bbharat ?ac/)) intent.connector = 'BHARAT_AC001';
  else if (has(/\b(gb\/?t)\b/)) intent.connector = 'GBT';
  else if (ev && has(/\b(15 ?a|3[- ]pin|home socket|normal socket)\b/)) intent.connector = 'IEC_15A';
  if (ev && has(/\b(dc|fast|rapid|quick)\b/)) intent.currentType = 'DC';
  else if (ev && has(/\b(ac|slow)\b/)) intent.currentType = 'AC';
  const kw = /\b(\d{1,3}(?:\.\d)?) ?kw\b/.exec(text);
  if (ev && kw?.[1]) intent.minPowerKw = Number(kw[1]);

  // Two-wheelers and other things the pilot doesn't list (D-005) are reported, not guessed.
  const unsupported =
    /\b(bike|scooter|two[- ]wheeler|motorcycle|truck|bus|tempo|valet|car wash|washing)\b/.exec(text);
  if (unsupported?.[1]) intent.notUnderstood.push(unsupported[1]);
  return intent;
}

function clock(hour: number, minute: number, meridiem: string | undefined): string | null {
  if (hour > 23 || minute > 59) return null;
  let h = hour;
  if (meridiem === 'p' && h < 12) h += 12;
  if (meridiem === 'a' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function upcoming(now: DateTime, month: number, day: number): DateTime | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let d = DateTime.fromObject({ year: now.year, month, day }, { zone: ZONE });
  if (!d.isValid) return null;
  if (d < now.startOf('day')) d = d.plus({ years: 1 });
  return d;
}

const roundUp = (t: DateTime) => t.plus({ minutes: 15 - (t.minute % 15) }).startOf('minute');

/** "mg road" → "MG Road": two-letter words are usually initials in Indian place names. */
const titleCase = (s: string) =>
  s
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : `${w.charAt(0).toUpperCase()}${w.slice(1)}`))
    .join(' ');
