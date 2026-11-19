// Duty data model, validation and stable keys used to match calendar events across captures.
//
// Duty shape:
// {
//   id, type, date: 'YYYY-MM-DD' (roster day the duty belongs to),
//   code,           // roster duty code as shown (e.g. 'SBY', 'OFF', 'TRG'), optional
//   flightNumber,   // e.g. 'VA123' (flights/positioning)
//   dep, arr,       // IATA ports
//   start, end,     // stamps: departure/arrival for flights, start/finish for other duties
//   report, release,// stamps: report time and duty finish time, if shown
//   actualStart, actualEnd, // stamps: actual times, if shown
//   aircraft, notes, annotations: [],
//   source: 'parsed' | 'manual', edited: bool, raw: 'source text it came from'
// }
// stamp = { dt: 'YYYY-MM-DDTHH:MM', basis: 'local' | 'utc', port: 'BNE' }

import { parseDate } from './dates.js';
import { stampToUtc, tzFor } from './tz.js';

export const DUTY_TYPES = {
  FLIGHT: { label: 'Flight', short: 'F', timed: true, sector: true },
  POSITIONING: { label: 'Positioning (PAX)', short: 'P', timed: true, sector: true },
  STANDBY: { label: 'Standby', short: 'S', timed: true },
  RESERVE: { label: 'Reserve', short: 'R', timed: true },
  TRAINING: { label: 'Training', short: 'T', timed: true },
  GROUND: { label: 'Ground duty', short: 'G', timed: true },
  DAY_OFF: { label: 'Day off', short: 'O', allDay: true },
  LEAVE: { label: 'Leave', short: 'L', allDay: true },
  OTHER: { label: 'Other', short: 'X', timed: true },
};

export function newDuty(partial = {}) {
  return {
    id: crypto.randomUUID(), type: 'FLIGHT', date: '', code: '', flightNumber: '', dep: '', arr: '',
    start: null, end: null, report: null, release: null, actualStart: null, actualEnd: null,
    aircraft: '', notes: '', annotations: [], source: 'manual', edited: false, raw: '',
    ...partial,
  };
}

function stampPorts(d) {
  return ['start', 'end', 'report', 'release', 'actualStart', 'actualEnd']
    .map(k => d[k]).filter(s => s && s.dt && s.basis === 'local').map(s => s.port);
}

export function isAllDay(d) {
  const t = DUTY_TYPES[d.type] || DUTY_TYPES.OTHER;
  if (t.allDay) return true;
  return !(d.start && d.start.dt && d.end && d.end.dt); // no times shown -> all-day, never invented
}

// Returns { errors, warnings } for one duty.
export function validateDuty(d, period) {
  const errors = [];
  const warnings = [];
  const t = DUTY_TYPES[d.type];
  if (!t) errors.push(`Unknown duty type "${d.type}".`);
  if (!parseDate(d.date)) errors.push('Missing or invalid date.');
  else if (period && (d.date < period.start || d.date > period.end)) warnings.push('Date is outside the selected period.');
  if (t && t.sector) {
    if (!d.flightNumber) warnings.push('No flight number.');
    if (!d.dep || !d.arr) errors.push('Departure and arrival airports are required for a sector.');
    if (!(d.start && d.start.dt) || !(d.end && d.end.dt)) errors.push('Departure and arrival times are required for a sector.');
  }
  for (const p of new Set(stampPorts(d))) {
    if (!p) errors.push('A local time has no airport to set its time zone.');
    else if (!tzFor(p)) errors.push(`Unknown time zone for ${p}. Add it under Settings → Airport time zones.`);
  }
  if (!isAllDay(d) && !errors.length) {
    const s = stampToUtc(d.start);
    const e = stampToUtc(d.end);
    if (s == null || e == null) errors.push('Could not resolve start/end time.');
    else if (e <= s) errors.push('Ends before (or when) it starts.');
    else if (e - s > 20 * 3600000) warnings.push('Longer than 20 hours. Check the times.');
  }
  return { errors, warnings };
}

export function validateRoster(duties, period) {
  const results = new Map();
  let errors = 0; let warnings = 0;
  for (const d of duties) {
    const r = validateDuty(d, period);
    results.set(d.id, r);
    errors += r.errors.length; warnings += r.warnings.length;
  }
  return { results, errors, warnings };
}

export function sortDuties(duties) {
  const k = d => {
    const u = isAllDay(d) ? null : stampToUtc(d.start);
    return `${d.date}|${u == null ? '0' : String(u).padStart(15, '0')}`;
  };
  return [...duties].sort((a, b) => k(a).localeCompare(k(b)));
}

// Stable key for matching a duty to the calendar event created for it on a previous capture.
// Times are deliberately NOT part of the key, so a retimed flight updates its event instead of
// creating a new one. A changed flight number or departure port is treated as a different duty.
export function assignKeys(duties) {
  const counts = new Map();
  return sortDuties(duties).map(d => {
    const t = DUTY_TYPES[d.type] || DUTY_TYPES.OTHER;
    const ident = t.sector ? (d.flightNumber || '').toUpperCase().replace(/\s+/g, '') : (d.code || '').toUpperCase();
    const base = [t.short, d.date, ident, t.sector ? (d.dep || '').toUpperCase() : ''].join('|');
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return { ...d, key: n === 1 ? base : `${base}#${n}` };
  });
}

// Small deterministic hash (FNV-1a) used to tell whether an event's content changed.
export function hash(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
