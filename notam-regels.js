// NOTAM rules shared by index.html, index_beta.html and .github/notam-vorm.mjs, so the app and the morning issue can't drift apart.
// Texts are expected in upper case.

// area key: no spaces or leading zeros (EHD09 = EHD9); a trailing Z marks a FUA variant, matched by callers that need it
export const fuaKey = s => String(s ?? '').toUpperCase().replace(/\s/g, '').replace(/(\D)0+(\d)/g, '$1$2');

// the airspaces a NOTAM names by designator: EHTRA81, TSA 50, EHD09
export const designators = t => [...new Set([...t.matchAll(/\b(?:EH\s?)?(TRA|TSA)\s?(\d+[A-Z]?)\b|\bEH\s?([DRP])\s?(\d+[A-Z]?)\b/g)]
  .map(m => fuaKey(`EH${m[1] ?? m[3]}${m[2] ?? m[4]}`)))];

// a NOTAM about airspace (Q-code QA… or QR…); only those may match an airspace named in full (DE PEEL CTR), not e.g. a crane in a CTR
export const aboutAirspace = t => /\bQ\)\s*\w+\/Q[AR]/.test(t);

// the airspace names (upper case) that occur in the text as whole words
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const namedIn = (names, t) => names.filter(n => new RegExp(`\\b${escape(n)}\\b`).test(t));

// whether the Q-code (QA…/QR… closed LC, deactivated CD, not available AU, withdrawn AW) and the E line (CLOSED, DEACTIVATED, …)
// each say the airspace is given free; green in the app only when both do, e.g. DE PEEL CTR CLOSED
export const frees = t => {
  const e = t.split(/\bE\)/)[1]?.split(/\b[FG]\)/)[0] ?? '';
  return [/\bQ\)\s*[^/]+\/Q[AR][A-Z](LC|CD|AU|AW)\//.test(t), /\b(CLOSED|CLSD|DEACTIVATED|NOT ACTIVE|WITHDRAWN|NOT AVBL|NOT AVAILABLE)\b/.test(e)];
};
