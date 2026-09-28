const { loadGas } = require('./helpers/gas');
const { GuestStatus } = require('./helpers/mocks');

const FILES = ['Config.js', 'Util.js', 'CalendarLookup.js'];
const GR = 'alex@gr-oss.io';
const ISC = 'alex@insightsoftmax.com';
const ME = 'alex@alexscammon.com';

const meeting = (over) => Object.assign({
  key: 'granola:not_sync0924',
  source: 'granola',
  title: 'Secure Copy/Paste Internal Sync',
  start: new Date('2026-09-24T16:00:00Z'),
  end: new Date('2026-09-24T16:45:00Z'),
  attendees: [
    { name: 'Alex Scammon', email: GR },
    { name: 'Miro Knejp', email: 'miro@gr-oss.io' },
    { name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }
  ],
  calendarEventId: null
}, over || {});

const syncEvent = (over) => Object.assign({
  id: '5q1h8v0c2k9d3e7f@google.com',
  title: 'Secure Copy/Paste Internal Sync',
  start: '2026-09-24T16:00:00Z',
  end: '2026-09-24T16:45:00Z',
  guests: [{ email: GR }, { email: 'miro@gr-oss.io' }, { email: 'mihailo.marinkovic@gr-oss.io' }],
  isOwnedByMe: true
}, over || {});

const load = (props) => loadGas(FILES, { props: props || {} });

