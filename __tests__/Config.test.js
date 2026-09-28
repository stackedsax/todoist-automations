const { loadGas } = require('./helpers/gas');

const load = props => loadGas(['Config.js'], { props: props || {} });

describe('Config', () => {
  test('get returns value, default, or null', () => {
    const ctx = load({ A: 'x', EMPTY: '' });
    expect(ctx.Config.get('A')).toBe('x');
    expect(ctx.Config.get('MISSING', 'd')).toBe('d');
    expect(ctx.Config.get('MISSING')).toBeNull();
    expect(ctx.Config.get('EMPTY', 'd')).toBe('d');
  });

  test('set stores strings and deletes on null', () => {
    const ctx = load();
    ctx.Config.set('STATE_SHEET_ID', 123);
    expect(ctx.__mocks.props.STATE_SHEET_ID).toBe('123');
    ctx.Config.set('STATE_SHEET_ID', null);
    expect(ctx.__mocks.props.STATE_SHEET_ID).toBeUndefined();
  });

  test('require throws a helpful error naming the key', () => {
    const ctx = load();
    expect(() => ctx.Config.require('TODOIST_API_TOKEN')).toThrow(/Missing Script Property: TODOIST_API_TOKEN/);
    expect(() => ctx.Config.require('TODOIST_API_TOKEN')).toThrow(/Project Settings > Script Properties/);
    const ok = load({ TODOIST_API_TOKEN: 'tok' });
    expect(ok.Config.require('TODOIST_API_TOKEN')).toBe('tok');
  });

  test('json parses, defaults, and reports invalid JSON', () => {
    const ctx = load({ J: '{"a":1}', BAD: '{nope' });
    expect(ctx.Config.json('J')).toEqual({ a: 1 });
    expect(ctx.Config.json('NONE', [])).toEqual([]);
    expect(() => ctx.Config.json('BAD')).toThrow(/BAD is not valid JSON/);
  });

  test('int, backfillDays, directConfidence defaults', () => {
    expect(load().Config.backfillDays()).toBe(28);
    expect(load({ BACKFILL_DAYS: '10' }).Config.backfillDays()).toBe(10);
    expect(load({ BACKFILL_DAYS: 'abc' }).Config.backfillDays()).toBe(28);
    expect(load().Config.directConfidence()).toBe('high');
    expect(load({ DIRECT_CONFIDENCE: 'MED' }).Config.directConfidence()).toBe('med');
  });

  test('identity defaults match DESIGN', () => {
    const id = load().Config.identity();
    expect(id.myNames).toContain('Alex Scammon');
    expect(id.notMe).toEqual(['Alex Blundell']);
    expect(id.myEmails).toEqual(['alex@insightsoftmax.com', 'alex@gr-oss.io', 'alex@alexscammon.com']);
    expect(id.assistants).toEqual(['morasha@insightsoftmax.com']);
  });

  test('IDENTITY override replaces arrays and keeps other keys', () => {
    const ctx = load({ IDENTITY: JSON.stringify({ notMe: ['Alex Blundell', 'Alex Jones'] }) });
    const id = ctx.Config.identity();
    expect(id.notMe).toEqual(['Alex Blundell', 'Alex Jones']);
    expect(id.myEmails).toHaveLength(3);
  });

  test('routing defaults and deep-merged ROUTING override', () => {
    const def = load().Config.routing();
    expect(def.projects.Waiting).toBe('Waiting on others');
    expect(def.calendars['alex@gr-oss.io']).toBe('GR');
    expect(def.domains['insightsoftmax.com']).toBe('ISC');
    expect(def.neverUseSections).toEqual(['Generated Tasks']);

    const ctx = load({ ROUTING: JSON.stringify({ domains: { 'acme.com': 'ISC' }, projects: { SG: 'Soul Graffiti' } }) });
    const r = ctx.Config.routing();
    expect(r.domains['acme.com']).toBe('ISC');
    expect(r.domains['gr-oss.io']).toBe('GR');
    expect(r.projects.SG).toBe('Soul Graffiti');
    expect(r.projects.GR).toBe('GR');
  });

  test('routing() returns a fresh copy each call (mutation-safe)', () => {
    const ctx = load();
    ctx.Config.routing().domains['x.com'] = 'Me';
    expect(ctx.Config.routing().domains['x.com']).toBeUndefined();
    expect(ctx.Config.DEFAULT_ROUTING.domains['x.com']).toBeUndefined();
  });

  test('isMyEmail / isMyName / isNotMe (Alex Blundell is never Alex)', () => {
    const c = load().Config;
    expect(c.isMyEmail('ALEX@gr-oss.io ')).toBe(true);
    expect(c.isMyEmail('alex.blundell@insightsoftmax.com')).toBe(false);
    expect(c.isMyEmail(null)).toBe(false);
    expect(c.isMyName('alex  scammon')).toBe(true);
    expect(c.isNotMe('Alex Blundell')).toBe(true);
    expect(c.isMyName('Alex Blundell')).toBe(false);
    expect(c.isMyName('Someone')).toBe(false);
  });

  test('slackWorkspaces parses JSON array or returns []', () => {
    expect(load().Config.slackWorkspaces()).toEqual([]);
    const ws = [{ name: 'ISC', token: 'xoxp-1', project: 'ISC' }];
    expect(load({ SLACK_WORKSPACES: JSON.stringify(ws) }).Config.slackWorkspaces()).toEqual(ws);
    expect(load({ SLACK_WORKSPACES: '{"a":1}' }).Config.slackWorkspaces()).toEqual([]);
  });
});
