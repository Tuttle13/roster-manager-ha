// Pure functions: duty -> Google Calendar event body, and the diff ("sync plan") between the
// reviewed roster and events already in the calendar. No network calls here, so it's unit-testable.

import { DUTY_TYPES, isAllDay, hash } from './model.js';
import { addDays } from './dates.js';
import { tzFor, stampToUtc, utcToZoned } from './tz.js';

export const APP_TAG = 'roster-manager';

function gTime(stamp) {
  if (stamp.basis === 'utc') return { dateTime: `${stamp.dt}:00Z`, timeZone: 'UTC' };
  return { dateTime: `${stamp.dt}:00`, timeZone: tzFor(stamp.port) };
}

// "06:00 BNE (20:00Z)", always showing both local and UTC, never inventing either.
export function describeStamp(stamp) {
  if (!stamp || !stamp.dt) return null;
  const ms = stampToUtc(stamp);
  const tz = tzFor(stamp.port);
  const hhmm = s => s.slice(11, 16);
  const dayNote = (dt, ref) => (ref && dt.slice(0, 10) !== ref ? ` ${dt.slice(8, 10)}/${dt.slice(5, 7)}` : '');
  if (stamp.basis === 'utc') {
    const utc = `${hhmm(stamp.dt)}Z`;
    if (ms != null && tz) { const l = utcToZoned(ms, tz); return `${hhmm(l)} ${stamp.port} local${dayNote(l, stamp.dt.slice(0, 10))} (${utc})`; }
    return utc;
  }
  const local = `${hhmm(stamp.dt)} ${stamp.port || ''} local`.replace('  ', ' ');
  if (ms != null) { const u = new Date(ms).toISOString(); return `${local} (${u.slice(11, 16)}Z${dayNote(u, stamp.dt.slice(0, 10))})`; }
  return local;
}

export function eventTitle(d) {
  const route = d.dep && d.arr ? `${d.dep}–${d.arr}` : (d.dep || '');
  switch (d.type) {
    case 'FLIGHT': return [d.flightNumber, route].filter(Boolean).join(' ') || 'Flight';
    case 'POSITIONING': return `PAX ${[d.flightNumber, route].filter(Boolean).join(' ')}`.trim();
    case 'STANDBY': return `Standby${d.code ? ` (${d.code})` : ''}${d.dep ? ` ${d.dep}` : ''}`;
    case 'RESERVE': return `Reserve${d.code ? ` (${d.code})` : ''}${d.dep ? ` ${d.dep}` : ''}`;
    case 'TRAINING': return `Training${d.code ? ` ${d.code}` : ''}${d.dep ? ` ${d.dep}` : ''}`;
    case 'GROUND': return `Ground duty${d.code ? ` ${d.code}` : ''}${d.dep ? ` ${d.dep}` : ''}`;
    case 'DAY_OFF': return d.code && d.code !== 'OFF' ? `Day off (${d.code})` : 'Day off';
    case 'LEAVE': return `Leave${d.code ? ` (${d.code})` : ''}`;
    default: return d.code || d.notes?.split('\n')[0] || 'Duty';
  }
}

export function eventDescription(d) {
  const lines = [];
  const add = (label, stamp) => { const s = describeStamp(stamp); if (s) lines.push(`${label}: ${s}`); };
  lines.push(DUTY_TYPES[d.type]?.label || d.type);
  if (d.code) lines.push(`Code: ${d.code}`);
  add('Report', d.report);
  if (DUTY_TYPES[d.type]?.sector) { add('Departs', d.start); add('Arrives', d.end); } else { add('Starts', d.start); add('Ends', d.end); }
  add('Actual departure', d.actualStart);
  add('Actual arrival', d.actualEnd);
  add('Duty finish', d.release);
  if (d.aircraft) lines.push(`Aircraft: ${d.aircraft}`);
  if (d.annotations?.length) lines.push(...d.annotations.map(a => `• ${a}`));
  if (d.notes) lines.push('', d.notes);
  lines.push('', 'Managed by Roster Manager. Edits here are overwritten on the next sync.');
  return lines.join('\n');
}

export function buildEvent(d, { allDayBusy = false } = {}) {
  const body = { summary: eventTitle(d), description: eventDescription(d) };
  if (isAllDay(d)) {
    body.start = { date: d.date };
    body.end = { date: addDays(d.date, 1) };
    body.transparency = ['DAY_OFF', 'LEAVE'].includes(d.type) && !allDayBusy ? 'transparent' : 'opaque';
  } else {
    body.start = gTime(d.start);
    body.end = gTime(d.end);
    body.transparency = 'opaque';
  }
  if (d.dep) body.location = DUTY_TYPES[d.type]?.sector ? `${d.dep} Airport` : d.dep;
  const h = hash(body);
  body.extendedProperties = { private: { prmApp: APP_TAG, prmKey: d.key, prmDate: d.date, prmHash: h } };
  return body;
}

// duties: keyed duties (assignKeys) to sync. existing: events from the app calendar.
// period: { start, end } — only existing events dated inside it are candidates for removal.
export function planSync(duties, existing, period, opts = {}) {
  const byKey = new Map();
  const duplicates = [];
  for (const ev of existing) {
    const p = ev.extendedProperties?.private || {};
    if (p.prmApp !== APP_TAG || !p.prmKey) continue;
    if (byKey.has(p.prmKey)) duplicates.push(ev); else byKey.set(p.prmKey, ev);
  }
  const create = []; const update = []; const unchanged = []; const remove = [];
  const seen = new Set();
  for (const d of duties) {
    const body = buildEvent(d, opts);
    const ev = byKey.get(d.key);
    seen.add(d.key);
    if (!ev) create.push({ duty: d, body });
    else if (ev.extendedProperties.private.prmHash !== body.extendedProperties.private.prmHash) update.push({ duty: d, body, event: ev });
    else unchanged.push({ duty: d, event: ev });
  }
  for (const [key, ev] of byKey) {
    if (seen.has(key)) continue;
    const date = ev.extendedProperties.private.prmDate;
    if (date >= period.start && date <= period.end) remove.push({ event: ev, reason: 'no longer on roster' });
  }
  for (const ev of duplicates) {
    const date = ev.extendedProperties.private.prmDate;
    if (date >= period.start && date <= period.end) remove.push({ event: ev, reason: 'duplicate', duplicate: true });
  }
  return { create, update, unchanged, remove };
}
