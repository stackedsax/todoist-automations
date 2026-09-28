const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const BASE = 'https://api.todoist.com/api/v1';
const FILES = ['Config.js', 'Util.js', 'Http.js', 'Store.js', 'Todoist.js', 'Code.js'];

const PROJECTS = [
  { id: 'p_inbox', name: 'Inbox', inbox_project: true },
  { id: 'p_gr', name: 'GR' },
  { id: 'p_me', name: 'Me' }
];

/** Load Code.js with a small Todoist v1 fake. opts.tasks: existing Inbox tasks; opts.failOn: fn(body) -> status */
function setup(opts) {
  const o = opts || {};
  const ctx = loadGas(FILES, Object.assign({ props: { TODOIST_API_TOKEN: 'tok' } }, o.gas || {}));
  ctx.Http.jitter_ = () => 0;
  const m = ctx.__mocks;
  const state = { tasks: (o.tasks || []).map(t => Object.assign({ project_id: 'p_inbox' }, t)), created: [], n: 100 };
  m.UrlFetchApp.__on('GET', BASE + '/projects', respond.json({ results: PROJECTS, next_cursor: null }));
  m.UrlFetchApp.__on('GET', BASE + '/tasks', req => respond.json({
    results: state.tasks.filter(t => t.project_id === req.query.project_id), next_cursor: null
  }));
  m.UrlFetchApp.__on('POST', BASE + '/tasks', req => {
    const status = o.failOn ? o.failOn(req.json) : 0;
    if (status) return respond.status(status, '{"error":"bad"}');
    const t = Object.assign({ id: String(state.n++), project_id: 'p_inbox' }, req.json);
    state.tasks.push(t);
    state.created.push(t);
    return respond.json(t);
  });
  return { ctx, m, state };
}

function starred(id, subject, plain, extra) {
  return { id: 't_' + id, messages: [Object.assign({ id, subject, from: 'Jon <jon@example.com>', date: '2026-09-24T17:00:00Z', plain, starred: true }, extra || {})] };
}

const posts = m => m.UrlFetchApp.__calls.filter(c => c.method === 'POST' && c.url === BASE + '/tasks');

