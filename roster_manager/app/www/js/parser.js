// Turns what the bookmarklet captured from Sabre into structured duties.
//
// The real Sabre parser is written once the roster page has been inspected. Its structure is
// deliberately not guessed. Until then, the raw capture is saved, shown in Review, and backed up,
// and duties can be entered or corrected by hand.
//
// To add a parser: register({ id, label, detect(capture) -> bool, parse(capture, period) -> { duties, warnings } }).

import { newDuty } from './model.js';
import { stampToUtc } from './tz.js';

const parsers = [];
export function register(p) { parsers.push(p); }

// Accepts clipboard text. Returns a normalised capture object or throws a readable error.
export function readClipboardPayload(text) {
  const t = (text || '').trim();
  if (!t) throw new Error('The clipboard is empty. Tap the Capture bookmark on the Sabre roster page first.');
  let data;
  try { data = JSON.parse(t); } catch {
    throw new Error('The clipboard does not contain a roster capture. Run the Capture bookmark on the Sabre roster page, tap Copy, then try again.');
  }
  if (data.format === 'prm-capture') {
    if (!Array.isArray(data.frames) || !data.frames.length) throw new Error('Capture contains no page content.');
    return data;
  }
  if (data.format === 'prm-duties' && Array.isArray(data.duties)) {
    // Pre-structured duties (testing, or a future export path).
    return { format: 'prm-capture', v: 1, capturedAt: data.capturedAt || new Date().toISOString(), url: data.url || '', title: data.title || 'Structured import', frames: [], duties: data.duties };
  }
  throw new Error(`Unrecognised capture format "${data.format || 'unknown'}".`);
}

export function parseCapture(capture, period) {
  if (Array.isArray(capture.duties)) {
    return {
      parserId: 'structured', duties: capture.duties.map(d => newDuty({ ...d, id: crypto.randomUUID(), source: 'parsed' })), warnings: [],
    };
  }
  const p = parsers.find(x => { try { return x.detect(capture); } catch { return false; } });
  if (!p) {
    return {
      parserId: 'none',
      duties: [],
      warnings: ['No Sabre parser is configured yet. The raw page has been saved. Add duties by hand, or send a sample capture so the parser can be built.'],
    };
  }
  try {
    const r = p.parse(capture, period) || {};
    return { parserId: p.id, duties: (r.duties || []).map(d => newDuty({ ...d, source: 'parsed' })), warnings: r.warnings || [] };
  } catch (e) {
    return { parserId: p.id, duties: [], warnings: [`Parser "${p.label}" failed: ${e.message}. The raw page has been kept.`] };
  }
}

export function captureText(capture) {
  return (capture.frames || []).map(f => `── ${f.title || f.path || 'frame'} ──\n${f.text || ''}`).join('\n\n');
}

// ---------------- Sabre AirCentre Crew Connection: Reports → Roster Report ----------------
// Columns: Start Date | Day | Flight Number | Sector | A/C | Duty | Pairing Duty | Rpt | STD | STA |
//          Sign Off | Flt Time | Duty Time | Hotel | Training | Remarks
// A dated row starts a roster day; following undated rows (sectors) belong to that day.

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const key = s => norm(s).toLowerCase().replace(/[^a-z0-9/]/g, '');

