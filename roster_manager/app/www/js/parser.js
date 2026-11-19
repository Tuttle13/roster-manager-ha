// Turns what the bookmarklet captured from Sabre into structured duties.
//
// The real Sabre parser is written once the roster page has been inspected. Its structure is
// deliberately not guessed. Until then, the raw capture is saved, shown in Review, and backed up,
// and duties can be entered or corrected by hand.
//
// To add a parser: register({ id, label, detect(capture) -> bool, parse(capture, period) -> { duties, warnings } }).

import { newDuty } from './model.js';

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