describe('Code.js — starred Gmail -> Todoist', () => {
  describe('createTaskFromStarred', () => {
    test('throws a clear error when the Todoist token is missing', () => {
      const ctx = loadGas(FILES, { props: {} });
      expect(() => ctx.createTaskFromStarred()).toThrow('Missing Script Property: TODOIST_API_TOKEN');
      expect(ctx.__mocks.GmailApp.search).not.toHaveBeenCalled();
    });

    test('searches is:starred and does nothing (no run log) when nothing is starred', () => {
      const { ctx, m } = setup();
      const stats = ctx.createTaskFromStarred();
      expect(m.GmailApp.search).toHaveBeenCalledWith('is:starred', 0, 50);
      expect(stats).toEqual({ seen: 0, created: 0, skipped: 0, errors: 0 });
      expect(m.UrlFetchApp.__calls).toHaveLength(0);
      expect(m.SpreadsheetApp.create).not.toHaveBeenCalled();
    });

    test('creates an Inbox task with subject @starred, authuser link, body and machine line, then unstars', () => {
      const { ctx, m, state } = setup({ gas: { userEmail: 'alex@alexscammon.com' } });
      const [thread] = m.GmailApp.__addThreads([starred('msg123', 'Last Mile HPC deck', 'Hi Alex, could you send the deck over to Jon this week?')]);
      const stats = ctx.createTaskFromStarred();

      expect(stats).toEqual({ seen: 1, created: 1, skipped: 0, errors: 0 });
      const call = posts(m)[0];
      expect(call.headers.Authorization).toBe('Bearer tok');
      expect(call.json.content).toBe('Last Mile HPC deck @starred');
      expect(call.json.project_id).toBeUndefined();
      const desc = call.json.description;
      expect(desc.startsWith('[View original email](https://mail.google.com/mail/?authuser=alex@alexscammon.com#all/msg123)\n\n')).toBe(true);
      expect(desc).toContain('could you send the deck over to Jon');
      const lines = desc.split('\n');
      expect(lines[lines.length - 1]).toBe('<!-- ta:{"key":"gmail-star:msg123"} -->');
      expect(ctx.Todoist.parseMachineLine(desc)).toEqual({ key: 'gmail-star:msg123' });
      expect(thread.__messages[0].unstar).toHaveBeenCalled();
      expect(state.created).toHaveLength(1);
    });

    test('one failing message does not throw: it stays starred and the others still run', () => {
      const { ctx, m } = setup({ failOn: body => (body.content.indexOf('Broken') === 0 ? 400 : 0) });
      const threads = m.GmailApp.__addThreads([
        starred('m1', 'Broken one', 'This body is long enough to be used as is.'),
        starred('m2', 'Good one', 'This body is long enough to be used as is.')
      ]);
      let stats;
      expect(() => { stats = ctx.createTaskFromStarred(); }).not.toThrow();
      expect(stats).toEqual({ seen: 2, created: 1, skipped: 0, errors: 1 });
      expect(threads[0].__messages[0].unstar).not.toHaveBeenCalled();
      expect(threads[0].__messages[0].isStarred()).toBe(true);
      expect(threads[1].__messages[0].unstar).toHaveBeenCalled();
      expect(m.logs.join('\n')).toMatch(/message m1 failed; left starred for retry/);
    });

    test('a thread that cannot be read is counted as an error and skipped', () => {
      const { ctx, m } = setup();
      const [bad, good] = m.GmailApp.__addThreads([
        starred('m1', 'A', 'This body is long enough to be used as is.'),
        starred('m2', 'B', 'This body is long enough to be used as is.')
      ]);
      bad.getMessages.mockImplementation(() => { throw new Error('Gmail hiccup'); });
      const stats = ctx.createTaskFromStarred();
      expect(stats).toMatchObject({ seen: 1, created: 1, errors: 1 });
      expect(good.__messages[0].unstar).toHaveBeenCalled();
    });

    test('does not duplicate a task already created for the message (unstar failed last time)', () => {
      const { ctx, m, state } = setup({
        tasks: [{ id: 't9', content: 'Old @starred', description: 'x\n<!-- ta:{"key":"gmail-star:msg7"} -->' }]
      });
      const [thread] = m.GmailApp.__addThreads([starred('msg7', 'Old', 'This body is long enough to be used as is.')]);
      const stats = ctx.createTaskFromStarred();
      expect(stats).toEqual({ seen: 1, created: 0, skipped: 1, errors: 0 });
      expect(posts(m)).toHaveLength(0);
      expect(state.created).toHaveLength(0);
      expect(thread.__messages[0].unstar).toHaveBeenCalled();
    });

    test('ignores messages in a starred thread that are not themselves starred', () => {
      const { ctx, m } = setup();
      m.GmailApp.__addThreads([{
        id: 't1', messages: [
          { id: 'a', subject: 'Re: plan', plain: 'Earlier message in the thread, not starred.', starred: false },
          { id: 'b', subject: 'Re: plan', plain: 'This one is starred and long enough.', starred: true }
        ]
      }]);
      const stats = ctx.createTaskFromStarred();
      expect(stats.seen).toBe(1);
      expect(posts(m)).toHaveLength(1);
      expect(posts(m)[0].json.description).toContain('#all/b');
    });

    test('falls back to HTML body, uses (no subject), and a plain link without authuser when the user email is unknown', () => {
      const { ctx, m } = setup();
      m.Session.getEffectiveUser().getEmail.mockReturnValue('');
      m.GmailApp.__addThreads([starred('h1', '', '', { body: '<p>Hello <b>there</b></p><style>x{}</style>' })]);
      ctx.createTaskFromStarred();
      const call = posts(m)[0];
      expect(call.json.content).toBe('(no subject) @starred');
      expect(call.json.description).toContain('[View original email](https://mail.google.com/mail/#all/h1)');
      expect(call.json.description).toContain('Hello there');
    });

    test('very long bodies are truncated but the machine line stays the last line', () => {
      const { ctx, m } = setup();
      m.GmailApp.__addThreads([starred('big', 'Huge', 'word '.repeat(10000))]);
      ctx.createTaskFromStarred();
      const desc = posts(m)[0].json.description;
      expect(desc.length).toBeLessThan(8300);
      expect(desc).toContain('…');
      expect(desc.split('\n').pop()).toBe('<!-- ta:{"key":"gmail-star:big"} -->');
    });

    test('writes a run log row when something was seen', () => {
      const { ctx, m } = setup();
      m.GmailApp.__addThreads([starred('r1', 'Log me', 'This body is long enough to be used as is.')]);
      ctx.createTaskFromStarred();
      ctx.Store.reset();
      const runs = ctx.Store.runsRecent(5, 'createTaskFromStarred');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ job: 'createTaskFromStarred', seen: 1, created: 1, errors: 0 });
    });

    test('a message that keeps failing writes one runs row, not one per minute', () => {
      const { ctx, m } = setup({ failOn: () => 400 });
      m.GmailApp.__addThreads([starred('bad1', 'Always fails', 'This body is long enough to be used as is.')]);
      for (let i = 0; i < 5; i++) {
        expect(ctx.createTaskFromStarred()).toEqual({ seen: 1, created: 0, skipped: 0, errors: 1 });
      }
      ctx.Store.reset();
      const runs = ctx.Store.runsRecent(20, 'createTaskFromStarred');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ seen: 1, created: 0, errors: 1 });
      // Still visible in the execution log every run.
      expect(m.logs.filter(l => /message bad1 failed/.test(l))).toHaveLength(5);
    });

    test('an unchanged failure is logged again once the throttle expires, and a new failure is logged at once', () => {
      const { ctx, m } = setup({ failOn: () => 400 });
      m.GmailApp.__addThreads([starred('bad1', 'Always fails', 'This body is long enough to be used as is.')]);
      ctx.createTaskFromStarred();
      ctx.createTaskFromStarred();
      // Simulate the 6h CacheService TTL running out.
      delete m.CacheService.__script.__store['starred.lastErrorSig'];
      ctx.createTaskFromStarred();
      m.GmailApp.__addThreads([starred('bad2', 'Also fails', 'This body is long enough to be used as is.')]);
      ctx.createTaskFromStarred();
      ctx.createTaskFromStarred();
      ctx.Store.reset();
      const runs = ctx.Store.runsRecent(20, 'createTaskFromStarred');
      expect(runs.map(r => r.errors)).toEqual([2, 1, 1]);
    });

    test('progress always logs and resets the throttle for a later identical failure', () => {
      let fail = true;
      const { ctx, m } = setup({ failOn: body => (body.content.indexOf('Flaky') === 0 && fail ? 503 : 0) });
      m.GmailApp.__addThreads([starred('f1', 'Flaky', 'This body is long enough to be used as is.')]);
      ctx.createTaskFromStarred(); // error row
      ctx.createTaskFromStarred(); // throttled
      fail = false;
      ctx.createTaskFromStarred(); // created row
      expect(m.CacheService.__script.__store['starred.lastErrorSig']).toBeUndefined();
      ctx.Store.reset();
      const runs = ctx.Store.runsRecent(20, 'createTaskFromStarred');
      expect(runs.map(r => [r.created, r.errors])).toEqual([[1, 0], [0, 1]]);
    });

    test('an unreadable thread is throttled the same way', () => {
      const { ctx, m } = setup();
      const [bad] = m.GmailApp.__addThreads([starred('m1', 'A', 'This body is long enough to be used as is.')]);
      bad.getMessages.mockImplementation(() => { throw new Error('Gmail hiccup'); });
      ctx.createTaskFromStarred();
      ctx.createTaskFromStarred();
      ctx.Store.reset();
      expect(ctx.Store.runsRecent(20, 'createTaskFromStarred')).toHaveLength(1);
    });

    test('skips when a previous run still holds the user lock', () => {
      const { ctx, m } = setup();
      m.LockService.__available = false;
      m.GmailApp.__addThreads([starred('l1', 'Locked', 'This body is long enough to be used as is.')]);
      expect(ctx.createTaskFromStarred()).toBeNull();
      expect(m.GmailApp.search).not.toHaveBeenCalled();
      expect(m.LockService.getUserLock).toHaveBeenCalled();
    });

    test('releases the lock even if Gmail search throws', () => {
      const { ctx, m } = setup();
      m.GmailApp.search.mockImplementation(() => { throw new Error('boom'); });
      expect(() => ctx.createTaskFromStarred()).toThrow('boom');
      expect(m.LockService.__held).toBe(false);
    });
  });

  describe('createTrigger (legacy)', () => {
    test('installs a single every-minute trigger, replacing an existing one', () => {
      const { ctx, m } = setup();
      ctx.createTrigger();
      ctx.createTrigger();
      const ts = m.ScriptApp.__triggers.filter(t => t.getHandlerFunction() === 'createTaskFromStarred');
      expect(ts).toHaveLength(1);
      expect(ts[0].__config.everyMinutes).toBe(1);
    });
  });

  describe('extractCleanBodySimple', () => {
    let ctx;
    beforeEach(() => { ctx = setup().ctx; });

    test('returns empty string for null message', () => {
      expect(ctx.extractCleanBodySimple(null)).toBe('');
    });

    test('returns empty string for message without getPlainBody method', () => {
      expect(ctx.extractCleanBodySimple({})).toBe('');
    });

    test('returns plain text when available and longer than 20 chars', () => {
      const msg = { getPlainBody: jest.fn(() => 'This is a long enough plain text message'), getBody: jest.fn() };
      expect(ctx.extractCleanBodySimple(msg)).toBe('This is a long enough plain text message');
      expect(msg.getBody).not.toHaveBeenCalled();
    });

    test('falls back to HTML processing when plain text is short', () => {
      const msg = { getPlainBody: jest.fn(() => 'Short'), getBody: jest.fn(() => '<p>This is HTML content</p>') };
      expect(ctx.extractCleanBodySimple(msg)).toContain('This is HTML content');
      expect(msg.getBody).toHaveBeenCalled();
    });

    test('strips HTML tags from body', () => {
      const msg = { getPlainBody: () => '', getBody: () => '<p>Hello <strong>world</strong>!</p>' };
      expect(ctx.extractCleanBodySimple(msg)).toBe('Hello world!');
    });

    test('removes style and script tags', () => {
      const msg = { getPlainBody: () => '', getBody: () => '<p>Content</p><style>body{color:red}</style><script>alert("test")</script>' };
      expect(ctx.extractCleanBodySimple(msg)).toBe('Content');
    });

    test('tolerates a null HTML body', () => {
      expect(ctx.extractCleanBodySimple({ getPlainBody: () => '', getBody: () => null })).toBe('');
    });
  });

  describe('cleanEmailBody', () => {
    let ctx;
    beforeEach(() => { ctx = setup().ctx; });

    test('removes tracking URLs', () => {
      const input = 'Check this out: https://list.example.com/track?id=123 and this https://actionnetwork.org/track/456';
      expect(ctx.cleanEmailBody(input)).toBe('Check this out:  and this');
    });

    test('removes unsubscribe lines', () => {
      expect(ctx.cleanEmailBody('Important message\nTo unsubscribe click here\nMore content')).toBe('Important message\n\nMore content');
    });

    test('whole unsubscribe lines are removed, so nothing after them is cut', () => {
      const input = 'Important message\nMore content\nPlease unsubscribe me\nThis should be removed';
      expect(ctx.cleanEmailBody(input)).toBe('Important message\nMore content\n\nThis should be removed');
    });

    test('cleans up excessive newlines', () => {
      expect(ctx.cleanEmailBody('Line 1\n\n\n\nLine 2\n\n\n\n\nLine 3')).toBe('Line 1\n\nLine 2\n\nLine 3');
    });

    test('handles empty input', () => {
      expect(ctx.cleanEmailBody('')).toBe('');
      expect(ctx.cleanEmailBody(null)).toBe('');
    });
  });

  describe('walkHtmlAndExtract', () => {
    const el = (name, text, children, href) => ({
      getName: () => name,
      getText: () => text,
      getChildren: () => children || [],
      getAttribute: k => (k === 'href' && href ? { getValue: () => href } : null)
    });

    test('converts links to markdown and skips invisible elements', () => {
      const ctx = setup().ctx;
      const root = el('div', 'See ', [el('a', 'the deck', [], 'https://x.test/deck'), el('style', 'x{}'), el('span', 'thanks')]);
      const out = ctx.walkHtmlAndExtract(root);
      expect(out).toContain('[the deck](https://x.test/deck)');
      expect(out).toContain('thanks');
      expect(out).not.toContain('x{}');
    });
  });
});
