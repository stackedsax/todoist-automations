const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const BASE = 'https://public-api.granola.ai/v1';
const FILES = ['Config.js', 'Util.js', 'Http.js', 'Granola.js'];

const load = (props) => {
  const ctx = loadGas(FILES, { props: Object.assign({ GRANOLA_API_KEY: 'grn_test' }, props || {}) });
  ctx.Http.jitter_ = () => 0;
  return ctx;
};

// Fixture based on the Sep 24 "Secure Copy/Paste Internal Sync" meeting.
const syncNote = () => ({
  id: 'not_sync0924',
  object: 'note',
  title: 'Secure Copy/Paste Internal Sync',
  owner: { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
  created_at: '2026-09-24T16:01:12Z',
  updated_at: '2026-09-24T16:48:03Z',
  web_url: 'https://notes.granola.ai/d/not_sync0924',
  calendar_event: {
    event_title: 'Secure Copy/Paste Internal Sync',
    invitees: [{ email: 'miro@gr-oss.io' }, { email: 'Mihailo.Marinkovic@gr-oss.io' }, { email: 'alex@gr-oss.io' }],
    organiser: { email: 'alex@gr-oss.io' },
    calendar_event_id: '5q1h8v0c2k9d3e7f_20260924T160000Z',
    scheduled_start_time: '2026-09-24T16:00:00Z',
    scheduled_end_time: '2026-09-24T16:45:00Z'
  },
  attendees: [
    { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
    { name: 'Miro Knejp', email: 'miro@gr-oss.io' },
    { name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }
  ],
  folder_membership: [],
  summary_text: 'Plain summary',
  summary_markdown: '### Next steps\n- Alex to send the C++ design doc to Miro\n- Mihailo to share the OmniSSA SDK build notes',
  transcript: [
    { speaker: { source: 'microphone', attribution: 'me' }, text: 'I will send the design doc to Miro by Friday.', start_time: '2026-09-24T16:02:00Z', end_time: '2026-09-24T16:02:05Z' },
    { speaker: { source: 'speaker', attribution: 'them' }, text: 'I can share the SDK build notes.', start_time: '2026-09-24T16:03:30Z', end_time: '2026-09-24T16:03:34Z' },
    { speaker: { source: 'speaker', attribution: 'them' }, text: '   ', start_time: '2026-09-24T16:03:40Z', end_time: '2026-09-24T16:03:41Z' }
  ]
});

// Fixture based on the Sep 24 "New note": ad-hoc, no calendar event.
const newNote = () => ({
  id: 'not_newnote0924',
  title: 'New note',
  owner: { name: 'Alex Scammon', email: 'alex@alexscammon.com' },
  created_at: '2026-09-24T21:10:00Z',
  updated_at: '2026-09-24T21:40:00Z',
  web_url: 'https://notes.granola.ai/d/not_newnote0924',
  calendar_event: null,
  attendees: [],
  summary_text: 'Brainstorm about the anniversary Slackbot.',
  summary_markdown: null
});

describe('Granola.listNotes', () => {
  test('sends bearer auth and query params, follows cursor, dedupes', () => {
    const ctx = load();
    const ua = ctx.__mocks.UrlFetchApp;
    ua.__on('GET', `${BASE}/notes`, [
      respond.json({ notes: [{ id: 'not_1', title: 'A' }, { id: 'not_2', title: 'B' }], hasMore: true, cursor: 'c1' }),
      respond.json({ notes: [{ id: 'not_2', title: 'B' }, { id: 'not_3', title: 'C' }], hasMore: false, cursor: null })
    ]);
    const notes = ctx.Granola.listNotes({ updatedAfter: new Date('2026-09-22T00:00:00Z'), pageSize: 100 });
    expect(notes.map(n => n.id)).toEqual(['not_1', 'not_2', 'not_3']);
    const calls = ua.__find('GET', `${BASE}/notes`);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.Authorization).toBe('Bearer grn_test');
    expect(calls[0].query).toEqual({ updated_after: '2026-09-22T00:00:00.000Z', page_size: '30' });
    expect(calls[1].query.cursor).toBe('c1');
  });

  test('createdAfter is passed; missing key throws a helpful error', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes`, respond.json({ notes: [], hasMore: false }));
    ctx.Granola.listNotes({ createdAfter: '2026-09-21T00:00:00Z' });
    expect(ctx.__mocks.UrlFetchApp.__calls[0].query.created_after).toBe('2026-09-21T00:00:00.000Z');

    const bare = loadGas(FILES);
    expect(() => bare.Granola.listNotes()).toThrow(/Missing Script Property: GRANOLA_API_KEY/);
  });

  test('stops when the cursor repeats or the deadline expires', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes`, respond.json({ notes: [{ id: 'x' }], hasMore: true, cursor: 'same' }));
    expect(ctx.Granola.listNotes()).toHaveLength(1);
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(2);

    const ctx2 = load();
    let n = 0;
    ctx2.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes`, () => respond.json({ notes: [{ id: 'n' + (++n) }], hasMore: true, cursor: 'c' + n }));
    const out = ctx2.Granola.listNotes({ deadline: { expired: () => true } });
    expect(out).toHaveLength(1);
  });

  test('propagates HTTP errors', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes`, respond.status(401, '{"error":"unauthorized"}'));
    expect(() => ctx.Granola.listNotes()).toThrow(expect.objectContaining({ name: 'HttpError', status: 401 }));
  });
});

