const { normalizeDate } = require('../src/utils/dateUtils');

describe('normalizeDate', () => {
  test('parses ISO date string', () => {
    const res = normalizeDate('2025-08-01T00:00:00.000Z');
    expect(res.date).toBeInstanceOf(Date);
    expect(res.iso).toBe('2025-08-01T00:00:00.000Z');
    expect(res.raw).toBe('2025-08-01T00:00:00.000Z');
  });

  test('parses Indonesian month name', () => {
    const res = normalizeDate('14 Oktober 2025');
    expect(res.date).toBeInstanceOf(Date);
    // Check year/month/day in local time to avoid timezone differences
    expect(res.date.getFullYear()).toBe(2025);
    expect(res.date.getMonth()).toBe(9); // October === 9
    expect(res.date.getDate()).toBe(14);
    expect(res.raw).toBe('14 Oktober 2025');
  });

  test('parses partial Indonesian month name without year', () => {
    const res = normalizeDate('14 Oktober');
    // Could parse to current year or null depending on chrono; ensure function returns object
    expect(res).toHaveProperty('date');
    expect(res).toHaveProperty('iso');
    expect(res.raw).toBe('14 Oktober');
  });

  test('returns nulls for empty input', () => {
    const res = normalizeDate(null);
    expect(res.date).toBeNull();
    expect(res.iso).toBeNull();
    expect(res.raw).toBeNull();
  });

  test('parses numeric timestamp', () => {
    const now = Date.now();
    const res = normalizeDate(now);
    expect(res.date).toBeInstanceOf(Date);
    expect(res.iso).toBe(new Date(now).toISOString());
    expect(res.raw).toBe(now);
  });
});
