// node --test tests/  (data copied from the real Roster Report layout, 26OCT26–22NOV26)
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const { parseCapture } = await import('../roster_manager/app/www/js/parser.js');
const { validateDuty, assignKeys } = await import('../roster_manager/app/www/js/model.js');
const { buildEventList } = await import('../roster_manager/app/www/js/events.js');

const H = ['Start Date','Day','Flight Number','Sector','A/C','Duty','Pairing Duty','Rpt','STD','STA','Sign Off','Flt Time','Duty Time','Hotel','Training','Remarks'];
const R = (...c) => c.map(t => ({ t }));
const rows = [
  R('Page 1 of 1'),
  H.map(t => ({ t, h: 1 })),
  R('26OCT26','MON','','MEL','','$ DDO','','','','','','','0','','','TEST REMARK'),
  R('27OCT26','TUE','','MEL','-','RTP6-26_A','','1320','1420','1820','1910','','05:50','','RTP6-Day1','<RTP6-Day1>'),
  R('29OCT26','THU','','MEL','','BLANK','','','','','','','0','','',''),
  R('30OCT26','FRI','','MEL','','SBY03','','0300','0300','0520','','02:20','07:05','','',''),
  R('','','VA 0253','MEL CBR','7M8','FLY','FO','','0619','0728','','01:09','','','',''),
  R('','','VA 0256','CBR MEL','7M8','FLY','FO','','0818','0935','1005','01:17','','','',''),
  R('31OCT26','SAT','','MEL','','DDO','','','','','','','0','','',''),
  R('03NOV26','TUE','VA 0309','MEL BNE','73H','FLY','FO','0610','0712','0833','','02:21','11:11','','',''),
  R('','','VA 1234','BNE PER','73H','FLY','FO','','2330','0130','0215','05:00','','','',''),
];
const capture = { format: 'prm-capture', frames: [{ text: 'Roster Report from 26OCT26 to 22NOV26\nTimes shown are in Port Local times', tables: [{ rows }] }] };

test('reads the Sabre Roster Report', () => {
  const r = parseCapture(capture, { start: '2026-10-26', end: '2026-11-22' });
  assert.equal(r.parserId, 'sabre-roster-report');
  const d = r.duties;
  const by = (date, k) => d.filter(x => x.date === date).map(k);
  assert.equal(d.length, 9);
  assert.deepEqual(by('2026-10-26', x => [x.type, x.code]), [['DAY_OFF', '$ DDO']]);
  const trg = d.find(x => x.code === 'RTP6-26_A');
  assert.equal(trg.type, 'TRAINING'); assert.equal(trg.start.dt, '2026-10-27T14:20'); assert.equal(trg.end.dt, '2026-10-27T18:20');
  assert.equal(trg.report.dt, '2026-10-27T13:20'); assert.equal(trg.release.dt, '2026-10-27T19:10');
  assert.equal(d.find(x => x.code === 'BLANK').type, 'OTHER');
  const sby = d.find(x => x.code === 'SBY03');
  assert.equal(sby.type, 'STANDBY'); assert.equal(sby.start.dt, '2026-10-30T03:00'); assert.equal(sby.end.dt, '2026-10-30T05:20');
  const v253 = d.find(x => x.flightNumber === 'VA253');
  assert.deepEqual([v253.type, v253.dep, v253.arr, v253.start.dt, v253.end.dt, v253.aircraft], ['FLIGHT', 'MEL', 'CBR', '2026-10-30T06:19', '2026-10-30T07:28', '7M8']);
  const v256 = d.find(x => x.flightNumber === 'VA256');
  assert.equal(v256.release.dt, '2026-10-30T10:05');
  const v309 = d.find(x => x.flightNumber === 'VA309');
  assert.equal(v309.report.dt, '2026-11-03T06:10');
  const v1234 = d.find(x => x.flightNumber === 'VA1234');
  assert.equal(v1234.start.dt, '2026-11-03T23:30', 'evening departure same day');
  assert.equal(v1234.end.dt, '2026-11-04T01:30', 'arrives after midnight');
  assert.equal(v1234.release.dt, '2026-11-04T02:15');
  for (const x of d) assert.deepEqual(validateDuty(x, { start: '2026-10-26', end: '2026-11-22' }).errors, [], `${x.flightNumber || x.code}: ${validateDuty(x).errors}`);
  const evs = buildEventList(d).map(e => e.body);
  const callout = evs.find(e => e.summary === '✈️ MEL CBR MEL');
  assert.ok(callout, 'standby callout sectors grouped: ' + evs.map(e => e.summary).join(' | '));
  assert.deepEqual(callout.start, { dateTime: '2026-10-30T06:19:00', timeZone: 'Australia/Melbourne' }, 'no report on callout: starts at first departure');
  assert.deepEqual(callout.end, { dateTime: '2026-10-30T10:05:00', timeZone: 'Australia/Melbourne' }, 'ends at sign off');
  assert.match(callout.description, /Position: FO/);
  assert.ok(evs.some(e => e.summary === '⏱️ Standby Duty'));
  assert.ok(evs.some(e => e.summary === '🏠 Blank day'));
  assert.ok(evs.some(e => e.summary === '🏠 Day off - $ DDO'));
  assert.ok(evs.some(e => e.summary === '✈️ MEL BNE PER'), 'VA309 + VA1234 one duty');
});
