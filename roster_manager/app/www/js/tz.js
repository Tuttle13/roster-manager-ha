// Airport (IATA) -> IANA time zone, plus conversions between port-local wall time and UTC.
// Unknown ports are never guessed: they're reported so you can add them in Settings.

export const AIRPORT_TZ = {
  // Queensland (no DST)
  BNE: 'Australia/Brisbane', OOL: 'Australia/Brisbane', MCY: 'Australia/Brisbane', CNS: 'Australia/Brisbane',
  TSV: 'Australia/Brisbane', MKY: 'Australia/Brisbane', PPP: 'Australia/Brisbane', HTI: 'Australia/Brisbane',
  ROK: 'Australia/Brisbane', GLT: 'Australia/Brisbane', BDB: 'Australia/Brisbane', HVB: 'Australia/Brisbane',
  EMD: 'Australia/Brisbane', ISA: 'Australia/Brisbane', LRE: 'Australia/Brisbane', MOV: 'Australia/Brisbane',
  TWB: 'Australia/Brisbane', WEI: 'Australia/Brisbane', BCK: 'Australia/Brisbane', ROM: 'Australia/Brisbane',
  // NSW / ACT
  SYD: 'Australia/Sydney', WSI: 'Australia/Sydney', CBR: 'Australia/Sydney', NTL: 'Australia/Sydney', CFS: 'Australia/Sydney',
  PQQ: 'Australia/Sydney', BNK: 'Australia/Sydney', ABX: 'Australia/Sydney', WGA: 'Australia/Sydney', TMW: 'Australia/Sydney',
  ARM: 'Australia/Sydney', DBO: 'Australia/Sydney', OAG: 'Australia/Sydney', MYA: 'Australia/Sydney', BHQ: 'Australia/Broken_Hill',
  LDH: 'Australia/Lord_Howe',
  // Victoria / Tasmania
  MEL: 'Australia/Melbourne', AVV: 'Australia/Melbourne', MQL: 'Australia/Melbourne',
  HBA: 'Australia/Hobart', LST: 'Australia/Hobart', DPO: 'Australia/Hobart', BWT: 'Australia/Hobart', KNS: 'Australia/Hobart',
  // SA / NT
  ADL: 'Australia/Adelaide', PLO: 'Australia/Adelaide', WYA: 'Australia/Adelaide', MGB: 'Australia/Adelaide',
  DRW: 'Australia/Darwin', ASP: 'Australia/Darwin', AYQ: 'Australia/Darwin', KTR: 'Australia/Darwin',
  // WA
  PER: 'Australia/Perth', BME: 'Australia/Perth', KTA: 'Australia/Perth', PHE: 'Australia/Perth', KGI: 'Australia/Perth',
  LEA: 'Australia/Perth', KNX: 'Australia/Perth', GET: 'Australia/Perth', NRA: 'Australia/Perth', PBO: 'Australia/Perth',
  ZNE: 'Australia/Perth', EPR: 'Australia/Perth', ALH: 'Australia/Perth', BQB: 'Australia/Perth',
  // New Zealand & Pacific
  AKL: 'Pacific/Auckland', WLG: 'Pacific/Auckland', CHC: 'Pacific/Auckland', ZQN: 'Pacific/Auckland', DUD: 'Pacific/Auckland',
  NAN: 'Pacific/Fiji', SUV: 'Pacific/Fiji', APW: 'Pacific/Apia', RAR: 'Pacific/Rarotonga', VLI: 'Pacific/Efate',
  NOU: 'Pacific/Noumea', TBU: 'Pacific/Tongatapu', POM: 'Pacific/Port_Moresby', HIR: 'Pacific/Guadalcanal',
  // Asia & beyond
  DPS: 'Asia/Makassar', HND: 'Asia/Tokyo', NRT: 'Asia/Tokyo', KIX: 'Asia/Tokyo', HKG: 'Asia/Hong_Kong',
  SIN: 'Asia/Singapore', DOH: 'Asia/Qatar', LAX: 'America/Los_Angeles', DIL: 'Asia/Dili',
};

let overrides = {};
export function setOverrides(map) { overrides = { ...(map || {}) }; }

export function tzFor(port) {
  if (!port) return null;
  const p = String(port).trim().toUpperCase();
  return overrides[p] || AIRPORT_TZ[p] || null;
}

export function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en-AU', { timeZone: tz }); return true; } catch { return false; }
}

// Offset (minutes, local minus UTC) of a time zone at a given UTC instant.
function offsetAt(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

function parseLocal(dt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dt || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

// 'YYYY-MM-DDTHH:MM' wall time in tz -> UTC ms.
export function zonedToUtc(dt, tz) {
  const wall = parseLocal(dt);
  if (wall == null || !tz) return null;
  let guess = wall - offsetAt(wall, tz) * 60000;
  guess = wall - offsetAt(guess, tz) * 60000; // second pass settles DST edges
  return guess;
}

// UTC ms -> 'YYYY-MM-DDTHH:MM' wall time in tz.
export function utcToZoned(ms, tz) {
  const local = ms + offsetAt(ms, tz) * 60000;
  return new Date(local).toISOString().slice(0, 16);
}

// A roster timestamp: { dt: 'YYYY-MM-DDTHH:MM', basis: 'local' | 'utc', port: 'BNE' }.
// 'local' means wall-clock time at `port`. Returns UTC ms or null if it can't be resolved.
export function stampToUtc(stamp) {
  if (!stamp || !stamp.dt) return null;
  if (stamp.basis === 'utc') return parseLocal(stamp.dt);
  const tz = tzFor(stamp.port);
  return tz ? zonedToUtc(stamp.dt, tz) : null;
}

export function fmtUtc(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

export function fmtLocal(ms, tz) {
  return utcToZoned(ms, tz).replace('T', ' ');
}
