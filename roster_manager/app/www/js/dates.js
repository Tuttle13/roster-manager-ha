// Date-only helpers (YYYY-MM-DD strings, no time zone involved) and the 28-day period logic.

export const PERIOD_DAYS = 28;

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return d;
}

export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

export function daysBetweenInclusive(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1;
}

export function todayLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export function periodEnd(start) {
  return addDays(start, PERIOD_DAYS - 1);
}

// Roster cycle: periods start every 28 days from a known start (anchor) and are published
// `publishDays` before they start (a Friday afternoon).
export function cycleStartOnOrBefore(date, anchor) {
  const diff = Math.round((parseDate(date) - parseDate(anchor)) / 86400000);
  return addDays(anchor, Math.floor(diff / PERIOD_DAYS) * PERIOD_DAYS);
}

export function latestPublished(anchor, today = todayLocal(), publishDays = 10) {
  // The newest period whose publish date has arrived.
  let start = cycleStartOnOrBefore(addDays(today, publishDays), anchor);
  return { start, end: periodEnd(start), publish: addDays(start, -publishDays) };
}

export function nextPublication(anchor, today = todayLocal(), publishDays = 10) {
  const cur = latestPublished(anchor, today, publishDays);
  const start = addDays(cur.start, PERIOD_DAYS);
  return { start, end: periodEnd(start), publish: addDays(start, -publishDays) };
}

// Default period for a capture. With a cycle anchor: the newest published roster, or the one
// after the last capture if that's already been captured. Without one: the 28 days after the
// last capture, otherwise starting today.
export function defaultPeriod(lastCapture, anchor = null, today = todayLocal(), publishDays = 10) {
  if (anchor && parseDate(anchor)) {
    const p = latestPublished(anchor, today, publishDays);
    if (lastCapture && parseDate(lastCapture.end) && lastCapture.end >= p.end) {
      const start = cycleStartOnOrBefore(addDays(lastCapture.end, 1), anchor);
      const s2 = start <= lastCapture.end ? addDays(start, PERIOD_DAYS) : start;
      return { start: s2, end: periodEnd(s2) };
    }
    return { start: p.start, end: p.end };
  }
  const start = lastCapture && parseDate(lastCapture.end) ? addDays(lastCapture.end, 1) : today;
  return { start, end: periodEnd(start) };
}

// Returns { errors: [...], warnings: [...] }. Errors block capture; warnings need acknowledgement.
export function validatePeriod(start, end, { lastCapture, today = todayLocal() } = {}) {
  const errors = [];
  const warnings = [];
  if (!parseDate(start)) errors.push('Start date is not a valid date.');
  if (!parseDate(end)) errors.push('End date is not a valid date.');
  if (errors.length) return { errors, warnings };
  const len = daysBetweenInclusive(start, end);
  if (len < 1) errors.push('End date is before the start date.');
  else if (len > 62) errors.push(`Range is ${len} days. Maximum is 62 (about two roster periods).`);
  else if (len !== PERIOD_DAYS) warnings.push(`Range is ${len} days, not the usual ${PERIOD_DAYS}.`);
  if (lastCapture && parseDate(lastCapture.end) && !errors.length) {
    const expected = addDays(lastCapture.end, 1);
    if (start !== expected) {
      if (start <= lastCapture.end && end >= lastCapture.start) {
        warnings.push(`Overlaps the last capture (${lastCapture.start} to ${lastCapture.end}). Existing calendar events in the overlap will be compared and updated, not duplicated.`);
      } else {
        warnings.push(`Not the period straight after the last capture (which would start ${expected}).`);
      }
    }
  }
  if (!errors.length) {
    const ageDays = daysBetweenInclusive(end, today) - 1;
    if (ageDays > 60) warnings.push('This whole period is more than two months in the past.');
    const ahead = daysBetweenInclusive(today, start) - 1;
    if (ahead > 120) warnings.push('This period starts more than four months from today.');
  }
  return { errors, warnings };
}

export function prettyDate(s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const d = parseDate(s);
  if (!d) return s || '';
  return d.toLocaleDateString('en-AU', { ...opts, timeZone: 'UTC' });
}

export function prettyRange(a, b) {
  if (!a || !b) return '—';
  return `${prettyDate(a, { day: 'numeric', month: 'short' })} – ${prettyDate(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