describe('CalendarLookup.find', () => {
  test('matches by Granola calendar_event_id (recurring instance vs iCalUID)', () => {
    const ctx = load();
    const cal = ctx.__mocks.CalendarApp;
    cal.__addCalendar(GR, [
      syncEvent(),
      { id: 'decoy@google.com', title: 'Secure Copy/Paste Internal Sync prep', start: '2026-09-24T16:05:00Z', end: '2026-09-24T16:30:00Z', guests: [{ email: 'miro@gr-oss.io' }] }
    ]);
    cal.__addCalendar(ISC, []);
    cal.__addCalendar(ME, []);
    const hit = ctx.CalendarLookup.find(meeting({ calendarEventId: '5q1h8v0c2k9d3e7f_20260924T160000Z' }));
    expect(hit).toMatchObject({
      calendarEmail: GR,
      project: 'GR',
      eventId: '5q1h8v0c2k9d3e7f@google.com',
      eventTitle: 'Secure Copy/Paste Internal Sync',
      matchedBy: 'id',
      attendeeEmails: [GR, 'miro@gr-oss.io', 'mihailo.marinkovic@gr-oss.io']
    });
    expect(hit.start.toISOString()).toBe('2026-09-24T16:00:00.000Z');
    // searched every routing calendar within ±15 min
    const [from, to] = cal.getCalendarById(GR).getEvents.mock.calls[0];
    expect(from.toISOString()).toBe('2026-09-24T15:45:00.000Z');
    expect(to.toISOString()).toBe('2026-09-24T16:15:00.000Z');
    expect(cal.getCalendarById).toHaveBeenCalledWith(ISC);
    expect(cal.getCalendarById).toHaveBeenCalledWith(ME);
  });

  test('id match beats a better title match elsewhere', () => {
    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(ISC, [syncEvent({ id: 'other@google.com' })]);
    ctx.__mocks.CalendarApp.__addCalendar(GR, [syncEvent({ id: 'abc@google.com', title: 'Weekly', guests: [] })]);
    const hit = ctx.CalendarLookup.find(meeting({ calendarEventId: 'abc' }));
    expect(hit.calendarEmail).toBe(GR);
    expect(hit.matchedBy).toBe('id');
  });

  test('falls back to title similarity + attendee overlap', () => {
    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(GR, [
      syncEvent({ start: '2026-09-24T16:10:00Z' }),
      { id: 'lunch', title: 'Lunch', start: '2026-09-24T15:50:00Z', end: '2026-09-24T16:30:00Z' }
    ]);
    const hit = ctx.CalendarLookup.find(meeting());
    expect(hit.eventTitle).toBe('Secure Copy/Paste Internal Sync');
    expect(hit.matchedBy).toBe('similarity');
    expect(hit.score).toBeGreaterThan(2);
  });

  test('attendee overlap alone is enough evidence (renamed Granola title)', () => {
    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(GR, [syncEvent({ title: 'Clipboard catch-up' })]);
    const hit = ctx.CalendarLookup.find(meeting({ title: 'Miro / Mihailo' }));
    expect(hit && hit.eventTitle).toBe('Clipboard catch-up');
  });

  test('"New note" with no attendees does not attach to an unrelated event', () => {
    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(ME, [
      { id: 'dentist', title: 'Focus time', start: '2026-09-24T21:00:00Z', end: '2026-09-24T22:00:00Z', isOwnedByMe: true }
    ]);
    const hit = ctx.CalendarLookup.find(meeting({
      key: 'granola:not_newnote0924', title: 'New note', attendees: [],
      start: new Date('2026-09-24T21:10:00Z'), end: null
    }));
    expect(hit).toBeNull();
  });

  test('ignores events starting outside ±15 min and all-day events', () => {
    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(GR, [
      syncEvent({ start: '2026-09-24T15:30:00Z', end: '2026-09-24T16:30:00Z' }), // overlaps window but starts 30 min early
      syncEvent({ id: 'allday', allDay: true, start: '2026-09-24T00:00:00Z', end: '2026-09-25T00:00:00Z' })
    ]);
    expect(ctx.CalendarLookup.find(meeting())).toBeNull();
  });

  test('same event on two calendars: prefers the calendar that is a guest', () => {
    const ctx = load();
    const ev = syncEvent({ isOwnedByMe: false, myStatus: GuestStatus.YES });
    ctx.__mocks.CalendarApp.__addCalendar(ISC, [ev]);
    ctx.__mocks.CalendarApp.__addCalendar(GR, [ev]);
    const hit = ctx.CalendarLookup.find(meeting());
    expect(hit.calendarEmail).toBe(GR);
  });

  test('equal candidates fall back to my status, then routing order', () => {
    const base = { id: 'e1', title: 'Board prep', start: '2026-09-24T16:00:00Z', end: '2026-09-24T17:00:00Z', guests: [{ email: 'marcus@insightsoftmax.com' }] };
    const m = meeting({ title: 'Board prep', attendees: [{ email: 'marcus@insightsoftmax.com' }] });

    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(GR, [Object.assign({}, base, { myStatus: GuestStatus.INVITED })]);
    ctx.__mocks.CalendarApp.__addCalendar(ISC, [Object.assign({}, base, { myStatus: GuestStatus.YES })]);
    expect(ctx.CalendarLookup.find(m).calendarEmail).toBe(ISC); // accepted beats invited

    const ctx2 = load();
    ctx2.__mocks.CalendarApp.__addCalendar(ISC, [Object.assign({}, base)]);
    ctx2.__mocks.CalendarApp.__addCalendar(GR, [Object.assign({}, base)]);
    expect(ctx2.CalendarLookup.find(m).calendarEmail).toBe(GR); // first in routing.calendars
  });

  test('missing or failing calendars are skipped', () => {
    const ctx = load();
    ctx.__mocks.CalendarApp.__addCalendar(ISC, [syncEvent()]);
    const broken = ctx.__mocks.CalendarApp.__addCalendar(ME, []);
    broken.getEvents.mockImplementation(() => { throw new Error('quota'); });
    const hit = ctx.CalendarLookup.find(meeting());
    expect(hit.calendarEmail).toBe(ISC);
    expect(hit.project).toBe('ISC');
  });

  test('returns null for missing meeting/start', () => {
    const ctx = load();
    expect(ctx.CalendarLookup.find(null)).toBeNull();
    expect(ctx.CalendarLookup.find({ title: 'x' })).toBeNull();
    expect(ctx.CalendarLookup.find({ title: 'x', start: 'garbage' })).toBeNull();
  });
});

describe('CalendarLookup.idMatches', () => {
  test('normalises google suffix and recurring instances', () => {
    const ctx = load();
    const f = ctx.CalendarLookup.idMatches;
    expect(f('abc', 'abc@google.com')).toBe(true);
    expect(f('ABC_20260924T160000Z', 'abc@google.com')).toBe(true);
    expect(f('abc@google.com', 'abc_20260924T160000Z')).toBe(true);
    expect(f('abc', 'abcd@google.com')).toBe(false);
    expect(f(null, 'abc')).toBe(false);
    expect(f('abc', '')).toBe(false);
  });
});
