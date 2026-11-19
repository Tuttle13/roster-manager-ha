// Storage lives on the Home Assistant box (the app's /data folder), reached through ingress.
// Same interface the screens used before, so the rest of the front end didn't need changing.

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Can't reach the Roster app on Home Assistant (${e.message}).`);
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status; err.auth = !!data?.auth;
    throw err;
  }
  return data;
}

export const kv = {
  get: async (key, fallback = undefined) => { const r = await api(`kv/${encodeURIComponent(key)}`); return r.value ?? fallback; },
  set: (key, value) => api(`kv/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
  del: key => api(`kv/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  all: () => api('kv'),
};

export const captures = {
  put: c => api(`captures/${c.id}`, { method: 'PUT', body: c }),
  get: id => api(`captures/${id}`).catch(e => { if (e.status === 404) return null; throw e; }),
  del: id => api(`captures/${id}`, { method: 'DELETE' }),
  list: () => api('captures'),
};

export const log = {
  add: entry => api('log', { method: 'POST', body: entry }),
  list: () => api('log'),
};

export const exportAll = () => api('export');
export const importAll = (data, { replace = false } = {}) => api(`import${replace ? '?replace=1' : ''}`, { method: 'POST', body: data });
export const wipeAll = () => api('wipe', { method: 'POST' });
export async function requestPersistence() { return true; }
