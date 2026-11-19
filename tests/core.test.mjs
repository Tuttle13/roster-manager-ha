// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPeriod, validatePeriod, periodEnd } from '../roster_manager/app/www/js/dates.js';
import { zonedToUtc, utcToZoned, stampToUtc, tzFor } from '../roster_manager/app/www/js/tz.js';
import { newDuty, assignKeys, validateDuty } from '../roster_manager/app/www/js/model.js';
import { buildEvent, planSync, describeStamp } from '../roster_manager/app/www/js/events.js';

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

test('event body: local time zones, title, hidden key', () => {
  const [d] = assignKeys([flight()]);
  const ev = buildEvent(d);
  assert.equal(ev.summary, 'VA923 BNE–SYD');
  assert.deepEqual(ev.start, { dateTime: '2026-12-01T06:00:00', timeZone: 'Australia/Brisbane' });
  assert.deepEqual(ev.end, { dateTime: '2026-12-01T08:30:00', timeZone: 'Australia/Sydney' });
  assert.equal(ev.extendedProperties.private.prmKey, 'F|2026-12-01|VA923|BNE');
  assert.match(ev.description, /Report: 05:00 BNE local \(19:00Z 30\/11\)/);
  assert.equal(describeStamp({ dt: '2026-12-01T20:00', basis: 'utc', port: 'BNE' }), '06:00 BNE local 02/12 (20:00Z)');
  const [off] = assignKeys([newDuty({ type: 'DAY_OFF', date: '2026-12-02' })]);
  assert.deepEqual(buildEvent(off).end, { date: '2026-12-03' });
});

test('sync plan: create, update on retime, unchanged, removal only inside period, duplicates', () => {
  const period = { start: '2026-12-01', end: '2026-12-28' };
  const asExisting = (body, id) => ({ id, summary: body.summary, extendedProperties: body.extendedProperties });
  const first = assignKeys([flight(), flight({ flightNumber: 'VA924', dep: 'SYD', arr: 'BNE', start: { dt: '2026-12-01T10:00', basis: 'local', port: 'SYD' }, end: { dt: '2026-12-01T11:40', basis: 'local', port: 'BNE' } })]);
  const p1 = planSync(first, [], period);
  assert.equal(p1.create.length, 2);

  const existing = p1.create.map((x, i) => asExisting(x.body, `e${i}`));
  // same roster again -> nothing to do (no duplicates)
  const p2 = planSync(assignKeys(first), existing, period);
  assert.equal(p2.create.length, 0); assert.equal(p2.unchanged.length, 2); assert.equal(p2.remove.length, 0);

  // VA923 retimed, VA924 removed from roster
  const second = assignKeys([flight({ start: { dt: '2026-12-01T07:00', basis: 'local', port: 'BNE' }, end: { dt: '2026-12-01T09:30', basis: 'local', port: 'SYD' } })]);
  const outsideOld = asExisting({ ...p1.create[0].body, extendedProperties: { private: { ...p1.create[0].body.extendedProperties.private, prmKey: 'F|2026-11-20|VA1|BNE', prmDate: '2026-11-20' } } }, 'old');
  const dup = { ...existing[0], id: 'dup' };
  const p3 = planSync(second, [...existing, outsideOld, dup], period);
  assert.equal(p3.update.length, 1); assert.equal(p3.update[0].event.id, 'e0');
  assert.equal(p3.create.length, 0);
  const removed = p3.remove.map(r => r.event.id).sort();
  assert.deepEqual(removed, ['dup', 'e1'], 'removes VA924 + duplicate, leaves the event outside the period');
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
