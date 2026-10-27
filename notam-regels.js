// NOTAM rules shared by index.html, index_beta.html and .github/notam-vorm.mjs, so the app and the morning issue can't drift apart.
// Texts are expected in upper case.

// area key: no spaces or leading zeros (EHD09 = EHD9); a trailing Z marks a FUA variant, matched by callers that need it
export const fuaKey = s => String(s ?? '').toUpperCase().replace(/\s/g, '').replace(/(\D)0+(\d)/g, '$1$2');

// the airspaces a NOTAM names by designator: EHTRA81, TSA 50, EHD09
export const designators = t => [...new Set([...t.matchAll(/\b(?:EH\s?)?(TRA|TSA)\s?(\d+[A-Z]?)\b|\bEH\s?([DRP])\s?(\d+[A-Z]?)\b/g)]
  .map(m => fuaKey(`EH${m[1] ?? m[3]}${m[2] ?? m[4]}`)))];

// a NOTAM about airspace (Q-code QA… or QR…); only those may match an airspace named in full (DE PEEL CTR), not e.g. a crane in a CTR
export const aboutAirspace = t => /\bQ\)\s*\w+\/Q[AR]/.test(t);

// the airspace names (upper case) that occur in the text as whole words; not \b, so a name may start with a quote ('S HEER ARENDSKERKE)
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// each name's pattern is made once and kept, not again for every NOTAM
const patterns = new Map(), pattern = n => patterns.get(n) ?? patterns.set(n, new RegExp(`(?<![A-Z0-9])${escape(n)}(?![A-Z0-9])`)).get(n);
export const namedIn = (names, t) => names.filter(n => pattern(n).test(t));

// whether the Q-code (QA…/QR… closed LC, deactivated CD, not available AU, withdrawn AW) and the E line (CLOSED, DEACTIVATED, …)
// each say the airspace is given free; green in the app only when both do, e.g. DE PEEL CTR CLOSED
export const frees = t => {
  const e = t.split(/\bE\)/)[1]?.split(/\b[FG]\)/)[0] ?? '';
  return [/\bQ\)\s*[^/]+\/Q[AR][A-Z](LC|CD|AU|AW)\//.test(t), /\b(CLOSED|CLSD|DEACTIVATED|NOT ACTIVE|WITHDRAWN|NOT AVBL|NOT AVAILABLE)\b/.test(e)];
};

// [[lon, lat], radius in NM] from the E line's one circle: "WI 45M RADIUS CENTRED ON 514842N 0043132E", "WI 0,25NM RADIUS CENTRED AT …"
// or "PSN 513102N 0055120E RADIUS 300M" (seconds optional); null when there is none, several, or it follows EXC (cut out of the area).
// The same function is in worker/notams.js and notam-regels.js; keep both the same
export function textCircle(text) {
  const COORD = '(\\d{2})(\\d{2})(\\d{2}(?:[.,]\\d+)?)?([NS])\\s*(\\d{3})(\\d{2})(\\d{2}(?:[.,]\\d+)?)?([EW])', R = '(\\d+(?:[.,]\\d+)?)\\s*(M|KM|NM)';
  const all = [
    ...[...text.matchAll(new RegExp(`\\bWI\\s+${R}\\s+RADIUS\\s+(?:CENTRED|CENTERED)\\s+(?:ON|AT)\\s+${COORD}`, 'g'))].map(m => [m.index, m[1], m[2], m.slice(3, 11)]),
    ...[...text.matchAll(new RegExp(`\\bPSN\\s+${COORD}\\s+RADIUS\\s+${R}\\b`, 'g'))].map(m => [m.index, m[9], m[10], m.slice(1, 9)]),
  ];
  if (all.length !== 1 || /\bEXC(EPT)?\s*$/.test(text.slice(0, all[0][0]))) return null;
  const num = s => s ? +s.replace(',', '.') : 0, [, r, unit, [a, b, c, ns, d, e, f, ew]] = all[0];
  const lat = (+a + b / 60 + num(c) / 3600) * (ns === 'S' ? -1 : 1), lon = (+d + e / 60 + num(f) / 3600) * (ew === 'W' ? -1 : 1);
  return [[lon, lat], num(r) / { M: 1852, KM: 1.852, NM: 1 }[unit]];
}

// the NOTAM's own shape is that circle (the Worker draws it)
export const ownCircle = t => !!textCircle(t);
