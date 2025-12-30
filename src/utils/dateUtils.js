const chrono = require('chrono-node');

// Map common Indonesian month names to English to help Date parsing
const ID_MONTHS_MAP = {
  'januari': 'january',
  'februari': 'february',
  'maret': 'march',
  'april': 'april',
  'mei': 'may',
  'juni': 'june',
  'juli': 'july',
  'agustus': 'august',
  'september': 'september',
  'oktober': 'october',
  'november': 'november',
  'desember': 'december'
};

function replaceIndoMonths(str) {
  if (!str || typeof str !== 'string') return str;
  let s = str.toLowerCase();
  Object.keys(ID_MONTHS_MAP).forEach(id => {
    const re = new RegExp(id, 'g');
    s = s.replace(re, ID_MONTHS_MAP[id]);
  });
  return s;
}

/**
 * normalizeDate(value)
 * - Accepts a variety of inputs: Date, ISO string, natural language (e.g. "14 Oktober"),
 *   or null/undefined.
 * - Returns { date: Date|null, iso: string|null, raw: originalValue }
 */
function normalizeDate(value) {
  const raw = value === undefined ? null : value;

  if (value == null || value === '') {
    return { date: null, iso: null, raw };
  }

  // If it's already a Date
  if (value instanceof Date) {
    if (!isNaN(value.getTime())) {
      return { date: value, iso: value.toISOString(), raw };
    }
    return { date: null, iso: null, raw };
  }

  // If it's numeric string or number (timestamp)
  if (typeof value === 'number' || /^[0-9]+$/.test(String(value).trim())) {
    try {
      const d = new Date(Number(value));
      if (!isNaN(d.getTime())) return { date: d, iso: d.toISOString(), raw };
    } catch (e) {}
  }

  // Try direct Date parse first (handles ISO formats)
  try {
    const d = new Date(String(value));
    if (!isNaN(d.getTime())) return { date: d, iso: d.toISOString(), raw };
  } catch (e) {}

  // Try replacing Indonesian month names and parse again
  try {
    const replaced = replaceIndoMonths(String(value));
    const d2 = new Date(replaced);
    if (!isNaN(d2.getTime())) return { date: d2, iso: d2.toISOString(), raw };
  } catch (e) {}

  // Fallback to chrono-node (natural language parser)
  try {
    const parsed = chrono.parseDate(String(value));
    if (parsed && !isNaN(parsed.getTime())) {
      return { date: parsed, iso: parsed.toISOString(), raw };
    }
  } catch (e) {}

  // Could not parse
  return { date: null, iso: null, raw };
}

/**
 * extractDateFromText(transcript, query)
 * - Attempts to find a date near `query` in the transcript using chrono-node.
 * - Returns { date: Date|null, iso: string|null, raw: matchedText|null }
 */
function extractDateFromText(transcript, query) {
  if (!transcript || typeof transcript !== 'string') return { date: null, iso: null, raw: null };
  try {
    const txt = transcript;
    let windowText = txt;
    if (query && typeof query === 'string') {
      const idx = txt.toLowerCase().indexOf(query.toLowerCase());
      if (idx !== -1) {
        const start = Math.max(0, idx - 200);
        const end = Math.min(txt.length, idx + 200);
        windowText = txt.slice(start, end);
      } else {
        // fallback: look for sentence boundaries containing words from query
        const qwords = query.split(/\s+/).filter(Boolean).slice(0,3);
        for (const w of qwords) {
          const i2 = txt.toLowerCase().indexOf(w.toLowerCase());
          if (i2 !== -1) {
            const start = Math.max(0, i2 - 200);
            const end = Math.min(txt.length, i2 + 200);
            windowText = txt.slice(start, end);
            break;
          }
        }
      }
    }

    const candidate = replaceIndoMonths(windowText);
    const parsed = chrono.parseDate(candidate);
    if (parsed && !isNaN(parsed.getTime())) {
      return { date: parsed, iso: parsed.toISOString(), raw: candidate };
    }
  } catch (e) {}
  return { date: null, iso: null, raw: null };
}

module.exports = {
  normalizeDate,
  extractDateFromText,
};
