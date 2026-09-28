const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const URL = 'https://api.fireflies.ai/graphql';
const FILES = ['Config.js', 'Util.js', 'Http.js', 'Fireflies.js'];

const load = (props) => {
  const ctx = loadGas(FILES, { props: Object.assign({ FIREFLIES_API_KEY: 'ff_test' }, props || {}) });
  ctx.Http.jitter_ = () => 0;
  ctx.Fireflies.ownerId_ = 'u_alex'; // skip the `user` lookup; covered by its own tests
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
    expect(calls[0].json.variables).toEqual({ limit: 50, skip: 0, fromDate: '2026-09-20T00:00:00.000Z', userId: 'u_alex' });
    expect(calls[1].json.variables.skip).toBe(50);
    expect(calls[0].json.query).toMatch(/transcripts\(fromDate: \$fromDate, toDate: \$toDate, limit: \$limit, skip: \$skip, user_id: \$userId\)/);
    expect(calls[0].json.query).toMatch(/summary \{ overview action_items \}/);
    expect(calls[0].json.query).not.toMatch(/sentences/);
  });

  test('deadline stops paging', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => respond.json({ data: { transcripts: Array.from({ length: 50 }, (_, i) => ({ id: req.json.variables.skip + '-' + i })) } }));
    const out = ctx.Fireflies.listTranscripts({ deadline: { expired: () => true } });
    // first page + LIST_OVERRUN_PAGES more, then flagged incomplete
    expect(out).toHaveLength(50 * (1 + ctx.Fireflies.LIST_OVERRUN_PAGES));
    expect(out.complete).toBe(false);
  });

  test('a short page marks the listing complete; userId null sends no filter', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({ data: { transcripts: [{ id: 'a' }] } }));
    const out = ctx.Fireflies.listTranscripts({ userId: null });
    expect(out.complete).toBe(true);
    expect(ctx.__mocks.UrlFetchApp.__calls[0].json.variables).toEqual({ limit: 50, skip: 0 });
  });
});

