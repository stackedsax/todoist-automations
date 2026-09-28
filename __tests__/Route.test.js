const { loadGas } = require('./helpers/gas');

const CATALOGUE = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA', 'Generated Tasks'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

function setup(props) {
  const ctx = loadGas(['Config.js', 'Util.js', 'Route.js'], { props: props || {}, timeZone: 'America/Los_Angeles' });
  ctx.Todoist = { sectionCatalogue: jest.fn(keys => { const o = {}; keys.forEach(k => { o[k] = CATALOGUE[k].slice(); }); return o; }) };
  return ctx;
}

const meeting = (attendees, extra) => Object.assign({
  key: 'granola:not_1', source: 'granola', sourceId: 'not_1', title: 'Sync',
  start: new Date('2026-09-24T17:00:00Z'), attendees: attendees || [], organizerEmail: null, calendarEventId: 'evt_1'
}, extra || {});
const a = (email, name) => ({ name: name || email.split('@')[0], email });

describe('Route.project', () => {
  test('calendar email beats attendee domains and is high confidence', () => {
    const ctx = setup();
    const m = meeting([a('miro@gr-oss.io'), a('mihailo@gr-oss.io')]);
    const r = ctx.Route.project(m, { calendarEmail: 'Alex@InsightSoftmax.com', eventTitle: 'Sync', attendeeEmails: [] });
    expect(r).toEqual({ project: 'ISC', confidence: 'high', reason: 'calendar alex@insightsoftmax.com' });
  });

  test('unmapped calendar falls through to domains', () => {
    const ctx = setup();
    const r = ctx.Route.project(meeting([a('miro@gr-oss.io')]), { calendarEmail: 'someone@else.com' });
    expect(r.project).toBe('GR');
    expect(r.confidence).toBe('high');
  });

  test('unanimous attendee domains -> high; own addresses, assistants and generic providers ignored', () => {
    const ctx = setup();
    const m = meeting([
      a('alex@insightsoftmax.com', 'Alex Scammon'), a('morasha@insightsoftmax.com', 'Morasha'),
      a('miro@gr-oss.io'), a('dan@gresearch.co.uk'), a('friend@gmail.com')
    ]);
    const r = ctx.Route.project(m, null);
    expect(r.project).toBe('GR');
    expect(r.confidence).toBe('high');
    expect(r.reason).toMatch(/GR 2/);
  });

  test('majority of mapped domains -> med, unmapped externals do not block it', () => {
    const ctx = setup();
    const m = meeting([a('a@insightsoftmax.com'), a('b@insightsoftmax.com'), a('c@gr-oss.io'), a('client@acme.com')]);
    const r = ctx.Route.project(m, null);
    expect(r).toEqual(expect.objectContaining({ project: 'ISC', confidence: 'med' }));
  });

  test('mapped + unmapped externals, single mapped project -> med (not unanimous)', () => {
    const ctx = setup();
    const r = ctx.Route.project(meeting([a('a@insightsoftmax.com'), a('client@acme.com')]), null);
    expect(r).toEqual(expect.objectContaining({ project: 'ISC', confidence: 'med' }));
  });

  test('split domains -> no project, low', () => {
    const ctx = setup();
    const r = ctx.Route.project(meeting([a('a@insightsoftmax.com'), a('c@gr-oss.io')]), null);
    expect(r.project).toBeNull();
    expect(r.confidence).toBe('low');
  });

  test('subdomains match their parent domain; organiser counts', () => {
    const ctx = setup();
    const r = ctx.Route.project(meeting([], { organizerEmail: 'Pat <pat@mail.gresearch.co.uk>' }), { calendarEmail: null, attendeeEmails: ['x@armadaproject.io'] });
    expect(r.project).toBe('GR');
    expect(r.confidence).toBe('high');
  });

  test('note without a calendar event and no attendees -> route by content, low', () => {
    const ctx = setup();
    const r = ctx.Route.project(meeting([], { calendarEventId: null, title: 'New note' }), null);
    expect(r).toEqual({ project: null, confidence: 'low', reason: 'no calendar event; route by content' });
  });

  test('note without a calendar event but with attendee domains is capped at low', () => {
    const ctx = setup();
    const r = ctx.Route.project(meeting([a('miro@gr-oss.io')], { calendarEventId: null }), null);
    expect(r.project).toBe('GR');
    expect(r.confidence).toBe('low');
  });

  test('ROUTING override adds calendars and domains', () => {
    const ctx = setup({ ROUTING: JSON.stringify({ calendars: { 'studio@sg.example': 'SG' }, domains: { 'acme.com': 'ISC' } }) });
    expect(ctx.Route.project(meeting([]), { calendarEmail: 'studio@sg.example' }).project).toBe('SG');
    expect(ctx.Route.project(meeting([a('x@acme.com')]), null)).toEqual(expect.objectContaining({ project: 'ISC', confidence: 'high' }));
    // defaults still merged in
    expect(ctx.Route.project(meeting([]), { calendarEmail: 'alex@gr-oss.io' }).project).toBe('GR');
  });

  test('calendar mapped to a non-routable key (Waiting) is ignored', () => {
    const ctx = setup({ ROUTING: JSON.stringify({ calendars: { 'odd@x.com': 'Waiting' } }) });
    const r = ctx.Route.project(meeting([a('a@insightsoftmax.com')]), { calendarEmail: 'odd@x.com' });
    expect(r.project).toBe('ISC');
  });
});

