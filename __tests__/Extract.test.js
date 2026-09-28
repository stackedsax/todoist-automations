const { loadGas } = require('./helpers/gas');

const CATALOGUE = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

function setup(props) {
  const ctx = loadGas(['Config.js', 'Util.js', 'Route.js', 'Dedupe.js', 'Extract.js'], {
    props: props || {}, timeZone: 'America/Los_Angeles'
  });
  ctx.Util.now = () => new Date('2026-09-28T16:00:00Z');
  ctx.Todoist = { sectionCatalogue: jest.fn(keys => { const o = {}; keys.forEach(k => { o[k] = CATALOGUE[k].concat(k === 'GR' ? ['Generated Tasks'] : []); }); return o; }) };
  ctx.Store = { feedbackRecent: jest.fn(() => []) };
  ctx.Claude = { json: jest.fn(() => ({ items: [] })) };
  return ctx;
}

const item = extra => Object.assign({
  title: 'Send the build notes to Mihailo', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
  category: 'action', quote: 'I will send the build notes.', why: 'Alex committed to it.', due: null, resurface: null,
  confidence: 'high', project: 'GR', section: 'Tech Projects', timestampSec: 12
}, extra || {});

// Granola fixture based on the Sep 24 "Secure Copy/Paste Internal Sync".
const granolaMeeting = () => ({
  key: 'granola:not_scp', source: 'granola', sourceId: 'not_scp', title: 'Secure Copy/Paste Internal Sync',
  start: new Date('2026-09-24T16:00:00Z'), end: new Date('2026-09-24T16:30:00Z'),
  url: 'https://notes.granola.ai/d/not_scp',
  attendees: [
    { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
    { name: 'Miro Knejp', email: 'miro@gr-oss.io' },
    { name: 'Mihailo Marinkovic', email: 'mihailo@gr-oss.io' },
    { name: 'Morasha', email: 'morasha@insightsoftmax.com' }
  ],
  organizerEmail: 'alex@gr-oss.io', calendarEventId: 'evt_scp',
  summaryMarkdown: '### Next steps\n- Alex to send the build notes\n- Mihailo to share the C++ port branch with Alex by Friday\n- Decided to keep the C ABI',
  actionItemsText: null,
  transcript: [
    { speaker: 'me', name: null, text: 'I will send the build notes after this.', t: 12 },
    { speaker: 'them', name: null, text: 'I can get you the port branch by Friday.', t: 75 },
    { speaker: 'them', name: null, text: 'Each member should review the threat model.', t: 3700 }
  ],
  alsoRecordedBy: []
});

// Fireflies fixture: action items grouped under "Alex Blundell" must NOT become Alex's.
const firefliesMeeting = () => ({
  key: 'fireflies:01FF', source: 'fireflies', sourceId: '01FF', title: 'ISC Weekly',
  start: new Date('2026-09-25T17:00:00Z'), end: null, url: 'https://app.fireflies.ai/view/01FF',
  attendees: [{ name: 'Alex Blundell', email: 'ablundell@insightsoftmax.com' }, { name: 'Alex Scammon', email: 'alex@insightsoftmax.com' }],
  organizerEmail: null, calendarEventId: null,
  summaryMarkdown: 'Overview: pipeline review.',
  actionItemsText: '**Alex Blundell**\nSend the AWS invoice to finance (12:03)\n**Alex Scammon**\nIntro Marcus to the Spectro team (20:10)',
  transcript: [
    { speaker: 'unknown', name: 'Alex Blundell', text: 'I will send the AWS invoice to finance.', t: 723 },
    { speaker: 'unknown', name: 'Alex Scammon', text: 'I\'ll intro Marcus to Spectro.', t: 1210 },
    { speaker: 'unknown', name: 'Alex', text: 'Sounds good.', t: 1300 }
  ],
  alsoRecordedBy: []
});

describe('Extract.meeting prompt', () => {
  test('system prompt carries identity, notMe, assistant, speaker and drop rules', () => {
    const ctx = setup();
    ctx.Extract.meeting(granolaMeeting(), { routeHint: { project: 'GR', confidence: 'high', reason: 'calendar alex@gr-oss.io' }, sectionsByProject: CATALOGUE, feedback: [] });
    const req = ctx.Claude.json.mock.calls[0][0];
    const sys = req.system;
    expect(sys).toMatch(/Alex Scammon/);
    expect(sys).toMatch(/alex@insightsoftmax\.com, alex@gr-oss\.io, alex@alexscammon\.com/);
    expect(sys).toMatch(/NOT ALEX: Alex Blundell/);
    expect(sys).toMatch(/NEVER Alex Scammon's task/);
    expect(sys).toMatch(/bare "Alex" is ambiguous/);
    expect(sys).toMatch(/morasha@insightsoftmax\.com/);
    expect(sys).toMatch(/Marasha or Mirasha/);
    expect(sys).toMatch(/labelled ALEX are Alex Scammon/);
    expect(sys).toMatch(/Fireflies action items .* UNRELIABLE/);
    expect(sys).toMatch(/decision/);
    expect(sys).toMatch(/not the right time/);
    expect(sys).toMatch(/each member should/);
    expect(sys).toMatch(/owed.*|delivers? something TO Alex|deliver something TO Alex/);
    expect(sys).toMatch(/Other people's work that Alex does not need back is NOT waiting/);
    expect(sys).toMatch(/copy EXACTLY one section name listed in the catalogue/);
    expect(req.temperature).toBe(0);
    expect(req.schema.type).toBe('object');
    const props = req.schema.properties.items.items.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['title', 'kind', 'owner', 'ownerName', 'category', 'quote', 'why', 'due', 'resurface', 'confidence', 'project', 'section', 'timestampSec']));
    expect(props.ref).toBeUndefined();
  });

  test('user prompt: participants labelled, route hint, catalogue, summary, transcript speakers', () => {
    const ctx = setup();
    ctx.Extract.meeting(granolaMeeting(), { routeHint: { project: 'GR', confidence: 'high', reason: 'calendar alex@gr-oss.io' }, sectionHint: 'GR/Arctos', sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/Title: Secure Copy\/Paste Internal Sync/);
    expect(user).toMatch(/Date: Thu 24 Sep 2026 09:00 \(2026-09-24\)/);
    expect(user).toMatch(/Today: 2026-09-28/);
    expect(user).toMatch(/Alex Scammon <alex@gr-oss\.io> \[ALEX\]/);
    expect(user).toMatch(/Morasha <morasha@insightsoftmax\.com> \[Alex's assistant\]/);
    expect(user).toMatch(/Miro Knejp <miro@gr-oss\.io>$/m);
    expect(user).toMatch(/Route hint: project GR \(high: calendar alex@gr-oss\.io\)\. Section hint: GR\/Arctos/);
    expect(user).toMatch(/GR: Reach Out \| Team Logistics/);
    expect(user).toMatch(/SG: \(no sections: use null\)/);
    expect(user).toMatch(/AI SUMMARY \(Granola; may misattribute ownership\)/);
    expect(user).toMatch(/\[00:12\] ALEX: I will send the build notes after this\./);
    expect(user).toMatch(/\[01:15\] OTHER: I can get you the port branch by Friday\./);
    expect(user).toMatch(/\[1:01:40\] OTHER: Each member/);
  });

  test('Fireflies speakers: Alex Blundell flagged NOT Alex, bare "Alex" flagged ambiguous, action items marked unreliable', () => {
    const ctx = setup();
    ctx.Extract.meeting(firefliesMeeting(), { sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/\[12:03\] OTHER \(Alex Blundell, NOT Alex Scammon\): I will send the AWS invoice/);
    expect(user).toMatch(/\[20:10\] ALEX: I'll intro Marcus/);
    expect(user).toMatch(/OTHER\? \(Alex: ambiguous, may be Alex Blundell\)/);
    expect(user).toMatch(/Alex Blundell <ablundell@insightsoftmax\.com> \[NOT ALEX: different person\]/);
    expect(user).toMatch(/FIREFLIES ACTION ITEMS \(grouped by speaker name: UNRELIABLE for ownership, hints only\)/);
    expect(user).toMatch(/Route hint: none: decide the project from the content/);
  });

  test('Granola "them" is never ALEX, even when named like Alex', () => {
    const ctx = setup();
    expect(ctx.Extract.speakerLabel_({ speaker: 'them', name: 'Alex Scammon' })).toBe('OTHER');
    expect(ctx.Extract.speakerLabel_({ speaker: 'me', name: 'Alex Blundell' })).toBe('ALEX');
    expect(ctx.Extract.speakerLabel_({ speaker: 'unknown', name: 'Miro Knejp' })).toBe('OTHER (Miro Knejp)');
  });

  test('no transcript -> conservative instruction', () => {
    const ctx = setup();
    const m = granolaMeeting();
    m.transcript = null;
    ctx.Extract.meeting(m, { sectionsByProject: CATALOGUE, feedback: [] });
    expect(ctx.Claude.json.mock.calls[0][0].user).toMatch(/TRANSCRIPT: not available\. Be conservative/);
  });

  test('long transcripts keep the head and the tail with an omission marker', () => {
    const ctx = setup();
    ctx.Extract.TRANSCRIPT_CHARS = 400;
    const m = granolaMeeting();
    m.transcript = Array.from({ length: 50 }, (_, i) => ({ speaker: i % 2 ? 'them' : 'me', name: null, text: 'line number ' + i, t: i * 10 }));
    ctx.Extract.meeting(m, { sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/line number 0$/m);
    expect(user).toMatch(/line number 49$/m);
    expect(user).toMatch(/\[… \d+ transcript lines omitted …\]/);
  });

  test('recent dismissals become negative examples (default read from Store, only dismissed)', () => {
    const ctx = setup();
    ctx.Store.feedbackRecent.mockReturnValue([
      { type: 'dismissed', title: 'Review the team OKRs', sourceKey: 'granola:not_1', detail: { reason: 'group item' } },
      { type: 'not_duplicate', title: 'Should not appear', sourceKey: 'gmail:1', detail: {} },
      { type: 'dismissed', title: 'Send a thank-you note', sourceKey: 'gmail:abc:def', detail: null }
    ]);
    ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE });
    expect(ctx.Store.feedbackRecent).toHaveBeenCalledWith(100);
    const sys = ctx.Claude.json.mock.calls[0][0].system;
    expect(sys).toMatch(/PREVIOUSLY DISMISSED/);
    expect(sys).toMatch(/- "Review the team OKRs" \[granola\] \(reason: group item\)/);
    expect(sys).toMatch(/- "Send a thank-you note" \[gmail\]/);
    expect(sys).not.toMatch(/Should not appear/);
  });

  describe('undone dismissals are not negative examples', () => {
    const sysFor = (ctx, rows) => {
      ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: rows });
      return ctx.Claude.json.mock.calls[ctx.Claude.json.mock.calls.length - 1][0].system;
    };
    const T1 = '2026-09-20T10:00:00.000Z', T2 = '2026-09-21T10:00:00.000Z', T3 = '2026-09-22T10:00:00.000Z';

    test('an undo matched by detail.at withdraws that dismissal only', () => {
      const ctx = setup();
      const sys = sysFor(ctx, [
        { at: T3, type: 'undone', queueId: 'q1', title: 'Book the offsite venue', detail: { action: 'dismiss', at: T1 } },
        { at: T2, type: 'dismissed', queueId: 'q2', title: 'Order new laptops', detail: {} },
        { at: T1, type: 'dismissed', queueId: 'q1', title: 'Book the offsite venue', detail: {} }
      ]);
      expect(sys).not.toMatch(/Book the offsite venue/);
      expect(sys).toMatch(/- "Order new laptops"/);
    });

    test('dismiss, undo, dismiss again: the re-dismissal stands', () => {
      const ctx = setup();
      const sys = sysFor(ctx, [
        { at: T3, type: 'dismissed', queueId: 'q1', title: 'Book the offsite venue', detail: {} },
        { at: T2, type: 'undone', queueId: 'q1', title: 'Book the offsite venue', detail: JSON.stringify({ action: 'dismiss', at: T1 }) },
        { at: T1, type: 'dismissed', queueId: 'q1', title: 'Book the offsite venue', detail: {} }
      ]);
      expect(sys.match(/Book the offsite venue/g)).toHaveLength(1);
    });

    test('an undo without detail.at withdraws the newest earlier dismissal of that item', () => {
      const ctx = setup();
      const sys = sysFor(ctx, [
        { at: T3, type: 'dismissed', queueId: 'q1', title: 'Later dismissal', detail: {} },
        { at: T2, type: 'undone', queueId: 'q1', title: 'x', detail: { action: 'dismiss' } },
        { at: T1, type: 'dismissed', queueId: 'q1', title: 'Earlier dismissal', detail: {} }
      ]);
      expect(sys).toMatch(/Later dismissal/);
      expect(sys).not.toMatch(/Earlier dismissal/);
    });

    test('undos of other actions or other items change nothing', () => {
      const ctx = setup();
      const sys = sysFor(ctx, [
        { at: T3, type: 'undone', queueId: 'q1', title: 'Book the offsite venue', detail: { action: 'edit', at: T1 } },
        { at: T3, type: 'undone', queueId: 'q9', title: 'Book the offsite venue', detail: { action: 'dismiss', at: T1 } },
        { at: T1, type: 'dismissed', queueId: 'q1', title: 'Book the offsite venue', detail: {} }
      ]);
      expect(sys).toMatch(/- "Book the offsite venue"/);
    });

    test('the default Store read includes undone rows and applies them', () => {
      const ctx = setup();
      ctx.Store.feedbackRecent.mockReturnValue([
        { at: T2, type: 'undone', queueId: 'q1', title: 'Book the offsite venue', detail: { action: 'dismiss', at: T1 } },
        { at: T2, type: 'rerouted', queueId: 'q3', title: 'Rerouted thing', detail: {} },
        { at: T1, type: 'dismissed', queueId: 'q1', title: 'Book the offsite venue', detail: {} },
        { at: T1, type: 'dismissed', queueId: 'q2', title: 'Order new laptops', detail: {} }
      ]);
      ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE });
      const sys = ctx.Claude.json.mock.calls[0][0].system;
      expect(sys).not.toMatch(/Book the offsite venue/);
      expect(sys).not.toMatch(/Rerouted thing/);
      expect(sys).toMatch(/- "Order new laptops"/);
      expect(ctx.Extract.dismissalFeedback().map(f => f.type)).toEqual(['undone', 'dismissed', 'dismissed']);
    });
  });

  test('dismissals capped at 20; Store failure does not break extraction', () => {
    const ctx = setup();
    const rows = Array.from({ length: 30 }, (_, i) => ({ type: 'dismissed', title: 'Dismissed ' + i }));
    ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: rows });
    const sys = ctx.Claude.json.mock.calls[0][0].system;
    expect(sys).toMatch(/Dismissed 19"/);
    expect(sys).not.toMatch(/Dismissed 20"/);

    ctx.Store.feedbackRecent.mockImplementation(() => { throw new Error('sheet gone'); });
    expect(() => ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE })).not.toThrow();
    expect(ctx.Claude.json.mock.calls[1][0].system).not.toMatch(/PREVIOUSLY DISMISSED/);
  });

  test('uses the live section catalogue when none is passed, without neverUseSections', () => {
    const ctx = setup();
    ctx.Extract.meeting(granolaMeeting(), { feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(ctx.Todoist.sectionCatalogue).toHaveBeenCalled();
    expect(user).not.toMatch(/Generated Tasks/);
  });

  test('project guide can be overridden through ROUTING.projectGuide', () => {
    const ctx = setup({ ROUTING: JSON.stringify({ projectGuide: { SG: 'The studio (custom text)' } }) });
    ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: [] });
    const sys = ctx.Claude.json.mock.calls[0][0].system;
    expect(sys).toMatch(/SG: The studio \(custom text\)/);
    expect(sys).toMatch(/GR: G-Research open source/);
  });
});

