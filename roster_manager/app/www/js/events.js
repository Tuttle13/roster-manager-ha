// Pure functions: duty -> Google Calendar event body, and the diff ("sync plan") between the
// reviewed roster and events already in the calendar. No network calls here, so it's unit-testable.

import { DUTY_TYPES, isAllDay, hash, sortDuties } from './model.js';
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

// ---------------- Roster Buster-style events ----------------
// Each kind of event goes in its own Google calendar, so apps like Pocket Informant can give each
// one its own colour. Titles and icons stay Roster Buster-style.
export const CATEGORIES = {
  day: { name: 'VA Day Duty' },        // flight duties ending at home base (incl. last day of a trip)
  trip: { name: 'VA Trips' },          // flight duties ending away from base, and their layovers
  standby: { name: 'VA Standby' },
  off: { name: 'VA Days Off' },        // days off, blank days, annual leave, sick
  sim: { name: 'VA Sim' },             // simulator sessions and checks
  ground: { name: 'VA Ground' },       // everything else
};

const SIM_RX = /\b(SIM|SIMULATOR|LOFT|LPC|OPC|FFS|CHECK|PROFICIENCY|IPC|EVAL)\b|^SIM/i;
export function isSim(d) { return SIM_RX.test(d.code || '') || SIM_RX.test(d.notes || ''); }
export function isSick(d) { return /^(SL|SICK)/i.test(d.code || '') || /\bsick\b/i.test(d.notes || ''); }

export function categoryOf(d) {
  if (d.type === 'DAY_OFF' || d.type === 'LEAVE' || (d.type === 'OTHER' && /^BLANK$/i.test(d.code || ''))) return 'off';
  if (d.type === 'STANDBY' || d.type === 'RESERVE') return 'standby';
  if (d.type === 'TRAINING' && isSim(d)) return 'sim';
  return 'ground';
}
const ICON = { flight: '✈️', layover: '💼', home: '🏠', standby: '⏱️', training: '📚', leave: '🌴', sick: '🤒', other: '📋' };

function t(opts, icon, text) { return opts.emoji === false ? text : `${ICON[icon]} ${text}`; }

export function rbTitle(d, opts = {}) {
  const code = (d.code || '').trim();
  switch (d.type) {
    case 'DAY_OFF': return t(opts, 'home', `Day off${code ? ` - ${code}` : ''}`);
    case 'LEAVE':
      if (isSick(d)) return t(opts, 'sick', 'Sick Leave');
      return t(opts, 'leave', /^AL/i.test(code) || /annual/i.test(d.notes || '') ? 'Annual Leave' : `Leave${code ? ` - ${code}` : ''}`);
    case 'STANDBY': return t(opts, 'standby', 'Standby Duty');
    case 'RESERVE': return t(opts, 'standby', 'Reserve Duty');
    case 'TRAINING': return t(opts, 'training', `Training${code ? ` - ${code}` : ''}`);
    case 'GROUND': return t(opts, 'other', `Ground duty${code ? ` - ${code}` : ''}`);
    default:
      if (/^BLANK$/i.test(code)) return t(opts, 'home', 'Blank day');
      return t(opts, 'other', code || 'Duty');
  }
}

function isHomeLike(d) { return d.type === 'DAY_OFF' || (d.type === 'OTHER' && /^BLANK$/i.test(d.code || '')); }

function sectorLine(d) {
  const hm = s => (s && s.dt ? s.dt.slice(11, 16) : '--:--');
  const pax = d.type === 'POSITIONING' ? ' (PAX)' : '';
  return `${d.flightNumber || '—'}${pax}  ${d.dep} ${hm(d.start)} → ${d.arr} ${hm(d.end)}${d.aircraft ? `  ${d.aircraft}` : ''}`;
}

// Sectors that form one duty: same roster day, ports chain on, and no sign-off/report in between.
export function groupSectors(sorted) {
  const groups = [];
  let g = null;
  for (const d of sorted) {
    const sector = DUTY_TYPES[d.type]?.sector;
    if (!sector) { g = null; continue; }
    const prev = g && g[g.length - 1];
    const startsNew = !g || prev.date !== d.date || (prev.release && prev.release.dt) || (d.report && d.report.dt) || (prev.arr && d.dep && prev.arr !== d.dep);
    if (startsNew) { g = [d]; groups.push(g); } else g.push(d);
  }
  return groups;
}

