const { loadGas } = require('./helpers/gas');

function setup() {
  const ctx = loadGas(['Config.js', 'Util.js', 'Dedupe.js'], { props: {}, timeZone: 'America/Los_Angeles' });
  ctx.Store = { feedbackRecent: jest.fn(() => []) };
  return ctx;
}

const T0 = Date.parse('2026-09-24T17:00:00Z');
const MIN = 60000;

const granola = extra => Object.assign({
  key: 'granola:not_abc', source: 'granola', sourceId: 'not_abc', title: 'Secure Copy/Paste Internal Sync',
  start: new Date(T0), end: new Date(T0 + 30 * MIN), url: 'https://notes.granola.ai/d/not_abc',
  attendees: [
    { name: 'Alex Scammon', email: 'alex@gr-oss.io' },
    { name: 'Miro Knejp', email: 'miro@gr-oss.io' },
    { name: 'Mihailo Marinkovic', email: 'mihailo@gr-oss.io' }
  ],
  organizerEmail: 'alex@gr-oss.io', calendarEventId: 'evt_1',
  summaryMarkdown: '## Summary', actionItemsText: null,
  transcript: [{ speaker: 'me', name: null, text: 'I will send the build notes.', t: 12 }],
  alsoRecordedBy: []
}, extra || {});

const fireflies = extra => Object.assign({
  key: 'fireflies:01FF', source: 'fireflies', sourceId: '01FF', title: 'Secure Copy Paste - internal sync',
  start: new Date(T0 + 3 * MIN), end: null, url: 'https://app.fireflies.ai/view/01FF',
  attendees: [{ name: 'Miro Knejp', email: 'miro@gr-oss.io' }],
  organizerEmail: null, calendarEventId: null,
  summaryMarkdown: 'FF overview', actionItemsText: 'Alex Blundell\n- Send invoice',
  transcript: [{ speaker: 'unknown', name: 'Miro Knejp', text: 'hello', t: 1 }],
  alsoRecordedBy: []
}, extra || {});

describe('Dedupe.mergeMeetings', () => {
  test('merges Granola + Fireflies of the same meeting, Granola primary, both keys recorded', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([fireflies(), granola()]);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.key).toBe('granola:not_abc');
    expect(m.mergedKeys).toEqual(['granola:not_abc', 'fireflies:01FF']);
    expect(m.alsoRecordedBy).toEqual([{ source: 'fireflies', sourceId: '01FF', url: 'https://app.fireflies.ai/view/01FF' }]);
    // primary already has a transcript -> kept
    expect(m.transcript[0].speaker).toBe('me');
    // secondary fills gaps
    expect(m.actionItemsText).toBe('Alex Blundell\n- Send invoice');
    expect(m.summaryMarkdown).toBe('## Summary');
  });

  test('attaches the Fireflies transcript only when the primary lacks one', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([granola({ transcript: null }), fireflies()]);
    expect(out[0].transcript[0].name).toBe('Miro Knejp');
    expect(out[0].transcriptFrom).toBe('fireflies');
  });

  test('title similarity alone is enough within the window', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([granola({ attendees: [] , organizerEmail: null}), fireflies({ attendees: [] })]);
    expect(out).toHaveLength(1);
  });

  test('shared attendee alone is enough even with a different title', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([granola({ title: 'New note' }), fireflies({ title: 'Weekly' })]);
    expect(out).toHaveLength(1);
  });

  test('only Alex in common and different titles -> not merged', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([
      granola({ title: 'New note' }),
      fireflies({ title: 'Weekly', attendees: [{ name: 'Alex Scammon', email: 'alex@gr-oss.io' }] })
    ]);
    expect(out).toHaveLength(2);
  });

  test('more than 10 minutes apart -> not merged', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([granola(), fireflies({ start: new Date(T0 + 11 * MIN) })]);
    expect(out).toHaveLength(2);
    expect(out.every(m => m.alsoRecordedBy.length === 0)).toBe(true);
    expect(out[0].mergedKeys).toEqual(['granola:not_abc']);
  });

  test('two notes from the same source never merge', () => {
    const ctx = setup();
    const out = ctx.Dedupe.mergeMeetings([granola(), granola({ key: 'granola:not_def', sourceId: 'not_def' })]);
    expect(out).toHaveLength(2);
  });

  test('accepts ISO start strings, sorts by start, does not mutate inputs', () => {
    const ctx = setup();
    const g = granola({ start: new Date(T0 + 60 * MIN).toISOString() });
    const f = fireflies({ start: new Date(T0).toISOString(), title: 'Other', attendees: [] });
    const out = ctx.Dedupe.mergeMeetings([g, f]);
    expect(out.map(m => m.key)).toEqual(['fireflies:01FF', 'granola:not_abc']);
    expect(g.mergedKeys).toBeUndefined();
    expect(g.alsoRecordedBy).toEqual([]);
  });

  test('empty / null input', () => {
    const ctx = setup();
    expect(ctx.Dedupe.mergeMeetings(null)).toEqual([]);
    expect(ctx.Dedupe.mergeMeetings([null])).toEqual([]);
  });
});