describe('Extract.meeting post-processing', () => {
  function run(items, meeting) {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ items });
    return ctx.Extract.meeting(meeting || granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: [] });
  }

  test('keeps a clean todo and a waiting item owed to Alex', () => {
    const out = run([
      item(),
      item({ title: 'Get the C++ port branch from Mihailo', kind: 'waiting', owner: 'other', ownerName: 'Mihailo Marinkovic', ownerEmail: 'Mihailo@GR-OSS.io', resurface: '2026-09-25', due: null, confidence: 'med', section: 'Tech Projects', timestampSec: 75.4 })
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: 'Send the build notes to Mihailo', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
      quote: 'I will send the build notes.', why: 'Alex committed to it.', due: null, resurface: null,
      confidence: 'high', project: 'GR', section: 'Tech Projects', timestampSec: 12
    });
    expect(out[1]).toEqual(expect.objectContaining({ kind: 'waiting', owner: 'other', ownerName: 'Mihailo Marinkovic', ownerEmail: 'mihailo@gr-oss.io', resurface: '2026-09-25', timestampSec: 75 }));
  });

  test('Alex Blundell exclusion: his todos are dropped however the model labels them', () => {
    const out = run([
      item({ title: 'Send the AWS invoice to finance', ownerName: 'Alex Blundell' }),
      item({ title: 'Alex Blundell to send the AWS invoice to finance', ownerName: null }),
      item({ title: 'Send the AWS invoice', owner: 'other', ownerName: 'alex  blundell' })
    ], firefliesMeeting());
    expect(out).toEqual([]);
  });

  test('a waiting item owed BY Alex Blundell to Alex is kept', () => {
    const out = run([item({ title: 'Get the AWS invoice copy from Alex Blundell', kind: 'waiting', owner: 'other', ownerName: 'Alex Blundell' })], firefliesMeeting());
    expect(out).toHaveLength(1);
    expect(out[0].ownerName).toBe('Alex Blundell');
  });

  test('decisions, FYIs, deferred and group items are dropped', () => {
    const out = run([
      item({ title: 'Keep the C ABI', category: 'decision' }),
      item({ title: 'Note the release date', category: 'fyi' }),
      item({ title: 'Explore a Rust port', category: 'deferred' }),
      item({ title: 'Explore a Rust port', quote: 'Honestly not the right time for a Rust port.' }),
      item({ title: 'Rework the pricing model', quote: 'Good idea, but let\'s revisit that next quarter.' }),
      item({ title: 'Hire a designer', quote: 'Let\'s park this for now.' }),
      item({ title: 'Each member should review the threat model' }),
      item({ title: 'Everyone to fill in the survey' }),
      item({ title: 'Review the threat model', category: 'group' }),
      item({ title: 'Already sent the link', category: 'done' }),
      item({ title: 'Miro updates the CI', category: 'others_work' })
    ]);
    expect(out).toEqual([]);
  });

  test('todo owned by someone else is dropped; waiting "owed" by Alex becomes a todo', () => {
    const out = run([
      item({ title: 'Update the CI pipeline', owner: 'other', ownerName: 'Miro Knejp' }),
      item({ title: 'Send the slides to Jon', kind: 'waiting', owner: 'other', ownerName: 'Alex Scammon' }),
      item({ title: 'Book the room', kind: 'waiting', owner: 'me', ownerEmail: 'alex@gr-oss.io', ownerName: null })
    ]);
    expect(out.map(i => [i.title, i.kind, i.owner, i.ownerName])).toEqual([
      ['Send the slides to Jon', 'todo', 'me', null],
      ['Book the room', 'todo', 'me', null]
    ]);
  });

  test('waiting item without anyone named drops to low confidence', () => {
    const out = run([item({ title: 'Get the contract back', kind: 'waiting', owner: 'other', ownerName: null, confidence: 'high' })]);
    expect(out[0].confidence).toBe('low');
  });

  test('sections must come from the catalogue; neverUseSections and other projects nullified; case canonicalised', () => {
    const out = run([
      item({ title: 'A one', section: 'Made Up Section' }),
      item({ title: 'B two', section: 'Generated Tasks' }),
      item({ title: 'C three', section: 'kubecon / armada / cncf batch' }),
      item({ title: 'D four', project: 'ISC', section: 'Arctos' }),
      item({ title: 'E five', project: 'SG', section: 'Lease' }),
      item({ title: 'F six', project: 'Waiting on others', section: 'Reach Out' }),
      item({ title: 'G seven', project: 'me', section: 'cars' })
    ]);
    expect(out.map(i => [i.project, i.section])).toEqual([
      ['GR', null], ['GR', null], ['GR', 'KubeCon / Armada / CNCF Batch'], ['ISC', null], ['SG', null], [null, null], ['Me', 'Cars']
    ]);
  });

  test('clamps and cleans fields; validates enums and dates', () => {
    const long = 'Send ' + 'very '.repeat(40) + 'long title.';
    const out = run([
      item({ title: '  - ' + long, quote: 'q'.repeat(400), why: 'w'.repeat(400), due: '2026-02-30', confidence: 'certain', timestampSec: -3 }),
      item({ title: 'Alex will email Jon about the offsite', due: 'next Friday', resurface: '2026-10-01' }),
      item({ title: '   ' }),
      item({ title: null }),
      'not an object'
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].title.length).toBeLessThanOrEqual(120);
    expect(out[0].title.startsWith('Send very')).toBe(true);
    expect(out[0].title.endsWith('…')).toBe(true);
    expect(out[0].quote.length).toBe(300);
    expect(out[0].why.length).toBe(240);
    expect(out[0].due).toBeNull();
    expect(out[0].confidence).toBe('low');
    expect(out[0].timestampSec).toBeNull();
    expect(out[1].title).toBe('Email Jon about the offsite');
    expect(out[1].due).toBeNull();
    expect(out[1].resurface).toBeNull(); // todo items never resurface
  });

  test('near-identical titles are merged, keeping the higher confidence', () => {
    const out = run([
      item({ title: 'Send the build notes to Mihailo', confidence: 'med', quote: 'first' }),
      item({ title: 'Send build notes to Mihailo.', confidence: 'high', quote: 'second' }),
      item({ title: 'Send the build notes to Mihailo', confidence: 'low', quote: 'third' })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].quote).toBe('second');
  });

  test('missing items array -> []', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({});
    expect(ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: [] })).toEqual([]);
  });

  test('Claude errors propagate so the caller can ledger an error', () => {
    const ctx = setup();
    ctx.Claude.json.mockImplementation(() => { throw new Error('Claude output truncated'); });
    expect(() => ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: [] })).toThrow('truncated');
  });
});

