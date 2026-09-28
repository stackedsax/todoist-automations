const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const URL = 'https://api.fireflies.ai/graphql';
const FILES = ['Config.js', 'Util.js', 'Http.js', 'Fireflies.js'];

const load = (props) => {
  const ctx = loadGas(FILES, { props: Object.assign({ FIREFLIES_API_KEY: 'ff_test' }, props || {}) });
  ctx.Http.jitter_ = () => 0;
  return ctx;
};

// ISC meeting where Fireflies groups action items under "Alex Blundell" — those are NOT Alex's.
const iscMeeting = () => ({
  id: '01JCISCWEEKLY0924',
  title: 'ISC Weekly Delivery Sync',
  date: Date.parse('2026-09-24T18:00:00Z'),
  duration: 31.5,
  organizer_email: 'alex.blundell@insightsoftmax.com',
  participants: ['alex@insightsoftmax.com,alex.blundell@insightsoftmax.com', 'marcus@insightsoftmax.com'],
  meeting_attendees: [
    { displayName: 'Alex Blundell', email: 'Alex.Blundell@insightsoftmax.com', name: null },
    { displayName: null, email: 'alex@insightsoftmax.com', name: 'Alex Scammon' }
  ],
  summary: {
    overview: 'Reviewed delivery status for the AWS quantum engagement.',
    action_items: '**Alex Blundell**\nSend the updated SOW to the client (03:12)\n\n**Alex Scammon**\nIntroduce Marcus to Jon Green at AWS (12:40)'
  },
  transcript_url: 'https://app.fireflies.ai/view/ISC-Weekly::01JCISCWEEKLY0924',
  sentences: [
    { speaker_name: 'Alex Blundell', text: 'I will send the updated SOW.', start_time: 192.4 },
    { speaker_name: 'Alex Blundell', text: 'Probably tomorrow.', start_time: 195 },
    { speaker_name: 'Alex Scammon', text: 'I can introduce Marcus to Jon.', start_time: 760.2 },
    { speaker_name: 'Alex', text: 'Ambiguous first name.', start_time: 800 },
    { speaker_name: 'Speaker 3', text: 'Unidentified.', start_time: 810 },
    { speaker_name: 'Marcus Rabe', text: '', start_time: 820 },
    { speaker_name: 'Marcus Rabe', text: 'Sounds good.', start_time: null }
  ]
});

const gqlRouter = (handlers) => (req) => {
  const q = req.json.query;
  const h = /transcript\(id/.test(q) ? handlers.one : handlers.list;
  return h(req);
};

describe('Fireflies.graphql', () => {
  test('POSTs query + variables with bearer auth', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({ data: { ok: 1 } }));
    expect(ctx.Fireflies.graphql('{ user { email } }', { a: 1 })).toEqual({ ok: 1 });
    const call = ctx.__mocks.UrlFetchApp.__calls[0];
    expect(call.headers.Authorization).toBe('Bearer ff_test');
    expect(call.json).toEqual({ query: '{ user { email } }', variables: { a: 1 } });
  });

  test('GraphQL errors (HTTP 200) throw', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({ errors: [{ message: 'Too many requests' }], data: null }));
    expect(() => ctx.Fireflies.graphql('{x}')).toThrow('Fireflies GraphQL error: Too many requests');
  });

  test('enabled() reflects FIREFLIES_API_KEY', () => {
    expect(load().Fireflies.enabled()).toBe(true);
    expect(loadGas(FILES).Fireflies.enabled()).toBe(false);
    expect(() => loadGas(FILES).Fireflies.graphql('{x}')).toThrow(/Missing Script Property: FIREFLIES_API_KEY/);
  });
});

describe('Fireflies.listTranscripts', () => {
  test('pages with limit/skip until a short page, passes fromDate as ISO', () => {
    const ctx = load();
    const page = (n, offset) => Array.from({ length: n }, (_, i) => ({ id: 'ff' + (offset + i) }));
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => {
      const skip = req.json.variables.skip;
      return respond.json({ data: { transcripts: skip === 0 ? page(50, 0) : page(3, 50) } });
    });
    const out = ctx.Fireflies.listTranscripts({ fromDate: new Date('2026-09-20T00:00:00Z') });
    expect(out).toHaveLength(53);
    const calls = ctx.__mocks.UrlFetchApp.__calls;
    expect(calls).toHaveLength(2);
    expect(calls[0].json.variables).toEqual({ limit: 50, skip: 0, fromDate: '2026-09-20T00:00:00.000Z' });
    expect(calls[1].json.variables.skip).toBe(50);
    expect(calls[0].json.query).toMatch(/transcripts\(fromDate: \$fromDate, toDate: \$toDate, limit: \$limit, skip: \$skip\)/);
    expect(calls[0].json.query).toMatch(/summary \{ overview action_items \}/);
    expect(calls[0].json.query).not.toMatch(/sentences/);
  });

  test('deadline stops paging', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => respond.json({ data: { transcripts: Array.from({ length: 50 }, (_, i) => ({ id: req.json.variables.skip + '-' + i })) } }));
    const out = ctx.Fireflies.listTranscripts({ deadline: { expired: () => true } });
    expect(out).toHaveLength(50);
  });
});

