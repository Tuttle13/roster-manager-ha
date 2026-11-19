// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPeriod, validatePeriod, periodEnd } from '../roster_manager/app/www/js/dates.js';
import { zonedToUtc, utcToZoned, stampToUtc, tzFor } from '../roster_manager/app/www/js/tz.js';
import { newDuty, assignKeys, validateDuty } from '../roster_manager/app/www/js/model.js';
import { planSync, describeStamp } from '../roster_manager/app/www/js/events.js';

test('28-day default follows the last capture (spec example)', () => {
  assert.deepEqual(defaultPeriod({ start: '2026-12-01', end: '2026-12-28' }), { start: '2026-12-29', end: '2027-01-25' });
  assert.equal(periodEnd('2026-02-01'), '2026-02-28');
});

test('period validation', () => {
  assert.ok(validatePeriod('2026-12-10', '2026-12-01').errors.length);
  assert.ok(validatePeriod('2026-12-01', '2027-03-01').errors.length);
  const last = { start: '2026-12-01', end: '2026-12-28' };
  const v = validatePeriod('2026-12-29', '2027-01-25', { lastCapture: last, today: '2026-12-20' });
  assert.deepEqual(v, { errors: [], warnings: [] });
  const overlap = validatePeriod('2026-12-15', '2027-01-11', { lastCapture: last, today: '2026-12-20' });
  assert.match(overlap.warnings.join(' '), /Overlaps/);
  assert.ok(validatePeriod('2026-02-30', '2026-03-10').errors.length, 'invalid date rejected');
});

test('time zones incl. DST and no-DST ports', () => {
  // Sydney in summer is UTC+11, Brisbane is always UTC+10
  assert.equal(new Date(zonedToUtc('2026-12-01T06:00', 'Australia/Sydney')).toISOString(), '2026-11-30T19:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-12-01T06:00', 'Australia/Brisbane')).toISOString(), '2026-11-30T20:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-07-01T06:00', 'Australia/Sydney')).toISOString(), '2026-06-30T20:00:00.000Z');
  assert.equal(utcToZoned(Date.parse('2026-11-30T19:00:00Z'), 'Australia/Perth'), '2026-12-01T03:00');
  assert.equal(stampToUtc({ dt: '2026-12-01T06:00', basis: 'utc' }), Date.parse('2026-12-01T06:00:00Z'));
  assert.equal(tzFor('xyz'), null);
});

const flight = (over = {}) => newDuty({
  type: 'FLIGHT', date: '2026-12-01', flightNumber: 'VA923', dep: 'BNE', arr: 'SYD',
  start: { dt: '2026-12-01T06:00', basis: 'local', port: 'BNE' }, end: { dt: '2026-12-01T08:30', basis: 'local', port: 'SYD' },
  report: { dt: '2026-12-01T05:00', basis: 'local', port: 'BNE' }, ...over,
});

test('duty validation catches impossible times and unknown ports, never invents', () => {
  assert.deepEqual(validateDuty(flight()).errors, []);
  // BNE 06:00 (20:00Z) -> SYD 06:30 (19:30Z) arrives before departing
  assert.ok(validateDuty(flight({ end: { dt: '2026-12-01T06:30', basis: 'local', port: 'SYD' } })).errors.length);
  assert.match(validateDuty(flight({ arr: 'QQQ', end: { dt: '2026-12-01T08:30', basis: 'local', port: 'QQQ' } })).errors.join(), /Unknown time zone for QQQ/);
  assert.ok(validateDuty(flight({ start: null })).errors.length, 'sector without times is an error');
  const off = newDuty({ type: 'DAY_OFF', date: '2026-12-02' });
  assert.deepEqual(validateDuty(off).errors, []);
});

const F2 = (n, date, dep, arr, s, e, extra = {}) => newDuty({ type: 'FLIGHT', date, flightNumber: n, dep, arr,
  start: { dt: `${date}T${s}`, basis: 'local', port: dep }, end: { dt: `${date}T${e}`, basis: 'local', port: arr }, ...extra });