function sabreDate(s) {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2,4})$/i.exec(norm(s).replace(/\s/g, ''));
  if (!m || !MON[m[2].toUpperCase()]) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return `${y}-${String(MON[m[2].toUpperCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
function hhmm(s) {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(norm(s));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
function plusDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function stamp(date, time, port, basis) { return time ? { dt: `${date}T${time}`, basis, port } : null; }
function shift(st, days) { return st ? { ...st, dt: `${plusDays(st.dt.slice(0, 10), days)}${st.dt.slice(10)}` } : st; }

function rosterTable(capture) {
  for (const f of capture.frames || []) {
    for (const t of f.tables || []) {
      for (let i = 0; i < t.rows.length; i++) {
        const names = t.rows[i].map(c => key(c.t));
        if (names.includes('startdate') && names.includes('flightnumber') && names.includes('sector') && names.includes('duty')) {
          return { table: t, headerIndex: i };
        }
      }
    }
  }
  return null;
}

function rowsOf(table, headerIndex) {
  const cols = [];
  let pos = 0;
  for (const c of table.rows[headerIndex]) { cols.push({ name: key(c.t), at: pos }); pos += c.cs || 1; }
  const out = [];
  for (const r of table.rows.slice(headerIndex + 1)) {
    const byPos = {};
    let p = 0;
    for (const c of r) { byPos[p] = c.t; p += c.cs || 1; }
    const row = {};
    for (const col of cols) row[col.name] = norm(byPos[col.at]);
    if (Object.values(row).some(Boolean)) out.push({ row, raw: r.map(c => norm(c.t)).join(' | ') });
  }
  return out;
}

function classify(duty, pairingDuty, flight, training) {
  const d = duty.toUpperCase().replace(/^\$\s*/, '');
  const pd = pairingDuty.toUpperCase();
  if (flight) {
    if (['DH', 'DHD', 'PAX', 'POS', 'DEADHEAD', 'DHF'].includes(d) || ['DH', 'DHD', 'PAX', 'POS'].includes(pd)) return 'POSITIONING';
    return 'FLIGHT';
  }
  if (/^(DDO|DO|OFF|RDO|ADO|GDO|XDO|DFD|FDO)\b/.test(d)) return 'DAY_OFF';
  if (/^(AL|ANL|SL|LSL|LVE|LEAVE|PL|CL|UL)\b/.test(d)) return 'LEAVE';
  if (/^(SBY|SB|STBY|STB)/.test(d)) return 'STANDBY';
  if (/^(RES|RSV|RSRV)/.test(d)) return 'RESERVE';
  if (training || /^(RTP|SIM|CRM|EP|CBT|TRG|LOFT|LPC|OPC|CC|GS|SEP)/.test(d)) return 'TRAINING';
  return 'OTHER';
}

register({
  id: 'sabre-roster-report',
  label: 'Sabre Roster Report',
  detect: c => !!rosterTable(c),
  parse: capture => {
    const found = rosterTable(capture);
    const allText = (capture.frames || []).map(f => f.text || '').join('\n');
    const basis = /port local/i.test(allText) ? 'local' : /\b(UTC|GMT|Zulu)\b/.test(allText) ? 'utc' : 'local';
    const warnings = [];
    if (!/port local/i.test(allText)) warnings.push(basis === 'utc' ? 'Sabre says times are UTC.' : 'Sabre didn\'t say which time zone the times are in. Assumed port local times.');
    for (const w of capture.warnings || []) warnings.push(w);
    if (capture.notices) warnings.push(`Sabre Notice Board had notices: ${capture.notices.slice(0, 300)}`);

    const duties = [];
    let cur = null; let dayOff = 0; let lastUtc = null;
    for (const { row, raw } of rowsOf(found.table, found.headerIndex)) {
      const date = sabreDate(row.startdate);
      if (date) { cur = date; dayOff = 0; lastUtc = null; }
      if (!cur) continue;
      const flightRaw = row.flightnumber;
      const fm = /^([A-Z]{2})\s*0*(\d+[A-Z]?)$/i.exec(flightRaw.replace(/\s+/g, ' ').trim());
      const flight = fm ? `${fm[1].toUpperCase()}${fm[2]}` : flightRaw.replace(/\s+/g, '');
      const ports = row.sector.toUpperCase().split(/[\s\-/]+/).filter(p => /^[A-Z]{3}$/.test(p));
      const [dep, arr] = [ports[0] || '', ports[1] || ''];
      const duty = row.duty;
      const type = classify(duty, row.pairingduty, flight, row.training);
      const notes = [];
      if (row.pairingduty) notes.push(`Position: ${row.pairingduty}`);
      if (row.flttime) notes.push(`Flight time: ${row.flttime}`);
      if (row.dutytime && row.dutytime !== '0') notes.push(`Duty time: ${row.dutytime}`);
      if (row.hotel) notes.push(`Hotel: ${row.hotel}`);
      if (row.training) notes.push(`Training: ${row.training}`);
      if (row.remarks) notes.push(`Remarks: ${row.remarks}`);
      const base = { date: cur, code: flight ? '' : duty, flightNumber: flight, dep, arr, aircraft: (row['a/c'] || row.ac) && (row['a/c'] || row.ac) !== '-' ? (row['a/c'] || row.ac) : '', notes: notes.join('\n'), raw };

      const std = hhmm(row.std); const sta = hhmm(row.sta); const rpt = hhmm(row.rpt); const off = hhmm(row.signoff);
      if (flight) {
        let d0 = plusDays(cur, dayOff);
        let start = stamp(d0, std, dep, basis);
        let su = stampToUtc(start);
        if (su != null && lastUtc != null && su < lastUtc - 3600000) { dayOff++; start = shift(start, 1); su = stampToUtc(start); d0 = plusDays(cur, dayOff); }
        let end = stamp(d0, sta, arr || dep, basis);
        let eu = stampToUtc(end);
        if (su != null && eu != null && eu <= su) { end = shift(end, 1); eu = stampToUtc(end); }
        let report = stamp(d0, rpt, dep, basis);
        if (report && su != null && stampToUtc(report) > su) report = shift(report, -1);
        let release = stamp(end ? end.dt.slice(0, 10) : d0, off, arr || dep, basis);
        if (release && eu != null && stampToUtc(release) < eu) release = shift(release, 1);
        if (eu != null) lastUtc = eu;
        duties.push({ ...base, type, start, end, report, release });
      } else {
        let start = stamp(cur, std || rpt, dep, basis);
        let end = stamp(cur, std ? sta : off, dep, basis);
        if (!start || !end) { start = null; end = null; }
        const su = stampToUtc(start); let eu = stampToUtc(end);
        if (su != null && eu != null && eu <= su) { end = shift(end, 1); eu = stampToUtc(end); }
        const report = std && rpt ? stamp(cur, rpt, dep, basis) : null;
        let release = std && off ? stamp(cur, off, dep, basis) : null;
        if (release && eu != null && stampToUtc(release) < eu) release = shift(release, 1);
        if (eu != null) lastUtc = eu;
        duties.push({ ...base, type, start, end, report, release });
      }
    }
    if (!duties.length) warnings.push('The roster table was found but no duties could be read from it.');
    return { duties, warnings };
  },
});