describe('Extract.email', () => {
  const threads = () => ([
    {
      threadId: 'th_1', subject: 'Last Mile HPC deck',
      routeHint: { project: 'ISC', confidence: 'med', reason: 'sent to alex@insightsoftmax.com' },
      messages: [
        { from: 'Jon Stumpf <jon@acme.com>', to: 'alex@insightsoftmax.com', date: new Date('2026-09-26T15:00:00Z'), plain: 'Could you send me the Last Mile HPC deck?\n\nOn Fri, Jon wrote:\n> old stuff' },
        { from: 'Alex Scammon <alex@insightsoftmax.com>', to: 'jon@acme.com', date: new Date('2026-09-26T16:00:00Z'), plain: 'Sure, I\'ll send it Monday.\n> quoted line' }
      ]
    },
    { id: 'th_2', subject: 'Newsletter', messages: [{ from: 'news@vendor.com', to: 'alex@alexscammon.com', body: '<p>Big <b>sale</b></p>' }] }
  ]);

  test('prompt has refs, Alex-authored markers, stripped quotes, email rules', () => {
    const ctx = setup();
    ctx.Extract.email(threads(), { sectionsByProject: CATALOGUE, feedback: [] });
    const req = ctx.Claude.json.mock.calls[0][0];
    expect(req.system).toMatch(/EMAIL RULES/);
    expect(req.system).toMatch(/Messages from Alex's addresses are written by Alex/);
    expect(req.system).toMatch(/NOT ALEX: Alex Blundell/);
    expect(req.schema.properties.items.items.required).toContain('ref');
    expect(req.user).toMatch(/=== \[T1\] THREAD: Last Mile HPC deck/);
    expect(req.user).toMatch(/Route hint: project ISC \(med: sent to alex@insightsoftmax\.com\)/);
    expect(req.user).toMatch(/From: Alex Scammon <alex@insightsoftmax\.com> \(from Alex\)/);
    expect(req.user).toMatch(/Sure, I'll send it Monday\./);
    expect(req.user).not.toMatch(/old stuff/);
    expect(req.user).not.toMatch(/quoted line/);
    expect(req.user).toMatch(/=== \[T2\] THREAD: Newsletter/);
    expect(req.user).toMatch(/Big sale/);
  });

  test('items map back to thread ids; unknown refs dropped; no timestamps', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({
      items: [
        item({ ref: 'T1', title: 'Send the Last Mile HPC deck to Jon Stumpf', project: 'ISC', section: 'Reach Out', timestampSec: 5 }),
        item({ ref: '[T2]', title: 'Unsubscribe from vendor newsletter', confidence: 'low' }),
        item({ ref: 'T9', title: 'Hallucinated thread' })
      ]
    });
    const out = ctx.Extract.email(threads(), { sectionsByProject: CATALOGUE, feedback: [] });
    expect(out.map(i => [i.ref, i.title, i.section, i.timestampSec])).toEqual([
      ['th_1', 'Send the Last Mile HPC deck to Jon Stumpf', 'Reach Out', null],
      ['th_2', 'Unsubscribe from vendor newsletter', 'Tech Projects', null]
    ]);
  });

  test('same title in two different threads is kept twice', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ items: [item({ ref: 'T1', title: 'Reply to Jon' }), item({ ref: 'T2', title: 'Reply to Jon' })] });
    expect(ctx.Extract.email(threads(), { sectionsByProject: CATALOGUE, feedback: [] })).toHaveLength(2);
  });

  test('accepts GmailThread-like objects', () => {
    const ctx = setup();
    const msg = { getFrom: () => 'pat@cncf.io', getTo: () => 'alex@gr-oss.io', getCc: () => '', getDate: () => new Date('2026-09-27T10:00:00Z'), getPlainBody: () => 'Can you review the CFP?' };
    const thread = { getId: () => 'gth_9', getFirstMessageSubject: () => 'CFP review', getMessages: () => [msg] };
    ctx.Claude.json.mockReturnValue({ items: [item({ ref: 'T1', title: 'Review the CFP for Pat' })] });
    const out = ctx.Extract.email([thread], { sectionsByProject: CATALOGUE, feedback: [] });
    expect(ctx.Claude.json.mock.calls[0][0].user).toMatch(/Can you review the CFP\?/);
    expect(out[0].ref).toBe('gth_9');
  });

  test('empty input -> no Claude call', () => {
    const ctx = setup();
    expect(ctx.Extract.email([], {})).toEqual([]);
    expect(ctx.Extract.email([{ subject: 'no id' }], {})).toEqual([]);
    expect(ctx.Claude.json).not.toHaveBeenCalled();
  });

  test('only the last messages are shown', () => {
    const ctx = setup();
    const t = { threadId: 'th', subject: 's', messages: Array.from({ length: 9 }, (_, i) => ({ from: 'x@y.com', plain: 'message ' + i })) };
    ctx.Extract.email([t], { sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/\[3 earlier messages omitted\]/);
    expect(user).not.toMatch(/message 2\b/);
    expect(user).toMatch(/message 8/);
  });
});