describe('Fireflies.ownerUserId', () => {
  test('looks up the key owner once, caches in memory and CacheService', () => {
    const ctx = load();
    ctx.Fireflies.ownerId_ = undefined;
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => /user \{/.test(req.json.query)
      ? respond.json({ data: { user: { user_id: 'u_123', email: 'alex@insightsoftmax.com', name: 'Alex Scammon' } } })
      : respond.json({ data: { transcripts: [] } }));
    ctx.Fireflies.listTranscripts({});
    ctx.Fireflies.listTranscripts({});
    const calls = ctx.__mocks.UrlFetchApp.__calls;
    expect(calls.filter(c => /user \{/.test(c.json.query))).toHaveLength(1);
    expect(calls.filter(c => /transcripts\(/.test(c.json.query)).every(c => c.json.variables.userId === 'u_123')).toBe(true);
    expect(ctx.CacheService.getScriptCache().get('fireflies.ownerUserId')).toBe('u_123');
    ctx.Fireflies.ownerId_ = undefined; // new execution: served from CacheService
    expect(ctx.Fireflies.ownerUserId()).toBe('u_123');
    expect(calls.filter(c => /user \{/.test(c.json.query))).toHaveLength(1);
  });

  test('a failed lookup lists without user_id (email guard still applies)', () => {
    const ctx = load();
    ctx.Fireflies.ownerId_ = undefined;
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => /user \{/.test(req.json.query)
      ? respond.json({ errors: [{ message: 'forbidden' }] })
      : respond.json({ data: { transcripts: [] } }));
    ctx.Fireflies.listTranscripts({});
    const list = ctx.__mocks.UrlFetchApp.__calls.filter(c => /transcripts\(/.test(c.json.query));
    expect(list[0].json.variables.userId).toBeUndefined();
  });
});

describe('Fireflies whose meetings', () => {
  test('meetings listing emails but none of mine are dropped (teammate meetings on a team key)', () => {
    const ctx = load();
    const teammate = { id: 'ffTEAM', title: 'Blundell 1:1', date: Date.parse('2026-09-24T10:00:00Z'),
      organizer_email: 'ablundell@insightsoftmax.com', participants: ['ablundell@insightsoftmax.com, client@example.com'],
      summary: { overview: 'x', action_items: '**Alex Blundell**\nSend the SOW' } };
    const mineAsAttendee = { id: 'ffMINE', title: 'Client call', date: Date.parse('2026-09-24T12:00:00Z'),
      organizer_email: 'client@example.com', meeting_attendees: [{ email: 'Alex@InsightSoftmax.com' }], summary: { overview: 'y' } };
    const noEmails = { id: 'ffNOEMAIL', title: 'Dial-in', date: Date.parse('2026-09-24T14:00:00Z'), summary: { overview: 'z' } };
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({ data: { transcripts: [teammate, mineAsAttendee, noEmails] } }));
    const out = ctx.Fireflies.listSince('2026-09-20', { transcripts: false });
    expect(out.map(m => m.sourceId)).toEqual(['ffMINE', 'ffNOEMAIL']);
  });
});

describe('Fireflies.listSince completeness', () => {
  const mk = (id, iso) => ({ id, title: id, date: Date.parse(iso), summary: { overview: 'o ' + id } });
  const newestFirst = [mk('ffD', '2026-09-24T16:00:00Z'), mk('ffC', '2026-09-24T12:00:00Z'), mk('ffB', '2026-09-23T12:00:00Z'), mk('ffA', '2026-09-22T12:00:00Z')];

  test('fetches sentences oldest first; after the deadline the rest come back deferred, not dropped', () => {
    const ctx = load();
    let fetches = 0;
    const deadline = { expired: () => fetches >= 2 };
    ctx.__mocks.UrlFetchApp.__on('POST', URL, gqlRouter({
      list: () => respond.json({ data: { transcripts: newestFirst } }),
      one: req => {
        fetches++;
        const raw = newestFirst.find(r => r.id === req.json.variables.id);
        return respond.json({ data: { transcript: Object.assign({}, raw, { sentences: [{ speaker_name: 'Marcus Rabe', text: 'hi', start_time: 1 }] }) } });
      }
    }));
    const out = ctx.Fireflies.listSince('2026-09-20', { deadline });
    expect(out.map(m => m.sourceId)).toEqual(['ffA', 'ffB', 'ffC', 'ffD']);
    const one = ctx.__mocks.UrlFetchApp.__calls.filter(c => /transcript\(id/.test(c.json.query));
    expect(one.map(c => c.json.variables.id)).toEqual(['ffA', 'ffB']);
    expect(out.map(m => [m.transcript ? m.transcript.length : null, !!m.deferred, m.transcriptDeferred || null])).toEqual([
      [1, false, null], [1, false, null], [null, true, 'deadline'], [null, true, 'deadline']
    ]);
    // every deferred meeting is newer than every fetched one, so a min(pending) cursor skips nothing
    const fetchedMax = Math.max(...out.filter(m => !m.deferred).map(m => m.start.getTime()));
    expect(out.filter(m => m.deferred).every(m => m.start.getTime() > fetchedMax)).toBe(true);
  });

  test('a listing cut at the deadline throws instead of returning a partial list', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, req => respond.json({ data: { transcripts: Array.from({ length: 50 }, (_, i) => mk('p' + req.json.variables.skip + '-' + i, '2026-09-24T10:00:00Z')) } }));
    expect(() => ctx.Fireflies.listSince('2026-09-01', { deadline: { expired: () => true } }))
      .toThrow(expect.objectContaining({ name: 'FirefliesIncompleteError' }));
    const one = ctx.__mocks.UrlFetchApp.__calls.filter(c => /transcript\(id/.test(c.json.query));
    expect(one).toHaveLength(0);
  });

  test('a listing that finishes after the deadline (overrun) is still returned', () => {
    const ctx = load();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, gqlRouter({
      list: req => respond.json({ data: { transcripts: req.json.variables.skip === 0 ? Array.from({ length: 50 }, (_, i) => mk('q' + i, '2026-09-24T10:00:00Z')) : [mk('qLast', '2026-09-21T10:00:00Z')] } }),
      one: () => respond.json({ data: { transcript: null } })
    }));
    const out = ctx.Fireflies.listSince('2026-09-01', { deadline: { expired: () => true } });
    expect(out).toHaveLength(51);
    expect(out[0].sourceId).toBe('qLast');
    expect(out.every(m => m.deferred)).toBe(true);
    expect(ctx.__mocks.UrlFetchApp.__calls.filter(c => /transcript\(id/.test(c.json.query))).toHaveLength(0);
  });
});

describe('Fireflies.listSince transcript budget', () => {
  test('transcriptGraceMs and needTranscript skip the sentences fetch', () => {
    const ctx = load();
    ctx.Util.now = () => new Date('2026-09-24T18:00:00Z');
    const young = { id: 'ffYOUNG', title: 'Young', date: Date.parse('2026-09-24T17:00:00Z'), summary: { overview: 'y' } };
    const old = { id: 'ffOLD', title: 'Old', date: Date.parse('2026-09-24T10:00:00Z'), summary: { overview: 'o' } };
    const vetoed = { id: 'ffVETO', title: 'Vetoed', date: Date.parse('2026-09-24T09:00:00Z'), summary: { overview: 'v' } };
    const asked = [];
    ctx.__mocks.UrlFetchApp.__on('POST', URL, gqlRouter({
      list: () => respond.json({ data: { transcripts: [young, old, vetoed] } }),
      one: req => respond.json({ data: { transcript: Object.assign({}, old, { sentences: [] }) } })
    }));
    const out = ctx.Fireflies.listSince('2026-09-20', {
      transcriptGraceMs: 3 * 3600 * 1000,
      needTranscript: (id, start) => { asked.push([id, start.toISOString()]); return id !== 'ffVETO'; }
    });
    const one = ctx.__mocks.UrlFetchApp.__calls.filter(c => /transcript\(id/.test(c.json.query));
    expect(one.map(c => c.json.variables.id)).toEqual(['ffOLD']);
    expect(asked).toEqual([['ffVETO', '2026-09-24T09:00:00.000Z'], ['ffOLD', '2026-09-24T10:00:00.000Z']]);
    const by = Object.fromEntries(out.map(m => [m.sourceId, m]));
    expect(by.ffYOUNG).toMatchObject({ transcript: null, transcriptDeferred: 'grace' });
    expect(by.ffYOUNG.deferred).toBeUndefined();
    expect(by.ffVETO).toMatchObject({ transcript: null, transcriptDeferred: 'caller' });
    expect(by.ffOLD.transcript).toEqual([]);
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
    expect(one.map(c => c.json.variables.id)).toEqual(['ffEARLY', '01JCISCWEEKLY0924']); // oldest first

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

  test('lettered diarization names ("Speaker A") are unknown, not them', () => {
    const ctx = load();
    const out = ctx.Fireflies.mapSentences([
      { speaker_name: 'Speaker A', text: 'a', start_time: 1 },
      { speaker_name: 'speaker 12', text: 'b', start_time: 2 },
      { speaker_name: 'Speakers Corner Ltd', text: 'c', start_time: 3 }
    ]);
    expect(out.map(s => s.speaker)).toEqual(['unknown', 'unknown', 'them']);
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
