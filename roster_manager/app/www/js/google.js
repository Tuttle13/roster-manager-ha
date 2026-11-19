// Browser-side Google connection: sign-in, status, and the token-less proxy calls. The reusable
// calendar/Drive helpers live in gcal.js and are shared with the server-side scheduled sync.
import { api } from './db.js';
export * from './gcal.js';

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