describe('Extract.slack', () => {
  const msgs = () => ([
    { key: 'slack:ISC:C1:1727400000.000100', workspace: 'ISC', channel: 'C1', channelName: 'sales', ts: '1727400000.000100', userName: 'Marcus', text: '<@UALEX> can you send <https://x.io/deck|the deck> to <@UBOB>?', permalink: 'https://isc.slack.com/p1' },
    { key: 'slack:ISC:D1:1727400100.000200', workspace: 'ISC', channel: 'D1', ts: '1727400100.000200', isDm: true, isMine: true, text: 'I\'ll review it tonight', context: [{ userName: 'Seth', text: 'Can you review the budget?' }] },
    { key: 'slack:ISC:C1:x', text: '' }
  ]);

  test('prompt resolves mentions, marks DMs and Alex-authored messages', () => {
    const ctx = setup();
    ctx.Extract.slack(msgs(), { me: { userId: 'UALEX' }, users: { UBOB: 'Bob' }, project: 'ISC', sectionsByProject: CATALOGUE, feedback: [] });
    const req = ctx.Claude.json.mock.calls[0][0];
    expect(req.system).toMatch(/SLACK RULES/);
    expect(req.user).toMatch(/Workspace default project: ISC/);
    expect(req.user).toMatch(/=== \[M1\] ISC · #sales/);
    expect(req.user).toMatch(/Marcus: @Alex Scammon can you send the deck \(https:\/\/x\.io\/deck\) to @Bob\?/);
    expect(req.user).toMatch(/=== \[M2\] ISC · DM/);
    expect(req.user).toMatch(/\(context\) Seth: Can you review the budget\?/);
    expect(req.user).toMatch(/Alex Scammon \(from Alex\): I'll review it tonight/);
    expect(req.user).not.toMatch(/\[M3\]/);
  });

  test('items map to message keys and carry the permalink', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ items: [item({ ref: 'M1', title: 'Send the deck to Bob', project: 'ISC', section: 'Marketing' }), item({ ref: 'M2', title: 'Review the budget for Seth', project: 'ISC', section: null })] });
    const out = ctx.Extract.slack(msgs(), { me: { userId: 'UALEX' }, sectionsByProject: CATALOGUE, feedback: [] });
    expect(out[0]).toEqual(expect.objectContaining({ ref: 'slack:ISC:C1:1727400000.000100', permalink: 'https://isc.slack.com/p1', section: 'Marketing', timestampSec: null }));
    expect(out[1].ref).toBe('slack:ISC:D1:1727400100.000200');
    expect(out[1].permalink).toBeUndefined();
  });

  test('no messages with text -> no call', () => {
    const ctx = setup();
    expect(ctx.Extract.slack([{ key: 'k', text: '' }], {})).toEqual([]);
    expect(ctx.Claude.json).not.toHaveBeenCalled();
  });
});