describe('Fireflies.listSince / toMeeting', () => {
  test('returns normalised Meetings with transcripts, skipping unsummarised and skipIds', () => {
    const ctx = load();
    const light = iscMeeting();
    delete light.sentences;
    const pending = { id: 'ffPENDING', title: 'Still processing', date: Date.parse('2026-09-25T10:00:00Z'), summary: { overview: null, action_items: null } };
    const seen = { id: 'ffSEEN', title: 'Done already', date: Date.parse('2026-09-23T10:00:00Z'), summary: { overview: 'x' } };
    const early = { id: 'ffEARLY', title: 'Early', date: Date.parse('2026-09-22T10:00:00Z'), summary: { overview: 'Early one' } };
    ctx.__mocks.UrlFetchApp.__on('POST', URL, gqlRouter({
      list: () => respond.json({ data: { transcripts: [light, pending, seen, early] } }),
      one: req => respond.json({ data: { transcript: req.json.variables.id === light.id ? iscMeeting() : Object.assign({}, early, { sentences: [] }) } })
    }));
    const out = ctx.Fireflies.listSince('2026-09-20T00:00:00Z', { skipIds: id => id === 'ffSEEN' });
    expect(out.map(m => m.sourceId)).toEqual(['ffEARLY', '01JCISCWEEKLY0924']);
    const one = ctx.__mocks.UrlFetchApp.__calls.filter(c => /transcript\(id/.test(c.json.query));
    expect(one.map(c => c.json.variables.id)).toEqual(['01JCISCWEEKLY0924', 'ffEARLY']);

    const m = out[1];
    expect(m).toMatchObject({
      key: 'fireflies:01JCISCWEEKLY0924',
      source: 'fireflies',
      title: 'ISC Weekly Delivery Sync',
      url: 'https://app.fireflies.ai/view/ISC-Weekly::01JCISCWEEKLY0924',
      organizerEmail: 'alex.blundell@insightsoftmax.com',
      calendarEventId: null,
      alsoRecordedBy: []
    });
    expect(m.start.toISOString()).toBe('2026-09-24T18:00:00.000Z');
    expect(m.end.toISOString()).toBe('2026-09-24T18:31:30.000Z');
    expect(m.summaryMarkdown).toBe('Reviewed delivery status for the AWS quantum engagement.\n\n### Action items\n' + iscMeeting().summary.action_items);
    expect(m.actionItemsText).toMatch(/^\*\*Alex Blundell\*\*/);
    expect(m.attendees).toEqual([
      { name: 'Alex Blundell', email: 'alex.blundell@insightsoftmax.com' },
      { name: 'Alex Scammon', email: 'alex@insightsoftmax.com' },
      { name: null, email: 'marcus@insightsoftmax.com' }
    ]);
  });

  test('Alex Blundell sentences are never attributed to Alex', () => {
    const ctx = load();
    const m = ctx.Fireflies.toMeeting(iscMeeting());
    expect(m.transcript).toEqual([
      { speaker: 'them', name: 'Alex Blundell', text: 'I will send the updated SOW. Probably tomorrow.', t: 192 },
      { speaker: 'me', name: 'Alex Scammon', text: 'I can introduce Marcus to Jon.', t: 760 },
      { speaker: 'unknown', name: 'Alex', text: 'Ambiguous first name.', t: 800 },
      { speaker: 'unknown', name: 'Speaker 3', text: 'Unidentified.', t: 810 },
      { speaker: 'them', name: 'Marcus Rabe', text: 'Sounds good.', t: null }
    ]);
    expect(m.transcript.filter(s => s.speaker === 'me').every(s => s.name !== 'Alex Blundell')).toBe(true);
  });

  test('includeUnsummarised and transcripts:false', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({ data: { transcripts: [{ id: 'p', title: 'P', date: '1790000000000', summary: null }] } }));
    const out = ctx.Fireflies.listSince(new Date('2026-09-01'), { includeUnsummarised: true, transcripts: false });
    expect(out).toHaveLength(1);
    expect(out[0].transcript).toBeNull();
    expect(out[0].summaryMarkdown).toBe('');
    expect(out[0].actionItemsText).toBeNull();
    expect(out[0].end).toBeNull();
    expect(out[0].start.getTime()).toBe(1790000000000);
    expect(out[0].url).toBe('https://app.fireflies.ai/view/p');
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(1);
  });

  test('a failed per-transcript fetch keeps the meeting without a transcript', () => {
    const ctx = load();
    const light = iscMeeting();
    delete light.sentences;
    ctx.__mocks.UrlFetchApp.__on('POST', URL, gqlRouter({
      list: () => respond.json({ data: { transcripts: [light] } }),
      one: () => respond.json({ errors: [{ message: 'boom' }] })
    }));
    const out = ctx.Fireflies.listSince('2026-09-20');
    expect(out).toHaveLength(1);
    expect(out[0].transcript).toBeNull();
    expect(out[0].summaryMarkdown).toMatch(/AWS quantum/);
  });

  test('get(id) returns a Meeting, or null when missing', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => respond.json({ data: { transcript: req.json.variables.id === 'x' ? null : iscMeeting() } }));
    expect(ctx.Fireflies.get('x')).toBeNull();
    expect(ctx.Fireflies.get('01JCISCWEEKLY0924').transcript).toHaveLength(5);
  });

  test('array action_items and ISO date are tolerated', () => {
    const ctx = load();
    const m = ctx.Fireflies.toMeeting({ id: 'a', title: '  T ', date: '2026-09-24T10:00:00Z', summary: { action_items: ['One', ' Two '] } });
    expect(m.title).toBe('T');
    expect(m.start.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(m.summaryMarkdown).toBe('### Action items\nOne\nTwo');
  });
});
