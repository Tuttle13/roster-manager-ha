// Unattended sync, run by the server (Node) for scheduled captures — no browser open.
// Reuses the same parser and event logic the panel uses. Talks to Google directly with a token
// Python provides. Creates/updates/moves calendar events but NEVER deletes in auto mode
// (so an automatic run can't remove anything), then writes a Drive backup.
//
// Usage: node autosync.mjs <captureFile> <settingsFile> <outFile>   (GOOGLE_TOKEN in env)
import fs from 'node:fs';
import { parseCapture } from './www/js/parser.js';
import { setOverrides } from './www/js/tz.js';
import { validateDuty, assignKeys } from './www/js/model.js';
import { planSync, CATEGORIES } from './www/js/events.js';
import * as G from './www/js/gcal.js';

const [captureFile, settingsFile, outFile] = process.argv.slice(2);
const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const token = process.env.GOOGLE_TOKEN;
const base = process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';
G.setDirectAuth(token, base);
setOverrides(settings.tzOverrides || {});

const fileStamp = () => new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '');
const out = { at: new Date().toISOString(), ok: false };

async function run() {
  const period = capture.period;
  const tzName = settings.browserTz || 'Australia/Sydney';
  let duties = (parseCapture(capture, period).duties) || [];
  const parsed = duties.length;
  duties = duties.filter(d => validateDuty(d, period).errors.length === 0);
  if (!settings.includeDaysOff) duties = duties.filter(d => !(d.type === 'DAY_OFF' || (d.type === 'OTHER' && /^BLANK$/i.test(d.code || ''))));
  if (!duties.length) { out.error = 'no-duties'; out.parsed = parsed; return; }
  const keyed = assignKeys(duties);

  const opts = {
    allDayBusy: settings.daysOffBusy, homeBase: settings.homeBase || 'MEL', emoji: settings.emojiTitles !== false,
    flightSpan: settings.flightSpan || 'duty', layoverStyle: settings.layoverStyle || 'short',
    layoverHours: settings.layoverHours ?? 3, layoverOffsetMin: settings.layoverOffsetMin ?? 30,
  };

  const split = settings.splitCalendars !== false;
  const cals = { ...(settings.calendars || {}) };
  const existing = [];
  let single = null;
  if (split) {
    for (const [cat, info] of Object.entries(CATEGORIES)) {
      const cal = await G.ensureCalendar(cals[cat], info.name, tzName);
      cals[cat] = cal.id;
      existing.push(...await G.listAppEvents(cal.id, period));
    }
    if (settings.calendarId && !Object.values(cals).includes(settings.calendarId)) {
      try { existing.push(...await G.listAppEvents(settings.calendarId, period)); } catch { /* ignore */ }
    }
    opts.calFor = cat => cals[cat];
  } else {
    const cal = await G.ensureCalendar(settings.calendarId, settings.calendarName || 'VA Roster', tzName);
    single = cal.id;
    existing.push(...await G.listAppEvents(cal.id, period));
    opts.calFor = () => single;
  }

  const plan = planSync(keyed, existing, period, opts);
  // Auto mode: no approved removals, so nothing is deleted.
  const results = await G.executePlan(single || cals.day, plan, new Set());
  const failed = results.filter(r => !r.ok);
  out.created = results.filter(r => r.ok && r.kind === 'create').length;
  out.updated = results.filter(r => r.ok && r.kind === 'update').length;
  out.moved = results.filter(r => r.ok && r.kind === 'move').length;
  out.wouldRemove = plan.remove.length; // reported, never acted on automatically
  out.failed = failed.length;
  out.failures = failed.slice(0, 20);
  out.calendars = cals;
  out.calendarId = single;
  out.duties = keyed.length;

  // Drive backup (history-keeping, no secrets).
  try {
    const d = await G.ensureFolders(settings.drive, settings.driveRootName || 'My Roster');
    out.drive = d;
    const stamp = fileStamp();
    const baseName = `${period.start}_to_${period.end}__${stamp}`;
    await G.uploadJson(d.ids['Original Rosters'], `original_${baseName}.json`, capture);
    await G.uploadJson(d.ids['Processed Rosters'], `processed_${baseName}.json`, { format: 'prm-processed', version: 1, period, capturedAt: capture.capturedAt, auto: true, duties: keyed });
    out.backup = true;
  } catch (e) {
    out.backupError = e.message;
  }
  out.ok = failed.length === 0;
}

run().then(() => {
  fs.writeFileSync(outFile, JSON.stringify(out));
  process.exit(0);
}).catch(e => {
  out.error = out.error || e.message;
  out.fatal = e.message;
  fs.writeFileSync(outFile, JSON.stringify(out));
  process.exit(0);
});