describe('Extract.resolution', () => {
  const waiting = { title: 'Get the C++ port branch from Mihailo', ownerName: 'Mihailo Marinkovic', ownerEmail: 'mihailo@gr-oss.io', createdAt: '2026-09-24T16:30:00Z', quote: 'I can get you the port branch by Friday.' };
  const evidence = [
    { source: 'gmail', date: '2026-09-26T09:00:00Z', from: 'mihailo@gr-oss.io', title: 'Re: port', text: 'Here is the branch: https://github.com/x/y/tree/cpp', link: 'https://mail.google.com/mail/#all/m1' },
    { source: 'slack', date: '2026-09-27T09:00:00Z', from: 'Mihailo', text: 'will look at tests tomorrow', link: 'https://slack/p2' }
  ];

  test('no evidence -> not resolved without calling Claude', () => {
    const ctx = setup();
    expect(ctx.Extract.resolution(waiting, [])).toEqual({ resolved: false, confidence: 'low', reason: 'No evidence found since the item was created.', evidenceLink: null });
    expect(ctx.Claude.json).not.toHaveBeenCalled();
  });

  test('resolved with a valid evidence ref returns its link; prompt lists the evidence', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ resolved: true, confidence: 'high', reason: 'Mihailo sent the branch link.', evidenceRef: 'E1' });
    const r = ctx.Extract.resolution(waiting, evidence);
    expect(r).toEqual({ resolved: true, confidence: 'high', reason: 'Mihailo sent the branch link.', evidenceLink: 'https://mail.google.com/mail/#all/m1' });
    const req = ctx.Claude.json.mock.calls[0][0];
    expect(req.schema.required).toEqual(['resolved', 'confidence', 'reason', 'evidenceRef']);
    expect(req.system).toMatch(/NOT resolved: promises to do it later/);
    expect(req.system).toMatch(/Alex Blundell is not Alex Scammon/);
    expect(req.user).toMatch(/WAITING ITEM: Get the C\+\+ port branch from Mihailo/);
    expect(req.user).toMatch(/Owed by: Mihailo Marinkovic <mihailo@gr-oss\.io>/);
    expect(req.user).toMatch(/=== \[E1\] gmail · .* · from mihailo@gr-oss\.io · Re: port/);
    expect(req.user).toMatch(/=== \[E2\] slack/);
  });

  test('resolved high without a valid ref is downgraded to med (no auto-close without proof)', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ resolved: true, confidence: 'high', reason: 'Done.', evidenceRef: 'E7' });
    expect(ctx.Extract.resolution(waiting, evidence)).toEqual({ resolved: true, confidence: 'med', reason: 'Done.', evidenceLink: null });
  });

  test('garbage output is normalised to not-resolved / low', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ resolved: 'yes', confidence: 'very', reason: '', evidenceRef: null });
    expect(ctx.Extract.resolution(waiting, evidence)).toEqual({ resolved: false, confidence: 'low', reason: 'No clear evidence it was done.', evidenceLink: null });
  });
});

