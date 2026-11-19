// Google Calendar/Drive via the Roster app on Home Assistant. The app holds the Google
// connection (long-lived, encrypted) and forwards these calls, so the panel never sees a token.

import { addDays } from './dates.js';
import { APP_TAG } from './events.js';
import { api } from './db.js';

export class AuthError extends Error {}

let cachedStatus = null;
export async function status(refresh = false) {
  if (!cachedStatus || refresh) cachedStatus = await api('google/status');
  return cachedStatus;
}
export function knownStatus() { return cachedStatus; }

// Opens Google sign-in in a new tab. Google won't run inside the HA frame or the HA phone app,
// so this is done once from a normal browser. The relay page sends the code back here.
export async function connect() {
  const { url } = await api('google/auth-url', { method: 'POST', body: { returnUrl: location.origin + location.pathname } });
  const w = window.open(url, '_blank', 'noopener');
  if (!w) location.assign(url);
}

export async function exchange(code, state) {
  const r = await api('google/exchange', { method: 'POST', body: { code, state } });
  await status(true);
  return r;
}

export async function disconnect() {
  await api('google/disconnect', { method: 'POST' });
  await status(true);
}

// Handles the return from the relay page: #/oauth?code=...&state=...
export async function handleRedirect() {
  const m = /^#\/oauth\?(.*)$/.exec(location.hash);
  if (!m) return { handled: false };
  const p = new URLSearchParams(m[1]);
  history.replaceState(null, '', location.pathname + '#/settings');
  if (p.get('error')) return { handled: true, error: `Google sign-in failed: ${p.get('error')}` };
  try {
    const r = await exchange(p.get('code'), p.get('state'));
    return { handled: true, error: r.missing?.length ? `Connected, but these permissions weren't granted: ${r.missing.join(', ')}. Connect again and tick every box.` : null };
  } catch (e) { return { handled: true, error: e.message }; }
}

export async function gfetch(url, { method = 'GET', body, headers = {}, timeout = 60000 } = {}) {
  const path = url.replace('https://www.googleapis.com/', 'api/gproxy/');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method, body, signal: ctl.signal, credentials: 'same-origin',
      headers: { ...(body && typeof body === 'string' && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...headers },
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Google did not respond in time.' : `Network error: ${e.message}`);
  } finally { clearTimeout(timer); }
  if (res.status === 401) {
    let msg = 'Google isn\'t connected. Settings → Connect Google.';
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    cachedStatus = null;
    throw new AuthError(msg);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error?.message || j.error || msg; } catch { /* ignore */ }
    const err = new Error(`Google API error: ${msg}`); err.status = res.status; throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------- Calendar ----------------
const CAL = 'https://www.googleapis.com/calendar/v3';

export async function ensureCalendar(calendarId, name, timeZone) {
  if (calendarId) {
    try { return await gfetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}`); } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e.status !== 404 && e.status !== 403) throw e;
    }
  }
  return gfetch(`${CAL}/calendars`, { method: 'POST', body: JSON.stringify({ summary: name || 'VA Roster', timeZone, description: 'Created and managed by Roster Manager.' }) });
}

export async function listAppEvents(calendarId, period) {
  const out = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({
      privateExtendedProperty: `prmApp=${APP_TAG}`, singleEvents: 'true', showDeleted: 'false', maxResults: '2500',
      timeMin: `${addDays(period.start, -2)}T00:00:00Z`, timeMax: `${addDays(period.end, 3)}T00:00:00Z`,
    });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await gfetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${p}`);
    out.push(...(r.items || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function executePlan(calendarId, plan, approvedRemovalIds, onProgress = () => {}) {
  const base = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`;
  const ops = [
    ...plan.create.map(x => ({ kind: 'create', label: x.body.summary, date: x.duty.date, run: () => gfetch(base, { method: 'POST', body: JSON.stringify(x.body) }) })),
    ...plan.update.map(x => ({ kind: 'update', label: x.body.summary, date: x.duty.date, run: () => gfetch(`${base}/${encodeURIComponent(x.event.id)}`, { method: 'PUT', body: JSON.stringify(x.body) }) })),
    ...plan.remove.filter(x => approvedRemovalIds.has(x.event.id)).map(x => ({
      kind: 'remove', label: x.event.summary, date: x.event.extendedProperties?.private?.prmDate,
      run: () => gfetch(`${base}/${encodeURIComponent(x.event.id)}`, { method: 'DELETE' }).catch(e => { if (e.status === 410 || e.status === 404) return null; throw e; }),
    })),
  ];
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    onProgress(i, ops.length, op);
    try { await op.run(); results.push({ kind: op.kind, label: op.label, date: op.date, ok: true }); } catch (e) {
      results.push({ kind: op.kind, label: op.label, date: op.date, ok: false, error: e.message });
      if (e instanceof AuthError) {
        for (const rest of ops.slice(i + 1)) results.push({ kind: rest.kind, label: rest.label, date: rest.date, ok: false, error: 'Skipped: Google not connected.' });
        break;
      }
    }
  }
  onProgress(ops.length, ops.length, null);
  return results;
}

// ---------------- Drive ----------------
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDERS = ['Original Rosters', 'Processed Rosters', 'Capture History', 'Backups'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function findFolder(name, parentId) {
  const q = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false', parentId ? `'${parentId}' in parents` : `'root' in parents`].join(' and ');
  const r = await gfetch(`${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' })}`);
  return r.files?.[0] || null;
}

async function createFolder(name, parentId) {
  return gfetch(`${DRIVE}/files?fields=id,name`, { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }) });
}

export async function ensureFolders(saved, rootName = 'My Roster') {
  const valid = async id => { if (!id) return false; try { const f = await gfetch(`${DRIVE}/files/${id}?fields=id,trashed`); return f && !f.trashed; } catch (e) { if (e instanceof AuthError) throw e; return false; } };
  let rootId = saved?.rootId;
  if (!(await valid(rootId))) rootId = (await findFolder(rootName, null))?.id || (await createFolder(rootName, null)).id;
  const ids = {};
  for (const name of FOLDERS) {
    let id = saved?.rootId === rootId ? saved?.ids?.[name] : null;
    if (!(await valid(id))) id = (await findFolder(name, rootId))?.id || (await createFolder(name, rootId)).id;
    ids[name] = id;
  }
  return { rootId, rootName, ids };
}

export async function uploadJson(folderId, name, data) {
  const boundary = `prm${crypto.randomUUID().replace(/-/g, '')}`;
  const meta = { name, parents: [folderId], mimeType: 'application/json' };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data, null, 1)}\r\n--${boundary}--`;
  return gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,createdTime`, { method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, timeout: 90000 });
}

export async function listFiles(folderId) {
  const q = `'${folderId}' in parents and trashed = false`;
  const r = await gfetch(`${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id,name,createdTime,size)', orderBy: 'createdTime desc', pageSize: '100' })}`);
  return r.files || [];
}

export async function downloadJson(fileId) {
  return gfetch(`${DRIVE}/files/${fileId}?alt=media`, { timeout: 90000 });
}