test('RB-style events: one event per flight duty, layover, day off, blank, standby', async () => {
  const { buildEventList } = await import('../roster_manager/app/www/js/events.js');
  const L = (date, t, port) => ({ dt: `${date}T${t}`, basis: 'local', port });
  const duties = [
    F2('VA309', '2026-12-01', 'MEL', 'BNE', '07:12', '08:33', { report: L('2026-12-01', '06:10', 'MEL') }),
    F2('VA510', '2026-12-01', 'BNE', 'SYD', '09:30', '11:00'),
    F2('VA911', '2026-12-01', 'SYD', 'OOL', '12:00', '13:15', { release: L('2026-12-01', '13:45', 'OOL') }),
    F2('VA912', '2026-12-02', 'OOL', 'MEL', '07:00', '09:30', { report: L('2026-12-02', '06:00', 'OOL'), release: L('2026-12-02', '10:00', 'MEL') }),
    newDuty({ type: 'DAY_OFF', date: '2026-12-03', code: 'DDO' }),
    newDuty({ type: 'OTHER', date: '2026-12-04', code: 'BLANK' }),
    newDuty({ type: 'STANDBY', date: '2026-12-05', code: 'SBY03', dep: 'MEL', start: L('2026-12-05', '03:00', 'MEL'), end: L('2026-12-05', '05:20', 'MEL') }),
  ];
  const ev = buildEventList(duties);
  const titles = ev.map(e => e.body.summary);
  assert.deepEqual(titles, ['✈️ MEL BNE SYD OOL', '✈️ OOL MEL', '💼 Layover (16:15 hours)', '🏠 Day off - DDO', '🏠 Blank day', '⏱️ Standby Duty']);
  const trip = ev[0].body;
  assert.deepEqual(trip.start, { dateTime: '2026-12-01T06:10:00', timeZone: 'Australia/Melbourne' }, 'starts at report');
  assert.deepEqual(trip.end, { dateTime: '2026-12-01T13:45:00', timeZone: 'Australia/Brisbane' }, 'ends at sign off (OOL is Queensland time)');
  assert.match(trip.description, /VA510  BNE 09:30 → SYD 11:00/);
  const lay = ev[2].body;
  assert.equal(lay.location, 'OOL');
  assert.deepEqual([lay.start.dateTime, lay.end.dateTime], ['2026-12-01T14:15:00', '2026-12-01T17:15:00'], 'short block: 30 min after sign-off, 3 h');
  assert.match(lay.description, /Sign off: 13:45 OOL local[\s\S]*Next report: 06:00 OOL local/);
  const full = buildEventList(duties, { layoverStyle: 'full' }).find(e => /Layover/.test(e.body.summary)).body;
  assert.deepEqual([full.start.dateTime, full.end.dateTime], ['2026-12-01T13:45:00', '2026-12-02T06:00:00']);
  for (const e of buildEventList(duties)) assert.doesNotMatch(e.body.description, /Managed by Roster Manager/);
  assert.deepEqual(ev[3].body.start, { date: '2026-12-03' });
  assert.equal(new Set(ev.map(e => e.key)).size, ev.length, 'unique keys');
  const flying = buildEventList(duties, { flightSpan: 'flying', emoji: false });
  assert.equal(flying[0].body.summary, 'MEL BNE SYD OOL');
  assert.equal(flying[0].body.start.dateTime, '2026-12-01T07:12:00');
  assert.equal(buildEventList(duties.slice(0, 3), { homeBase: 'OOL' }).filter(e => /Layover/.test(e.body.summary)).length, 0);
});

test('sync plan: create, update on retime, unchanged, removal only inside period, duplicates', () => {
  const period = { start: '2026-12-01', end: '2026-12-28' };
  const asExisting = (body, id) => ({ id, summary: body.summary, extendedProperties: body.extendedProperties });
  const r1 = [F2('VA923', '2026-12-01', 'BNE', 'SYD', '06:00', '08:30'), newDuty({ type: 'DAY_OFF', date: '2026-12-02', code: 'OFF' })];
  const p1 = planSync(r1, [], period);
  assert.equal(p1.create.length, 2);
  const existing = p1.create.map((x, i) => asExisting(x.body, `e${i}`));
  const p2 = planSync(r1, existing, period);
  assert.deepEqual([p2.create.length, p2.unchanged.length, p2.remove.length], [0, 2, 0]);
  // flight retimed, day off removed, an old event outside the period, a duplicate
  const r2 = [F2('VA923', '2026-12-01', 'BNE', 'SYD', '07:00', '09:30')];
  const outside = asExisting({ summary: 'old', extendedProperties: { private: { prmApp: 'roster-manager', prmKey: 'F|2026-11-20|VA1|BNE', prmDate: '2026-11-20', prmHash: 'x' } } }, 'old');
  const p3 = planSync(r2, [...existing, outside, { ...existing[0], id: 'dup' }], period);
  assert.equal(p3.update.length, 1); assert.equal(p3.update[0].event.id, 'e0');
  assert.deepEqual(p3.remove.map(r => r.event.id).sort(), ['dup', 'e1']);
  assert.ok(p3.remove.find(r => r.event.id === 'dup').duplicate);
});