describe('Route.email', () => {
  test('the Alex address a thread was sent to decides (med)', () => {
    const ctx = setup();
    const r = ctx.Route.email({ messages: [{ from: 'Jon <jon@acme.com>', to: 'Alex Scammon <alex@gr-oss.io>', cc: '' }] });
    expect(r).toEqual({ project: 'GR', confidence: 'med', reason: 'sent to alex@gr-oss.io' });
  });

  test('thread-level to/cc and multiple recipients are parsed', () => {
    const ctx = setup();
    const r = ctx.Route.email({ to: '"Scammon, Alex" <alex@insightsoftmax.com>, bob@acme.com', messages: [] });
    expect(r.project).toBe('ISC');
  });

  test('several of Alex\'s addresses -> fall back to other participants\' domains, capped at med', () => {
    const ctx = setup();
    const r = ctx.Route.email({ messages: [{ from: 'pat@cncf.io', to: 'alex@gr-oss.io, alex@alexscammon.com' }] });
    expect(r.project).toBe('GR');
    expect(r.confidence).toBe('med');
  });

  test('nothing usable -> null/low', () => {
    const ctx = setup();
    const r = ctx.Route.email({ messages: [{ from: 'x@gmail.com', to: 'alex@gr-oss.io, alex@alexscammon.com' }] });
    expect(r.project).toBeNull();
    expect(r.confidence).toBe('low');
  });
});

describe('sections', () => {
  test('sectionCatalogue asks Todoist for GR/ISC/Me/SG and drops neverUseSections', () => {
    const ctx = setup();
    const cat = ctx.Route.sectionCatalogue();
    expect(ctx.Todoist.sectionCatalogue).toHaveBeenCalledWith(['GR', 'ISC', 'Me', 'SG']);
    expect(cat.GR).not.toContain('Generated Tasks');
    expect(cat.GR).toContain('Arctos');
    expect(cat.SG).toEqual([]);
  });

  test('section() returns the catalogue spelling, null for unknown / neverUse / other project', () => {
    const ctx = setup();
    expect(ctx.Route.section('GR', '  kubecon / armada / cncf batch ', CATALOGUE)).toBe('KubeCon / Armada / CNCF Batch');
    expect(ctx.Route.section('GR', 'Generated Tasks', CATALOGUE)).toBeNull();
    expect(ctx.Route.section('GR', 'Quantum', CATALOGUE)).toBeNull();
    expect(ctx.Route.section('SG', 'Anything', CATALOGUE)).toBeNull();
    expect(ctx.Route.section(null, 'Arctos', CATALOGUE)).toBeNull();
    expect(ctx.Route.section('ISC', 'Quantum')).toBe('Quantum'); // default catalogue via Todoist
  });

  test('sectionHint uses routing.sectionHints by participant domain', () => {
    const ctx = setup();
    expect(ctx.Route.sectionHint(['x@arctosalliance.org', 'alex@gr-oss.io'])).toBe('GR/Arctos');
    expect(ctx.Route.sectionHint(['x@acme.com'])).toBeNull();
  });

  test('normalizeKey / isKey', () => {
    const ctx = setup();
    expect(ctx.Route.normalizeKey('gr')).toBe('GR');
    expect(ctx.Route.normalizeKey('me')).toBe('Me');
    expect(ctx.Route.normalizeKey('Waiting')).toBeNull();
    expect(ctx.Route.isKey('SG')).toBe(true);
  });
});

describe('Route.finalize', () => {
  test('high route wins over a disagreeing LLM but drops to med', () => {
    const ctx = setup();
    const f = ctx.Route.finalize({ project: 'ISC', confidence: 'high' }, { project: 'GR', section: 'Arctos' }, CATALOGUE);
    expect(f).toEqual({ project: 'ISC', section: null, routeConfidence: 'med' });
  });

  test('agreeing LLM keeps route confidence and a valid section', () => {
    const ctx = setup();
    const f = ctx.Route.finalize({ project: 'GR', confidence: 'high' }, { project: 'GR', section: 'arctos' }, CATALOGUE);
    expect(f).toEqual({ project: 'GR', section: 'Arctos', routeConfidence: 'high' });
  });

  test('med route + disagreement -> low', () => {
    const ctx = setup();
    expect(ctx.Route.finalize({ project: 'GR', confidence: 'med' }, { project: 'Me' }, CATALOGUE).routeConfidence).toBe('low');
  });

  test('no route -> LLM project capped at low', () => {
    const ctx = setup();
    const f = ctx.Route.finalize({ project: null, confidence: 'low' }, { project: 'Me', section: 'Cars' }, CATALOGUE);
    expect(f).toEqual({ project: 'Me', section: 'Cars', routeConfidence: 'low' });
  });

  test('low route with a project -> content (LLM) decides; falls back to route project', () => {
    const ctx = setup();
    expect(ctx.Route.finalize({ project: 'GR', confidence: 'low' }, { project: 'ISC' }, CATALOGUE).project).toBe('ISC');
    expect(ctx.Route.finalize({ project: 'GR', confidence: 'low' }, { project: null }, CATALOGUE)).toEqual({ project: 'GR', section: null, routeConfidence: 'low' });
  });

  test('nothing at all -> null project', () => {
    const ctx = setup();
    expect(ctx.Route.finalize(null, {}, CATALOGUE)).toEqual({ project: null, section: null, routeConfidence: 'low' });
  });

  test('minConfidence', () => {
    const ctx = setup();
    expect(ctx.Route.minConfidence('high', 'med')).toBe('med');
    expect(ctx.Route.minConfidence('low', 'high')).toBe('low');
    expect(ctx.Route.minConfidence('bogus', 'high')).toBe('low');
  });
});