describe('Extract helpers', () => {
  test('stripQuoted_ removes reply history', () => {
    const ctx = setup();
    expect(ctx.Extract.stripQuoted_('Top\r\n\r\n-----Original Message-----\r\nFrom: x')).toBe('Top');
    expect(ctx.Extract.stripQuoted_('Hi\nFrom: Bob\nSent: Monday\nold')).toBe('Hi');
    expect(ctx.Extract.stripQuoted_('Only\n> quoted\nkept')).toBe('Only\nkept');
  });

  test('isoOrNull_ validates real calendar dates', () => {
    const ctx = setup();
    expect(ctx.Extract.isoOrNull_('2026-10-02')).toBe('2026-10-02');
    expect(ctx.Extract.isoOrNull_('2026-13-01')).toBeNull();
    expect(ctx.Extract.isoOrNull_('2026-10-02T00:00')).toBeNull();
    expect(ctx.Extract.isoOrNull_(null)).toBeNull();
  });

  test('mmss_', () => {
    const ctx = setup();
    expect(ctx.Extract.mmss_(0)).toBe('00:00');
    expect(ctx.Extract.mmss_(75.9)).toBe('01:15');
    expect(ctx.Extract.mmss_(3700)).toBe('1:01:40');
  });
});

describe('Extract ownership of shared Granola notes', () => {
  // A note Alex Blundell shared with Alex Scammon. Granola.mapTranscript already maps the
  // owner's mic to 'them'; the raw 'me' segment below exercises Extract's own guard too.
  const shared = () => Object.assign(granolaMeeting(), {
    key: 'granola:not_shared', sourceId: 'not_shared',
    ownerIsMe: false, ownerName: 'Alex Blundell', ownerEmail: 'ablundell@insightsoftmax.com',
    transcript: [
      { speaker: 'me', name: null, text: 'I will send the AWS invoice to finance.', t: 30 },
      { speaker: 'them', name: 'Alex Blundell', text: 'And I will book the room.', t: 40 },
      { speaker: 'me', name: 'Alex Scammon', text: 'I will intro Marcus to Spectro.', t: 50 }
    ]
  });

  test('Source line names the owner and says the microphone is NOT Alex', () => {
    const ctx = setup();
    ctx.Extract.meeting(shared(), { sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/Source: Granola \(shared note owned by Alex Blundell <ablundell@insightsoftmax\.com> \[NOT ALEX: different person\]; microphone = Alex Blundell, NOT Alex\)/);
    expect(user).not.toMatch(/Alex's own note/);
  });

  test("owner's 'me' segments are labelled OTHER; a 'me' segment named as Alex Scammon stays ALEX", () => {
    const ctx = setup();
    ctx.Extract.meeting(shared(), { sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/\[00:30\] OTHER \(Alex Blundell, note owner, NOT Alex Scammon\): I will send the AWS invoice/);
    expect(user).toMatch(/\[00:40\] OTHER \(Alex Blundell, NOT Alex Scammon\): And I will book/);
    expect(user).toMatch(/\[00:50\] ALEX: I will intro Marcus/);
    expect(user).not.toMatch(/ALEX: I will send the AWS invoice/);
  });

  test("system prompt no longer claims the microphone is always Alex's", () => {
    const ctx = setup();
    ctx.Extract.meeting(shared(), { sectionsByProject: CATALOGUE, feedback: [] });
    const system = ctx.Claude.json.mock.calls[0][0].system;
    expect(system).not.toMatch(/always the note owner, Alex/);
    expect(system).toMatch(/microphone channel belongs to the NOTE OWNER/);
  });

  test("Alex's own note (ownerIsMe true, or no owner info) keeps microphone = Alex", () => {
    const ctx = setup();
    ctx.Extract.meeting(Object.assign(granolaMeeting(), { ownerIsMe: true, ownerEmail: 'alex@gr-oss.io' }), { sectionsByProject: CATALOGUE, feedback: [] });
    ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: [] });
    ctx.Claude.json.mock.calls.forEach(c => {
      expect(c[0].user).toMatch(/Source: Granola \(Alex's own note; microphone = Alex\)/);
      expect(c[0].user).toMatch(/\[00:12\] ALEX: I will send the build notes/);
    });
  });

  test('owner inferred from ownerEmail when ownerIsMe is absent', () => {
    const ctx = setup();
    expect(ctx.Extract.noteOwner_({ ownerEmail: 'ablundell@insightsoftmax.com' }).isMe).toBe(false);
    expect(ctx.Extract.noteOwner_({ ownerEmail: 'alex@insightsoftmax.com' }).isMe).toBe(true);
    expect(ctx.Extract.noteOwner_({}).isMe).toBe(true);
  });

  test('transcript borrowed from a shared Granola note in a merged Fireflies meeting is owner-labelled', () => {
    const ctx = setup();
    const m = Object.assign(firefliesMeeting(), {
      transcript: [{ speaker: 'me', name: null, text: 'I will send the AWS invoice.', t: 5 }],
      transcriptFrom: 'granola', transcriptOwnerIsMe: false, transcriptOwnerName: 'Alex Blundell'
    });
    ctx.Extract.meeting(m, { sectionsByProject: CATALOGUE, feedback: [] });
    const user = ctx.Claude.json.mock.calls[0][0].user;
    expect(user).toMatch(/Transcript taken from a Granola note \(shared note owned by Alex Blundell/);
    expect(user).toMatch(/\[00:05\] OTHER \(Alex Blundell, note owner, NOT Alex Scammon\)/);
  });
});

describe('Extract title clean-up', () => {
  function run(items) {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ items });
    return ctx.Extract.meeting(granolaMeeting(), { sectionsByProject: CATALOGUE, feedback: [] });
  }

  test('titles starting with a number keep it; only list markers are stripped', () => {
    const out = run([
      item({ title: '3D print the enclosure' }),
      item({ title: '2026 roadmap: send to Marcus' }),
      item({ title: '1. Book the venue' }),
      item({ title: '12) Renew the domain' }),
      item({ title: '- * Update the wiki' }),
      item({ title: '•Order cables' })
    ]);
    expect(out.map(i => i.title)).toEqual([
      '3D print the enclosure', '2026 roadmap: send to Marcus', 'Book the venue', 'Renew the domain', 'Update the wiki', 'Order cables'
    ]);
  });

  test('"I will" and "Alex Scammon will" are stripped silently, keeping confidence', () => {
    const out = run([
      item({ title: 'I will send the deck to Jon' }),
      item({ title: 'Alex Scammon to book flights to KubeCon' }),
      item({ title: 'Alexander should renew the SSL cert' })
    ]);
    expect(out.map(i => [i.title, i.confidence])).toEqual([
      ['Send the deck to Jon', 'high'], ['Book flights to KubeCon', 'high'], ['Renew the SSL cert', 'high']
    ]);
  });

  test('a bare "Alex will…" title is capped at low confidence and flagged in why', () => {
    const out = run([item({ title: 'Alex will send the deck to Jon', why: 'Assigned in the meeting.' })]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Send the deck to Jon');
    expect(out[0].confidence).toBe('low');
    expect(out[0].why).toBe('Ambiguous "Alex" (may not be Alex Scammon). Assigned in the meeting.');
  });

  test('"Alex Blundell will…" is still dropped', () => {
    expect(run([item({ title: 'Alex Blundell will send the invoice' })])).toEqual([]);
  });
});

describe('Extract.resolution evidence links', () => {
  test('resolved high citing evidence without a link is downgraded to med', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ resolved: true, confidence: 'high', reason: 'Said so in the meeting.', evidenceRef: 'E1' });
    const r = ctx.Extract.resolution({ title: 'Get the branch from Mihailo' }, [{ source: 'granola', text: 'Mihailo: I pushed the branch.' }]);
    expect(r).toEqual({ resolved: true, confidence: 'med', reason: 'Said so in the meeting.', evidenceLink: null });
  });

  test('not-resolved and med results are left alone', () => {
    const ctx = setup();
    ctx.Claude.json.mockReturnValue({ resolved: true, confidence: 'med', reason: 'Probably.', evidenceRef: 'E1' });
    expect(ctx.Extract.resolution({ title: 'x' }, [{ source: 'slack', text: 'done' }]).confidence).toBe('med');
  });
});