test('ordinal keys when the same duty code appears twice in a day', () => {
  const s = (t) => newDuty({ type: 'STANDBY', date: '2026-12-05', code: 'SBY', dep: 'BNE', start: { dt: `2026-12-05T${t}`, basis: 'local', port: 'BNE' }, end: { dt: `2026-12-05T${t.replace(/^0(\d)/, (m, h) => `1${h}`)}`, basis: 'local', port: 'BNE' } });
  const keys = assignKeys([s('08:00'), s('02:00')]).map(d => d.key);
  assert.deepEqual(keys, ['S|2026-12-05|SBY|', 'S|2026-12-05|SBY|#2']);
});

test('roster cycle: anchor 21 Dec 2026, published 10 days before (Friday)', async () => {
  const { latestPublished, nextPublication, defaultPeriod: dp } = await import('../roster_manager/app/www/js/dates.js');
  const A = '2026-12-21';
  assert.deepEqual(latestPublished(A, '2026-11-19'), { start: '2026-11-23', end: '2026-12-20', publish: '2026-11-13' });
  assert.deepEqual(nextPublication(A, '2026-11-19'), { start: '2026-12-21', end: '2027-01-17', publish: '2026-12-11' });
  assert.equal(new Date('2026-12-11T00:00:00Z').getUTCDay(), 5, 'publish day is a Friday');
  assert.deepEqual(latestPublished(A, '2026-12-11').start, '2026-12-21', 'publish day targets the new roster');
  assert.deepEqual(latestPublished(A, '2026-12-10').start, '2026-11-23');
  assert.deepEqual(nextPublication(A, '2027-01-10'), { start: '2027-02-15', end: '2027-03-14', publish: '2027-02-05' });
  assert.deepEqual(dp(null, A, '2026-11-19'), { start: '2026-11-23', end: '2026-12-20' });
  assert.deepEqual(dp({ start: '2026-11-23', end: '2026-12-20' }, A, '2026-11-25'), { start: '2026-12-21', end: '2027-01-17' });
});

test('calendar bins: day duty, trip (+layover), standby, days off, sim, ground', async () => {
  const { buildEventList } = await import('../roster_manager/app/www/js/events.js');
  const L = (date, t, port) => ({ dt: `${date}T${t}`, basis: 'local', port });
  const duties = [
    F2('VA531', '2026-12-01', 'MEL', 'OOL', '07:00', '09:30', { report: L('2026-12-01', '06:00', 'MEL'), release: L('2026-12-01', '09:45', 'OOL') }),
    F2('VA532', '2026-12-02', 'OOL', 'MEL', '07:00', '09:30', { report: L('2026-12-02', '06:00', 'OOL'), release: L('2026-12-02', '10:00', 'MEL') }),
    newDuty({ type: 'STANDBY', date: '2026-12-03', code: 'SBY03', dep: 'MEL', start: L('2026-12-03', '03:00', 'MEL'), end: L('2026-12-03', '11:00', 'MEL') }),
    newDuty({ type: 'DAY_OFF', date: '2026-12-04', code: 'PDO' }),
    newDuty({ type: 'OTHER', date: '2026-12-05', code: 'BLANK' }),
    newDuty({ type: 'LEAVE', date: '2026-12-06', code: 'ALVA', notes: 'ALVA: Annual leave' }),
    newDuty({ type: 'LEAVE', date: '2026-12-07', code: 'SL', notes: 'SL: Sick leave' }),
    newDuty({ type: 'TRAINING', date: '2026-12-08', code: 'SIM1', dep: 'MEL', start: L('2026-12-08', '09:00', 'MEL'), end: L('2026-12-08', '13:00', 'MEL') }),
    newDuty({ type: 'TRAINING', date: '2026-12-09', code: 'RTP6-26_A', dep: 'MEL', notes: 'RTP6-26_A: Recurrent ground school', start: L('2026-12-09', '09:00', 'MEL'), end: L('2026-12-09', '13:00', 'MEL') }),
  ];
  const got = buildEventList(duties).map(e => `${e.cat}: ${e.body.summary}`);
  assert.deepEqual(got, [
    'trip: ✈️ MEL OOL', 'day: ✈️ OOL MEL', 'trip: 💼 Layover (20:15 hours)',
    'standby: ⏱️ Standby Duty', 'off: 🏠 Day off - PDO', 'off: 🏠 Blank day', 'off: 🌴 Annual Leave', 'off: 🤒 Sick Leave',
    'sim: 📚 Training - SIM1', 'ground: 📚 Training - RTP6-26_A',
  ]);
  assert.ok(buildEventList(duties).every(e => !e.body.colorId), 'calendar colours decide, not per-event colours');
});