describe('Granola.getNote', () => {
  test('normalises the Secure Copy/Paste note into a Meeting', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes/not_sync0924`, respond.json(syncNote()));
    const m = ctx.Granola.getNote('not_sync0924', { transcript: true });
    expect(ctx.__mocks.UrlFetchApp.__calls[0].query).toEqual({ include: 'transcript' });
    expect(m).toMatchObject({
      key: 'granola:not_sync0924',
      source: 'granola',
      sourceId: 'not_sync0924',
      title: 'Secure Copy/Paste Internal Sync',
      url: 'https://notes.granola.ai/d/not_sync0924',
      organizerEmail: 'alex@gr-oss.io',
      calendarEventId: '5q1h8v0c2k9d3e7f_20260924T160000Z',
      actionItemsText: null,
      alsoRecordedBy: []
    });
    expect(m.start.toISOString()).toBe('2026-09-24T16:00:00.000Z');
    expect(m.end.toISOString()).toBe('2026-09-24T16:45:00.000Z');
    expect(m.updatedAt.toISOString()).toBe('2026-09-24T16:48:03.000Z');
    expect(m.summaryMarkdown).toMatch(/^### Next steps/);
    expect(m.attendees).toEqual([
      { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
      { name: 'Miro Knejp', email: 'miro@gr-oss.io' },
      { name: 'Mihailo Marinkovic', email: 'mihailo.marinkovic@gr-oss.io' }
    ]);
    expect(m.transcript).toEqual([
      { speaker: 'me', name: null, text: 'I will send the design doc to Miro by Friday.', t: 0 },
      { speaker: 'them', name: null, text: 'I can share the SDK build notes.', t: 90 }
    ]);
  });

  test('"New note" without calendar event falls back to created_at and summary_text', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes/not_newnote0924`, respond.json(Object.assign(newNote(), { transcript: [] })));
    const m = ctx.Granola.getNote('not_newnote0924');
    expect(m.start.toISOString()).toBe('2026-09-24T21:10:00.000Z');
    expect(m.end).toBeNull();
    expect(m.calendarEventId).toBeNull();
    expect(m.organizerEmail).toBeNull();
    expect(m.attendees).toEqual([]);
    expect(m.summaryMarkdown).toBe('Brainstorm about the anniversary Slackbot.');
    expect(m.transcript).toEqual([]);
  });

  test('transcript: false skips include and transcript fetching', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes/not_newnote0924`, respond.json(newNote()));
    const m = ctx.Granola.getNote('not_newnote0924', { transcript: false });
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(1);
    expect(ctx.__mocks.UrlFetchApp.__calls[0].query).toEqual({});
    expect(m.transcript).toBeNull();
  });

  test('413 with inline transcript falls back to paging /transcript', () => {
    const ctx = load();
    const ua = ctx.__mocks.UrlFetchApp;
    const bare = syncNote();
    delete bare.transcript;
    ua.__on('GET', req => req.url.split('?')[0] === `${BASE}/notes/not_sync0924`,
      req => (req.query.include ? respond.status(413, 'Payload Too Large') : respond.json(bare)));
    ua.__on('GET', `${BASE}/notes/not_sync0924/transcript`, [
      respond.json({ transcript: [{ speaker: { source: 'microphone', attribution: 'me' }, text: 'First.', start_time: '2026-09-24T16:00:10Z' }], hasMore: true, cursor: 't1' }),
      respond.json({ transcript: [{ speaker: { source: 'speaker', attribution: 'them', name: 'Miro Knejp' }, text: 'Second.', start_time: '2026-09-24T16:00:40Z' }], hasMore: false })
    ]);
    const m = ctx.Granola.getNote('not_sync0924');
    expect(m.transcript).toEqual([
      { speaker: 'me', name: null, text: 'First.', t: 0 },
      { speaker: 'them', name: 'Miro Knejp', text: 'Second.', t: 30 }
    ]);
    const tCalls = ua.__find('GET', `${BASE}/notes/not_sync0924/transcript`);
    expect(tCalls).toHaveLength(2);
    expect(tCalls[0].query).toEqual({ page_size: '100' });
    expect(tCalls[1].query.cursor).toBe('t1');
    // 413 is not retried
    expect(ua.__calls.filter(c => c.query.include)).toHaveLength(1);
  });

  test('missing inline transcript also triggers /transcript; 404 there means no transcript', () => {
    const ctx = load();
    const ua = ctx.__mocks.UrlFetchApp;
    ua.__on('GET', `${BASE}/notes/not_newnote0924`, respond.json(newNote()));
    ua.__on('GET', `${BASE}/notes/not_newnote0924/transcript`, respond.status(404, 'not found'));
    const m = ctx.Granola.getNote('not_newnote0924');
    expect(m.transcript).toBeNull();
    expect(ua.__find('GET', `${BASE}/notes/not_newnote0924/transcript`)).toHaveLength(1);
  });

  test('non-413 errors propagate', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('GET', `${BASE}/notes/nope`, respond.status(404, 'missing'));
    expect(() => ctx.Granola.getNote('nope')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('Granola.mapTranscript speaker attribution', () => {
  test('attribution wins; names are fallbacks; Alex Blundell is never me', () => {
    const ctx = load();
    const out = ctx.Granola.mapTranscript([
      { speaker: { source: 'microphone', attribution: 'me', name: 'Alex Blundell' }, text: 'mic me', start_time: 0 },
      { speaker: { source: 'speaker', attribution: 'them', name: 'Alex Scammon' }, text: 'them attr', start_time: 5.4 },
      { speaker: { source: 'speaker', name: 'Alex Blundell' }, text: 'blundell', start_time: '12' },
      { speaker: { source: 'microphone', name: 'Alex Scammon' }, text: 'named me', start_time: null },
      { speaker: { source: 'speaker', name: 'Speaker 2' }, text: 'generic' },
      { speaker: { source: 'speaker' }, text: 'nothing' },
      { text: 'no speaker object' }
    ]);
    expect(out.map(s => [s.speaker, s.t])).toEqual([
      ['me', 0], ['them', 5], ['them', 12], ['me', null], ['unknown', null], ['unknown', null], ['unknown', null]
    ]);
  });

  test('IDENTITY override adds names', () => {
    const ctx = load({ IDENTITY: JSON.stringify({ myNames: ['Scammon'] }) });
    expect(ctx.Granola.mapTranscript([{ speaker: { name: 'Scammon' }, text: 'x' }])[0].speaker).toBe('me');
  });
});

describe('Granola.attendees_', () => {
  test('merges invitees (strings or objects), dedupes, keeps name-only attendees', () => {
    const ctx = load();
    const out = ctx.Granola.attendees_({
      attendees: [{ name: 'Morasha', email: 'Morasha@InsightSoftmax.com' }, { name: 'Guest Only' }, { name: 'Guest Only' }],
      calendar_event: { invitees: ['morasha@insightsoftmax.com', 'Jon Stumpf <jon@example.com>', { email: 'x@y.io', name: 'X' }] }
    });
    expect(out).toEqual([
      { name: 'Morasha', email: 'morasha@insightsoftmax.com' },
      { name: 'Guest Only', email: null },
      { name: null, email: 'jon@example.com' },
      { name: 'X', email: 'x@y.io' }
    ]);
  });

  test('organiser may be a plain string', () => {
    const ctx = load();
    const n = syncNote();
    n.calendar_event.organiser = 'Morasha <morasha@insightsoftmax.com>';
    expect(ctx.Granola.toMeeting(n).organizerEmail).toBe('morasha@insightsoftmax.com');
  });
});
