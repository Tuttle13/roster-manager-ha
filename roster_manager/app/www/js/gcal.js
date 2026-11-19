// Portable Google Calendar/Drive helpers. Used two ways:
//   - in the browser, calls go through the app's own proxy (api/gproxy/...), which adds the token;
//   - server-side (Node, for scheduled runs), setDirectAuth() makes calls go straight to Google
//     with a bearer token. Same calendar/Drive logic either way.
import { addDays } from './dates.js';
import { APP_TAG } from './events.js';

export class AuthError extends Error {}

let direct = null; // { token, base } when running server-side
export function setDirectAuth(token, base = 'https://www.googleapis.com') { direct = token ? { token, base } : null; }

export async function gfetch(url, { method = 'GET', body, headers = {}, timeout = 60000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const opts = {
    method, body, signal: ctl.signal,
    headers: { ...(body && typeof body === 'string' && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...headers },
  };
  let path;
  if (direct) {
    path = url.replace('https://www.googleapis.com/', `${direct.base}/`);
    opts.headers.Authorization = `Bearer ${direct.token}`;
  } else {
    path = url.replace('https://www.googleapis.com/', 'api/gproxy/');
    opts.credentials = 'same-origin';
  }
  let res;
  try {
    res = await fetch(path, opts);
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
    out.push(...(r.items || []).map(ev => ({ ...ev, calendarId })));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Each plan item says which calendar it belongs in (x.calendarId); existing events carry the
// calendar they're in now (event.calendarId). A changed category moves the event between calendars.
export async function executePlan(defaultCalendarId, plan, approvedRemovalIds, onProgress = () => {}) {
  const evs = cal => `${CAL}/calendars/${encodeURIComponent(cal || defaultCalendarId)}/events`;
  const del = (cal, id) => gfetch(`${evs(cal)}/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(e => { if (e.status === 410 || e.status === 404) return null; throw e; });
  const ops = [
    ...plan.create.map(x => ({ kind: 'create', label: x.body.summary, date: x.duty.date, run: () => gfetch(evs(x.calendarId), { method: 'POST', body: JSON.stringify(x.body) }) })),
    ...plan.update.map(x => ({
      kind: x.moved ? 'move' : 'update', label: x.body.summary, date: x.duty.date,
      run: async () => {
        if (x.moved) { await gfetch(evs(x.calendarId), { method: 'POST', body: JSON.stringify(x.body) }); return del(x.event.calendarId, x.event.id); }
        return gfetch(`${evs(x.event.calendarId || x.calendarId)}/${encodeURIComponent(x.event.id)}`, { method: 'PUT', body: JSON.stringify(x.body) });
      },
    })),
    ...plan.remove.filter(x => approvedRemovalIds.has(x.event.id)).map(x => ({
      kind: 'remove', label: x.event.summary, date: x.event.extendedProperties?.private?.prmDate,
      run: () => del(x.event.calendarId, x.event.id),
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