describe('Dedupe.matchTask', () => {
  const tasks = [
    { id: '101', content: 'Send the Last Mile HPC deck to Jon Stumpf' },
    { id: '102', content: 'Book flights for KubeCon' },
    { id: '103', content: '[Review Armada PR](https://github.com/armadaproject/armada/pull/1) @starred' },
    { id: '104', content: 'Mihailo Marinkovic: Share the C++ build instructions' }
  ];

  test('token Jaccard >= 0.5 matches', () => {
    const ctx = setup();
    const m = ctx.Dedupe.matchTask({ title: 'Send Last Mile HPC deck to Jon' }, tasks);
    expect(m.taskId).toBe('101');
    expect(m.title).toBe('Send the Last Mile HPC deck to Jon Stumpf');
    expect(m.score).toBeGreaterThanOrEqual(0.5);
  });

  test('containment >= 0.7 matches (short item inside a longer task)', () => {
    const ctx = setup();
    const m = ctx.Dedupe.matchTask({ title: 'Book KubeCon flights and hotel and visa and train' }, tasks);
    expect(m.taskId).toBe('102');
    expect(m.containment).toBe(1);
  });

  test('markdown links, @labels and "Name:" prefixes are stripped from task content', () => {
    const ctx = setup();
    expect(ctx.Dedupe.matchTask({ title: 'Review the Armada PR' }, tasks).taskId).toBe('103');
    expect(ctx.Dedupe.matchTask({ title: 'Share C++ build instructions' }, tasks).taskId).toBe('104');
    expect(ctx.Dedupe.taskText('Follow up with Jon Stumpf: Send deck')).toBe('Send deck');
  });

  test('unrelated items -> null; one shared word is not a containment match', () => {
    const ctx = setup();
    expect(ctx.Dedupe.matchTask({ title: 'Renew car registration' }, tasks)).toBeNull();
    expect(ctx.Dedupe.matchTask({ title: 'Flights' }, [{ id: '1', content: 'Flights to London for the offsite with the team' }])).toBeNull();
    expect(ctx.Dedupe.matchTask({ title: '' }, tasks)).toBeNull();
    expect(ctx.Dedupe.matchTask({ title: 'the a of' }, tasks)).toBeNull();
    expect(ctx.Dedupe.matchTask({ title: 'x' }, null)).toBeNull();
  });

  test('picks the best-scoring task', () => {
    const ctx = setup();
    const m = ctx.Dedupe.matchTask({ title: 'Send HPC deck to Jon Stumpf' }, [
      { id: '1', content: 'Send deck to Jon' },
      { id: '2', content: 'Send HPC deck to Jon Stumpf today' }
    ]);
    expect(m.taskId).toBe('2');
  });

  test('not_duplicate feedback for this queue item + task id suppresses the match', () => {
    const ctx = setup();
    const item = { id: 'q_1', title: 'Send Last Mile HPC deck to Jon' };
    const fb = [{ type: 'not_duplicate', queueId: 'q_1', title: 'whatever', detail: { taskId: '101' } }];
    expect(ctx.Dedupe.matchTask(item, tasks, fb)).toBeNull();
  });

  test('not_duplicate feedback matched by item title + task title (e.g. a re-extracted item)', () => {
    const ctx = setup();
    const item = { id: 'q_new', title: 'Send Last Mile HPC deck to Jon' };
    const fb = [{ type: 'not_duplicate', queueId: 'q_old', title: 'send last-mile HPC deck to Jon', detail: { taskTitle: 'Send the Last Mile HPC deck to Jon Stumpf' } }];
    expect(ctx.Dedupe.matchTask(item, tasks, fb)).toBeNull();
  });

  test('feedback for a different item, or of another type, does not suppress', () => {
    const ctx = setup();
    const item = { id: 'q_1', title: 'Send Last Mile HPC deck to Jon' };
    const fb = [
      { type: 'not_duplicate', queueId: 'q_other', title: 'Other thing', detail: { taskId: '101' } },
      { type: 'dismissed', queueId: 'q_1', title: item.title, detail: { taskId: '101' } }
    ];
    expect(ctx.Dedupe.matchTask(item, tasks, fb).taskId).toBe('101');
  });

  test('suppressing one task still allows a match with another', () => {
    const ctx = setup();
    const item = { id: 'q_1', title: 'Send HPC deck to Jon Stumpf' };
    const list = [{ id: '1', content: 'Send HPC deck to Jon Stumpf today' }, { id: '2', content: 'Send deck to Jon Stumpf' }];
    const m = ctx.Dedupe.matchTask(item, list, [{ type: 'not_duplicate', queueId: 'q_1', detail: { dupTaskId: '1' } }]);
    expect(m.taskId).toBe('2');
  });

  test('item.notDuplicate with dupTaskId suppresses that task', () => {
    const ctx = setup();
    const item = { id: 'q_1', title: 'Send Last Mile HPC deck to Jon', notDuplicate: true, dupTaskId: '101' };
    expect(ctx.Dedupe.matchTask(item, tasks, [])).toBeNull();
  });

  test('notDuplicateFeedback reads Store and survives errors', () => {
    const ctx = setup();
    ctx.Store.feedbackRecent.mockReturnValue([{ type: 'not_duplicate' }]);
    expect(ctx.Dedupe.notDuplicateFeedback()).toEqual([{ type: 'not_duplicate' }]);
    expect(ctx.Store.feedbackRecent).toHaveBeenCalledWith(200, 'not_duplicate');
    ctx.Store.feedbackRecent.mockImplementation(() => { throw new Error('no sheet'); });
    expect(ctx.Dedupe.notDuplicateFeedback()).toEqual([]);
  });
});

describe('Dedupe helpers', () => {
  test('uniqueTitles keeps the first of near-identical titles', () => {
    const ctx = setup();
    const out = ctx.Dedupe.uniqueTitles([
      { title: 'Send the deck to Jon' }, { title: 'Send deck to Jon.' }, { title: 'Book flights' }
    ]);
    expect(out.map(i => i.title)).toEqual(['Send the deck to Jon', 'Book flights']);
  });

  test('titleSimilarity', () => {
    const ctx = setup();
    expect(ctx.Dedupe.titleSimilarity('Secure Copy/Paste Sync', 'secure copy paste sync')).toBe(1);
    expect(ctx.Dedupe.titleSimilarity('New note', 'Weekly')).toBe(0);
  });
});