function hoursText(ms) {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} hours`;
}

function finish(body, key, date, cat) {
  const h = hash(body);
  body.extendedProperties = { private: { prmApp: APP_TAG, prmKey: key, prmDate: date, prmHash: h } };
  return { key, date, body, cat };
}

export function buildEvent(d, opts = {}) {
  const body = { summary: rbTitle(d, opts), description: eventDescription(d) };
  if (isAllDay(d)) {
    body.start = { date: d.date };
    body.end = { date: addDays(d.date, 1) };
    body.transparency = (['DAY_OFF', 'LEAVE'].includes(d.type) || isHomeLike(d)) && !opts.allDayBusy ? 'transparent' : 'opaque';
  } else {
    body.start = gTime(d.start);
    body.end = gTime(d.end);
    body.transparency = 'opaque';
  }
  if (d.dep) body.location = d.dep;
  return finish(body, d.key, d.date, categoryOf(d)).body;
}

function flightGroupEvent(g, opts) {
  const first = g[0]; const last = g[g.length - 1];
  const ports = [first.dep, ...g.map(x => x.arr)].filter(Boolean);
  const allPax = g.every(x => x.type === 'POSITIONING');
  const report = g.find(x => x.report?.dt)?.report || null;
  const release = [...g].reverse().find(x => x.release?.dt)?.release || null;
  const span = opts.flightSpan === 'flying' ? 'flying' : 'duty';
  const start = span === 'duty' && report ? report : first.start;
  const end = span === 'duty' && release ? release : last.end;
  const lines = [];
  if (report) lines.push(`Report: ${describeStamp(report)}`);
  lines.push(...g.map(sectorLine));
  if (release) lines.push(`Sign off: ${describeStamp(release)}`);
  const extras = [...new Set(g.flatMap(x => (x.notes || '').split('\n')).filter(Boolean))];
  if (extras.length) lines.push('', ...extras);
  lines.push('', 'Times are local to each airport.', 'Managed by Roster Manager. Edits here are overwritten on the next sync.');
  const body = {
    summary: t(opts, 'flight', `${allPax ? 'PAX ' : ''}${ports.join(' ')}`),
    description: lines.join('\n'),
    start: gTime(start), end: gTime(end), transparency: 'opaque', location: first.dep,
  };
  return { body, first, last, start, end };
}

// All calendar events for a roster: grouped flight duties, layovers, and the other duties.
export function buildEventList(duties, opts = {}) {
  const home = (opts.homeBase || 'MEL').toUpperCase();
  const sorted = sortDuties(duties);
  const out = []; const used = new Map();
  const uniq = k => { const n = (used.get(k) || 0) + 1; used.set(k, n); return n === 1 ? k : `${k}#${n}`; };

  const flightGroups = groupSectors(sorted).map(g => flightGroupEvent(g, opts));
  for (const fg of flightGroups) {
    const k = uniq(['F', fg.first.date, (fg.first.flightNumber || '').toUpperCase(), (fg.first.dep || '').toUpperCase()].join('|'));
    out.push(finish(fg.body, k, fg.first.date, (fg.last.arr || '').toUpperCase() === home ? 'day' : 'trip'));
  }
  // Layovers: a flight duty ending away from base, followed by one departing from that port.
  for (let i = 0; i < flightGroups.length - 1; i++) {
    const a = flightGroups[i]; const b = flightGroups[i + 1];
    const port = (a.last.arr || '').toUpperCase();
    if (!port || port === home || (b.first.dep || '').toUpperCase() !== port) continue;
    const from = a.end; const to = b.start;
    const fu = stampToUtc(from); const tu = stampToUtc(to);
    if (fu == null || tu == null || tu <= fu) continue;
    const body = {
      summary: t(opts, 'layover', `Layover (${hoursText(tu - fu)})`),
      description: `Layover in ${port}\nFrom: ${describeStamp(from)}\nTo: ${describeStamp(to)}${a.last.notes && /Hotel:/.test(a.last.notes) ? `\n${a.last.notes.split('\n').find(l => l.startsWith('Hotel:'))}` : ''}\n\nManaged by Roster Manager.`,
      start: gTime(from), end: gTime(to), transparency: 'opaque', location: port,
    };
    out.push(finish(body, uniq(`L|${a.last.date}|${port}`), a.last.date, 'trip'));
  }
  for (const d of sorted) {
    if (DUTY_TYPES[d.type]?.sector) continue;
    const t2 = DUTY_TYPES[d.type] || DUTY_TYPES.OTHER;
    const k = uniq([t2.short, d.date, (d.code || '').toUpperCase(), ''].join('|'));
    out.push({ key: k, date: d.date, body: buildEvent({ ...d, key: k }, opts), cat: categoryOf(d) });
  }
  return out;
}

// duties: the reviewed roster. existing: events from the app calendar.
// period: { start, end }. Only existing events dated inside it are candidates for removal.
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
  for (const e of buildEventList(duties, opts)) {
    const ev = byKey.get(e.key);
    seen.add(e.key);
    const calendarId = opts.calFor ? opts.calFor(e.cat) : undefined;
    const item = { duty: { date: e.date }, body: e.body, key: e.key, cat: e.cat, calendarId };
    const moved = ev && calendarId && ev.calendarId && ev.calendarId !== calendarId;
    if (!ev) create.push(item);
    else if (moved || ev.extendedProperties.private.prmHash !== e.body.extendedProperties.private.prmHash) update.push({ ...item, event: ev, moved: !!moved });
    else unchanged.push({ ...item, event: ev });
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
