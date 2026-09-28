const { loadGas } = require('./helpers/gas');

const FILES = ['Config.js', 'Util.js', 'Http.js', 'Store.js', 'Todoist.js', 'Route.js', 'Dedupe.js', 'Inbox.js'];
const NOW = new Date('2026-09-28T14:00:00Z'); // 07:00 in America/Los_Angeles
const TODAY = '2026-09-28';
const PROPS = { TODOIST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-test', GRANOLA_API_KEY: 'grn' };
const QUERY = 'in:inbox newer_than:2d -category:promotions -category:social -category:forums';
const CATALOGUE = {
  GR: ['Reach Out', 'Team Logistics', 'Team Updates', 'Conferences', 'KubeCon / Armada / CNCF Batch', 'Arctos', 'Tech Projects', 'Blogs', 'Hiring', 'EA'],
  ISC: ['Reach Out', 'Logistics', 'Marketing', 'Quantum', 'Research', 'ISC Events', 'EA'],
  Me: ['Immediate', 'Logistics', 'Outreach', 'Tech', 'Cars', 'To Buy'],
  SG: []
};

// ------------------------------------------------------------------ fixtures

const msg = (over) => Object.assign({ to: 'alex@alexscammon.com', date: '2026-09-27T16:00:00Z', plain: 'Hello' }, over);

const THREADS = {
  gr: () => ({
    id: 'th_gr', messages: [msg({
      id: 'm_gr1', from: 'Miro Knejp <miro@gr-oss.io>', to: 'Alex Scammon <alex@gr-oss.io>', subject: 'C++ clipboard design doc',
      date: '2026-09-27T17:00:00Z', plain: 'Alex, could you review the C++ clipboard design doc by Friday?'
    })]
  }),
  isc: () => ({
    id: 'th_isc', messages: [msg({
      id: 'm_isc1', from: 'Priya Shah <priya@insightsoftmax.com>', to: 'alex@insightsoftmax.com', cc: 'marcus@insightsoftmax.com',
      subject: 'Q4 budget', date: '2026-09-27T18:00:00Z', plain: 'Can you send me the Q4 budget numbers? I will send the forecast deck Wednesday.'
    })]
  }),
  me: () => ({
    id: 'th_me', messages: [msg({
      id: 'm_me1', from: 'Jessica <jess@gmail.com>', to: 'alex@alexscammon.com', subject: 'Photos',
      date: '2026-09-27T19:00:00Z', plain: 'Can you book the restaurant for Saturday?'
    })]
  }),
  replied: () => ({
    id: 'th_replied', messages: [
      msg({ id: 'm_r1', from: 'Jon Stumpf <jon@stumpf.example>', to: 'alex@insightsoftmax.com', subject: 'HPC deck', date: '2026-09-27T10:00:00Z', plain: 'Can you send the deck?' }),
      msg({ id: 'm_r2', from: 'Alex Scammon <alex@insightsoftmax.com>', to: 'jon@stumpf.example', subject: 'Re: HPC deck', date: '2026-09-27T11:00:00Z', plain: 'Attached.' })
    ]
  }),
  noreply: () => ({
    id: 'th_noreply', messages: [msg({ id: 'm_n1', from: 'GitHub <notifications@github.com>', subject: '[armadaproject/armada] PR #4012 merged', plain: 'Merged.' })]
  }),
  calendar: () => ({
    id: 'th_cal', messages: [msg({ id: 'm_c1', from: 'Miro Knejp <miro@gr-oss.io>', to: 'alex@gr-oss.io', subject: 'Accepted: Secure Copy/Paste Internal Sync @ Thu 1 Oct 2026 9am - 9:45am (PDT)', plain: 'Miro has accepted.' })]
  }),
  receipt: () => ({
    id: 'th_rcpt', messages: [msg({ id: 'm_rc1', from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Your Amazon.com order #112-555 has shipped', plain: 'Your package...' })]
  }),
  list: () => ({
    id: 'th_list', messages: [msg({
      id: 'm_l1', from: 'CNCF TAG Runtime <tag-runtime@lists.cncf.io>', to: 'tag-runtime@lists.cncf.io', subject: 'Meeting notes',
      plain: 'Notes', headers: { 'List-Unsubscribe': '<mailto:unsub@lists.cncf.io>', 'List-Id': 'tag-runtime.lists.cncf.io' }
    })]
  }),
  listDirect: () => ({
    id: 'th_list_direct', messages: [msg({
      id: 'm_ld1', from: 'Abhishek Malvankar <abhishek@example.org>', to: 'alex@gr-oss.io, batch@lists.cncf.io', subject: 'CNCF Batch Subproject paper',
      date: '2026-09-27T20:00:00Z', plain: 'Alex, can you draft the capability matrix intro?',
      headers: { 'List-Unsubscribe': '<mailto:unsub@lists.cncf.io>' }
    })]
  })
};

const item = (over) => Object.assign({
  title: 'Review the C++ clipboard design doc', kind: 'todo', owner: 'me', ownerName: null, ownerEmail: null,
  quote: 'could you review the C++ clipboard design doc by Friday?', why: 'Miro asked Alex directly.', due: '2026-10-02',
  resurface: null, confidence: 'high', project: 'GR', section: 'Tech Projects', timestampSec: null
}, over || {});

// ------------------------------------------------------------------ setup

function setup(opts) {
  const o = opts || {};
  const ctx = loadGas(FILES, { props: Object.assign({}, PROPS, o.props || {}), timeZone: 'America/Los_Angeles' });
  let t = NOW.getTime();
  ctx.Util.now = () => new Date(t);
  const clock = { advance: ms => { t += ms; } };
  const T = ctx.Todoist;
  T.sectionCatalogue = jest.fn(() => JSON.parse(JSON.stringify(CATALOGUE)));
  T.openTasks = jest.fn(() => (o.openTasks || []).slice());
  T.createTask = jest.fn(() => { throw new Error('Inbox must never create tasks'); });
  const items = Object.assign({
    th_gr: [item()],
    th_isc: [
      item({ title: 'Send Priya the Q4 budget numbers', quote: 'Can you send me the Q4 budget numbers?', project: 'ISC', section: 'Logistics', due: null, confidence: 'high' }),
      item({ title: 'Forecast deck', kind: 'waiting', owner: 'other', ownerName: 'Priya Shah', ownerEmail: 'priya@insightsoftmax.com', quote: 'I will send the forecast deck Wednesday.', resurface: '2026-09-30', project: 'ISC', section: null, due: null, confidence: 'med' })
    ],
    th_me: [item({ title: 'Book the restaurant for Saturday', project: 'Me', section: 'Logistics', due: '2026-10-03', confidence: 'low' })],
    th_list_direct: []
  }, o.items || {});
  ctx.Extract = {
    MAX_DISMISSALS: 20,
    email: jest.fn((threads, eopts) => {
      if (o.extractFail && o.extractFail(threads)) throw Object.assign(new Error('Anthropic overloaded'), { status: 529 });
      if (o.onExtract) o.onExtract(threads, clock);
      const out = [];
      threads.forEach(th => (items[th.threadId] || []).forEach(it => out.push(Object.assign({ ref: th.threadId }, it))));
      return out;
    })
  };
  const gmail = ctx.__mocks.GmailApp;
  const specs = o.threads || Object.keys(THREADS).map(k => THREADS[k]());
  gmail.__addThreads(specs);
  return { ctx, gmail, clock };
}

const ledger = (ctx, key) => ctx.Store.ledgerGet(key);

// ------------------------------------------------------------------ filterReason

describe('Inbox.filterReason', () => {
  const info = (spec) => {
    const { ctx, gmail } = setup({ threads: [] });
    const [th] = gmail.__addThreads([spec]);
    return { ctx, info: ctx.Inbox.threadInfo(th) };
  };

  test.each([
    ['replied', 'replied'], ['noreply', 'noreply'], ['calendar', 'calendar'], ['receipt', 'receipt'], ['list', 'mailing_list'],
    ['gr', null], ['isc', null], ['me', null], ['listDirect', null]
  ])('%s -> %s', (name, reason) => {
    const { ctx, info: i } = info(THREADS[name]());
    expect(ctx.Inbox.filterReason(i)).toBe(reason);
  });

  test('noreply variants and non-matches', () => {
    const { ctx } = setup({ threads: [] });
    const r = from => ctx.Inbox.filterReason({ lastFrom: from, subject: 'Hi', lastSubject: 'Hi', lastTo: 'alex@gr-oss.io' });
    expect(r('no-reply@accounts.google.com')).toBe('noreply');
    expect(r('Do Not Reply <donotreply@bank.example>')).toBe('noreply');
    expect(r('alerts@status.example')).toBe('noreply');
    expect(r('calendar-notification@google.com')).toBe('noreply');
    expect(r('noreplyjane@example.com')).toBeNull();
    expect(r('Nora Reply <nora@example.com>')).toBeNull();
  });

  test('calendar replies and invitations by subject', () => {
    const { ctx } = setup({ threads: [] });
    const r = subject => ctx.Inbox.filterReason({ lastFrom: 'x@y.example', subject, lastSubject: subject, lastTo: 'alex@gr-oss.io' });
    ['Declined: Sync', 'Invitation: Armada roadmap @ Mon', 'Updated invitation: Sync', 'Tentatively accepted: Sync', 'Accepted with note: Sync']
      .forEach(s => expect(r(s)).toBe('calendar'));
    expect(r('Re: Accepted proposals for KubeCon')).toBeNull();
  });

  test('receipts need a known vendor (subdomains included, INBOX_VENDORS extends)', () => {
    const { ctx } = setup({ threads: [], props: { INBOX_VENDORS: JSON.stringify(['studio-supply.example']) } });
    const r = (from, subject) => ctx.Inbox.filterReason({ lastFrom: from, subject, lastSubject: subject, lastTo: 'alex@alexscammon.com' });
    expect(r('receipts@email.apple.com', 'Your receipt from Apple')).toBe('receipt');
    expect(r('billing@studio-supply.example', 'Invoice 42')).toBe('receipt');
    expect(r('jon@stumpf.example', 'Invoice for September consulting')).toBeNull();
    expect(r('orders@amazon.com', 'Question about your seller account')).toBeNull();
  });

  test('a real person at a big vendor domain writing about an invoice is kept; automated senders are not', () => {
    const { ctx } = setup({ threads: [] });
    const r = (from, subject, extra) => ctx.Inbox.filterReason(Object.assign({ lastFrom: from, subject, lastSubject: subject, lastTo: 'alex@insightsoftmax.com' }, extra || {}));
    const subj = 'Re: Invoice for the ProServe engagement -- can you confirm PO?';
    expect(r('Jonathan Green <jgreen@amazon.com>', subj)).toBeNull();
    expect(r('Sam Lee <sam.lee@microsoft.com>', 'Invoice question for the Azure gov work')).toBeNull();
    expect(r('pat@google.com', 'Your order #42 of Pixel units')).toBeNull();
    // automated local parts / headers still drop
    expect(r('aws-billing@amazon.com', 'Your AWS invoice is available')).toBe('receipt');
    expect(r('auto-confirm@amazon.com', 'Your Amazon.com order #113-1 confirmation')).toBe('receipt');
    expect(r('payments-noreply@google.com', 'Payment received')).toBe('noreply');
    expect(r('jgreen@amazon.com', 'Invoice 7', { precedence: 'bulk' })).toBe('receipt');
    expect(r('jgreen@amazon.com', 'Invoice 7', { autoSubmitted: 'auto-generated' })).toBe('receipt');
    expect(r('jgreen@amazon.com', 'Invoice 7', { autoSubmitted: 'no' })).toBeNull();
    expect(ctx.Inbox.looksAutomated_('invoice2', {})).toBe(true);
    expect(ctx.Inbox.looksAutomated_('jgreen', { listId: 'x.lists.example' })).toBe(true);
    expect(ctx.Inbox.looksAutomated_('jgreen', {})).toBe(false);
  });

  test('threadInfo reads Precedence and Auto-Submitted headers of the last message', () => {
    const { ctx, gmail } = setup({ threads: [] });
    const [th] = gmail.__addThreads([{ id: 'th_h', messages: [msg({ id: 'mh', from: 'jgreen@amazon.com', subject: 'Invoice 7', headers: { Precedence: 'bulk', 'Auto-Submitted': 'auto-generated' } })] }]);
    const i = ctx.Inbox.threadInfo(th);
    expect(i).toMatchObject({ precedence: 'bulk', autoSubmitted: 'auto-generated', lastSubject: 'Invoice 7' });
    expect(ctx.Inbox.filterReason(i)).toBe('receipt');
  });

  test('a human reply inside an invitation or receipt thread is judged on the last message only', () => {
    const { ctx, gmail } = setup({ threads: [] });
    const [cal, rcpt] = gmail.__addThreads([
      {
        id: 'th_cal_reply', messages: [
          msg({ id: 'c1', from: 'Google Calendar <calendar-notification@google.com>', to: 'alex@gr-oss.io', subject: 'Invitation: Secure Copy/Paste Sync @ Thu 1 Oct 2026', date: '2026-09-27T10:00:00Z' }),
          msg({ id: 'c2', from: 'Miro Knejp <miro@gr-oss.io>', to: 'alex@gr-oss.io', subject: 'Re: Invitation: Secure Copy/Paste Sync @ Thu 1 Oct 2026', date: '2026-09-27T12:00:00Z', plain: 'Alex, can you send the design doc beforehand?' })
        ]
      },
      {
        id: 'th_rcpt_reply', messages: [
          msg({ id: 'r1', from: 'Amazon.com <shipment-tracking@amazon.com>', subject: 'Your Amazon.com order #112-555 has shipped', date: '2026-09-27T10:00:00Z' }),
          msg({ id: 'r2', from: 'Justin Ancheta <justin@soulgraffiti.example>', to: 'alex@alexscammon.com', subject: '', date: '2026-09-27T12:00:00Z', plain: 'Can you check the mic stands arrived?' })
        ]
      }
    ]);
    expect(ctx.Inbox.filterReason(ctx.Inbox.threadInfo(cal))).toBeNull();
    expect(ctx.Inbox.filterReason(ctx.Inbox.threadInfo(rcpt))).toBeNull();
  });
});

// ------------------------------------------------------------------ run

describe('runInboxSweep', () => {
  test('searches the DESIGN query, prefilters with counts, stores kv inbox.lastFiltered with examples', () => {
    const { ctx, gmail } = setup();
    const stats = ctx.runInboxSweep();
    expect(gmail.search.mock.calls[0]).toEqual([QUERY, 0, 100]);
    expect(stats).toMatchObject({ seen: 9, filtered: 5, candidates: 4, overflow: 0, errors: 0 });
    expect(stats.byReason).toEqual({ replied: 1, calendar: 1, noreply: 1, receipt: 1, mailing_list: 1 });
    const kv = ctx.Store.kvGet('inbox.lastFiltered');
    expect(kv.count).toBe(5);
    expect(kv.byReason.mailing_list).toBe(1);
    expect(kv.examples).toHaveLength(5);
    expect(kv.examples).toContainEqual({ subject: 'HPC deck', from: 'Alex Scammon <alex@insightsoftmax.com>', reason: 'replied' });
    expect(kv.at).toBe(NOW.toISOString());
    // filtered threads are ledgered as 'nothing' with the reason
    expect(ledger(ctx, 'gmail:th_noreply:m_n1')).toMatchObject({ outcome: 'nothing', source: 'gmail', note: 'filtered: noreply' });
    expect(ledger(ctx, 'gmail:th_replied:m_r2').note).toBe('filtered: replied');
    const logs = ctx.__mocks.logs.join('\n');
    expect(logs).toContain('5 filtered (replied 1, calendar 1, noreply 1, receipt 1, mailing_list 1)');
    expect(logs).not.toContain('could you review'); // no bodies in logs
  });

  test('queues only (never creates tasks), routed by recipient address, with DESIGN queue shape', () => {
    const { ctx } = setup();
    const stats = ctx.runInboxSweep();
    expect(stats.queued).toBe(4);
    expect(ctx.Todoist.createTask).not.toHaveBeenCalled();
    const q = ctx.Store.queueList({ status: 'pending' });
    expect(q).toHaveLength(4);
    const gr = q.find(x => x.sourceKey === 'gmail:th_gr');
    expect(gr).toMatchObject({
      id: ctx.Store.queueId('email', 'gmail:th_gr', 'Review the C++ clipboard design doc'),
      status: 'pending', source: 'email', kind: 'todo', project: 'GR', section: 'Tech Projects',
      routeConfidence: 'med', confidence: 'high', due: '2026-10-02', link: 'https://mail.google.com/mail/#all/th_gr',
      dupTaskId: null, labels: ['from-email'], waitOn: null
    });
    expect(gr.origin).toBe('Email · C++ clipboard design doc · Miro Knejp · Sun 27 Sep');
    expect(gr.description).toContain('[Open in Gmail](https://mail.google.com/mail/#all/th_gr)');
    expect(gr.description).toContain('> could you review');
    expect(ctx.Todoist.parseMachineLine(gr.description)).toEqual({ key: 'gmail:th_gr', q: gr.id });

    const isc = q.filter(x => x.sourceKey === 'gmail:th_isc');
    expect(isc.map(x => x.project)).toEqual(['ISC', 'ISC']);
    const waiting = isc.find(x => x.kind === 'waiting');
    expect(waiting).toMatchObject({ waitOn: 'Priya Shah', waitOnEmail: 'priya@insightsoftmax.com', resurface: '2026-09-30', section: null });

    const me = q.find(x => x.sourceKey === 'gmail:th_me');
    expect(me).toMatchObject({ project: 'Me', section: 'Logistics', routeConfidence: 'med', chips: ['Low confidence'] });

    // route hint handed to the extractor comes from the recipient address
    const threads = ctx.Extract.email.mock.calls[0][0];
    expect(threads.find(t => t.threadId === 'th_gr').routeHint).toMatchObject({ project: 'GR', confidence: 'med', reason: 'sent to alex@gr-oss.io' });
    expect(threads.find(t => t.threadId === 'th_me').routeHint.project).toBe('Me');
    const eopts = ctx.Extract.email.mock.calls[0][1];
    expect(eopts.today).toBe(TODAY);
    expect(eopts.sectionsByProject.GR).toContain('Tech Projects');

    // ledger: queued threads carry their queue ids; a thread with no items is 'nothing'
    expect(ledger(ctx, 'gmail:th_isc:m_isc1')).toMatchObject({ outcome: 'queued', queueIds: isc.map(x => x.id) });
    expect(ledger(ctx, 'gmail:th_list_direct:m_ld1').outcome).toBe('nothing');
    const run = ctx.Store.runsRecent(1, 'runInboxSweep')[0];
    expect(run).toMatchObject({ seen: 9, created: 0, queued: 4, errors: 0 });
    expect(run.note).toContain('filtered 5');
  });

  test('the LLM disagreeing with the recipient route lowers route confidence', () => {
    const { ctx } = setup({ items: { th_gr: [item({ project: 'ISC', section: 'Research' })] } });
    ctx.runInboxSweep();
    const gr = ctx.Store.queueList().find(x => x.sourceKey === 'gmail:th_gr');
    expect(gr).toMatchObject({ project: 'GR', section: null, routeConfidence: 'low' });
  });

  test('matches open tasks, including @starred tasks from Code.js; not_duplicate feedback suppresses it', () => {
    const open = [{ id: '777', content: 'Review the C++ clipboard design doc @starred', projectName: 'Inbox' }];
    const a = setup({ openTasks: open });
    a.ctx.runInboxSweep();
    const dup = a.ctx.Store.queueList().find(x => x.sourceKey === 'gmail:th_gr');
    expect(dup).toMatchObject({ dupTaskId: '777', dupTaskTitle: 'Review the C++ clipboard design doc @starred' });

    const b = setup({ openTasks: open });
    const qid = b.ctx.Store.queueId('email', 'gmail:th_gr', 'Review the C++ clipboard design doc');
    b.ctx.Store.feedbackAdd({ type: 'not_duplicate', queueId: qid, title: 'Review the C++ clipboard design doc', detail: { taskId: '777' } });
    b.ctx.runInboxSweep();
    expect(b.ctx.Store.queueList().find(x => x.sourceKey === 'gmail:th_gr').dupTaskId).toBeNull();
  });

  test('passes recent dismissals to the extractor as negative examples', () => {
    const { ctx } = setup();
    ctx.Store.feedbackAdd({ type: 'dismissed', title: 'Reply to the CNCF newsletter', sourceKey: 'gmail:old' });
    ctx.Store.feedbackAdd({ type: 'edited', title: 'Something else' });
    ctx.runInboxSweep();
    const fb = ctx.Extract.email.mock.calls[0][1].feedback;
    expect(fb.map(f => f.title)).toEqual(['Reply to the CNCF newsletter']);
  });

  test('ledger prevents reprocessing; a new message makes the thread eligible again without re-queueing the same item', () => {
    const { ctx, gmail } = setup();
    ctx.runInboxSweep();
    expect(ctx.Extract.email).toHaveBeenCalledTimes(1);
    ctx.Store.reset();
    const second = ctx.runInboxSweep();
    expect(ctx.Extract.email).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ seen: 9, skipped: 9, filtered: 0, queued: 0 });

    // New reply from Miro on th_gr -> new ledger key -> extracted again; same title => same queue id => not re-added
    const th = gmail.__threads.find(t => t.__spec.id === 'th_gr');
    const [extra] = ctx.__mocks.GmailApp.__addThreads([{ id: 'tmp', messages: [msg({ id: 'm_gr2', from: 'Miro Knejp <miro@gr-oss.io>', to: 'alex@gr-oss.io', subject: 'Re: C++ clipboard design doc', date: '2026-09-28T09:00:00Z', plain: 'Ping on the review?' })] }]);
    gmail.__threads.splice(gmail.__threads.indexOf(extra), 1);
    th.__messages.push(extra.__messages[0]);
    const third = ctx.runInboxSweep();
    expect(ctx.Extract.email).toHaveBeenCalledTimes(2);
    expect(ctx.Extract.email.mock.calls[1][0].map(t => t.threadId)).toEqual(['th_gr']);
    expect(third.queued).toBe(0);
    expect(ledger(ctx, 'gmail:th_gr:m_gr2').outcome).toBe('queued');
    expect(ctx.Store.queueList().filter(x => x.sourceKey === 'gmail:th_gr')).toHaveLength(1);
  });

  test('batches of 8 threads and a daily cap of 40 (overflow logged and not ledgered)', () => {
    const threads = [];
    for (let i = 0; i < 45; i++) {
      threads.push({ id: 'th' + i, messages: [msg({ id: 'm' + i, from: 'Person ' + i + ' <p' + i + '@example.org>', to: 'alex@gr-oss.io', subject: 'Question ' + i, date: new Date(Date.UTC(2026, 8, 27, 0, i)).toISOString() })] });
    }
    const { ctx } = setup({ threads });
    const stats = ctx.runInboxSweep();
    expect(stats).toMatchObject({ seen: 45, candidates: 45, overflow: 5 });
    const sizes = ctx.Extract.email.mock.calls.map(c => c[0].length);
    expect(sizes).toEqual([8, 8, 8, 8, 8]);
    // newest first: the 5 oldest (th0..th4) overflow
    expect(ledger(ctx, 'gmail:th0:m0')).toBeNull();
    expect(ledger(ctx, 'gmail:th44:m44').outcome).toBe('nothing');
    expect(ctx.__mocks.logs.join('\n')).toContain('5 thread(s) over the daily cap of 40');
    expect(ctx.Store.kvGet('inbox.lastFiltered').overflow).toBe(5);
    expect(ctx.Store.runsRecent(1)[0].note).toContain('overflow 5');
  });

  test('a failing batch is ledgered as error (retried next run) and does not stop the others', () => {
    const threads = [];
    for (let i = 0; i < 10; i++) {
      threads.push({ id: 'th' + i, messages: [msg({ id: 'm' + i, from: 'p' + i + '@example.org', to: 'alex@gr-oss.io', subject: 'Q' + i, date: new Date(Date.UTC(2026, 8, 27, 0, 59 - i)).toISOString() })] });
    }
    let calls = 0;
    const { ctx } = setup({
      threads,
      items: { th9: [item({ title: 'Answer p9 about the Armada demo' })] },
      extractFail: () => ++calls === 1
    });
    const stats = ctx.runInboxSweep();
    expect(stats.errors).toBe(1);
    expect(stats.queued).toBe(1);
    expect(ledger(ctx, 'gmail:th0:m0')).toMatchObject({ outcome: 'error' });
    expect(ledger(ctx, 'gmail:th0:m0').note).toContain('Anthropic overloaded');
    expect(ledger(ctx, 'gmail:th9:m9').outcome).toBe('queued');
    // next run retries only the errored batch
    ctx.runInboxSweep();
    expect(ctx.Extract.email.mock.calls[2][0].map(t => t.threadId)).toEqual(['th0', 'th1', 'th2', 'th3', 'th4', 'th5', 'th6', 'th7']);
    expect(ledger(ctx, 'gmail:th0:m0').outcome).toBe('nothing');
  });

  test('stops cleanly at the deadline; unprocessed threads are not ledgered', () => {
    const threads = [];
    for (let i = 0; i < 20; i++) {
      threads.push({ id: 'th' + i, messages: [msg({ id: 'm' + i, from: 'p' + i + '@example.org', to: 'alex@gr-oss.io', subject: 'Q' + i, date: new Date(Date.UTC(2026, 8, 27, 0, 59 - i)).toISOString() })] });
    }
    const { ctx } = setup({ threads, onExtract: (t, clock) => clock.advance(200000) });
    const stats = ctx.Inbox.run();
    expect(stats.stoppedEarly).toBe(true);
    expect(ctx.Extract.email).toHaveBeenCalledTimes(2);
    expect(ledger(ctx, 'gmail:th15:m15').outcome).toBe('nothing');
    expect(ledger(ctx, 'gmail:th16:m16')).toBeNull();
    expect(ledger(ctx, 'gmail:th0:m0').outcome).toBe('nothing');
    expect(ctx.Store.runsRecent(1)[0].note).toContain('stopped early');
  });

  test('already-ledgered threads are skipped before any body or header is read', () => {
    const { ctx, gmail } = setup();
    ctx.runInboxSweep();
    const all = gmail.__threads.flatMap(t => t.__messages);
    all.forEach(m => { m.getPlainBody.mockClear(); m.getHeader.mockClear(); m.getFrom.mockClear(); });
    ctx.Store.reset();
    const second = ctx.runInboxSweep();
    expect(second.skipped).toBe(9);
    all.forEach(m => {
      expect(m.getPlainBody).not.toHaveBeenCalled();
      expect(m.getHeader).not.toHaveBeenCalled();
      expect(m.getFrom).not.toHaveBeenCalled();
    });
  });

  test('the deadline is also checked while reading threads; unread threads are not ledgered', () => {
    const threads = [];
    for (let i = 0; i < 5; i++) {
      threads.push({ id: 'th' + i, messages: [msg({ id: 'm' + i, from: 'p' + i + '@example.org', to: 'alex@gr-oss.io', subject: 'Q' + i })] });
    }
    const { ctx, gmail, clock } = setup({ threads });
    // reading the third thread's bodies takes the run past its budget
    gmail.__threads[2].__messages[0].getPlainBody.mockImplementation(() => { clock.advance(300000); return 'slow'; });
    const stats = ctx.Inbox.run();
    expect(stats.stoppedEarly).toBe(true);
    expect(ctx.Extract.email).not.toHaveBeenCalled();
    expect(gmail.__threads[3].__messages[0].getPlainBody).not.toHaveBeenCalled();
    ['th3', 'th4'].forEach(id => expect(ledger(ctx, 'gmail:' + id + ':m' + id.slice(2))).toBeNull());
    expect(ctx.Store.runsRecent(1)[0].note).toContain('stopped early');
  });

  test('an unreadable thread is counted as an error and skipped', () => {
    const { ctx, gmail } = setup({ threads: [THREADS.gr()] });
    const bad = { getId: () => 'th_bad', getMessages: () => { throw new Error('Gmail hiccup'); } };
    const real = gmail.search.getMockImplementation();
    gmail.search.mockImplementation((q, s, m) => (s ? [] : [bad].concat(real(q, s, m))));
    const stats = ctx.runInboxSweep();
    expect(stats.errors).toBe(1);
    expect(stats.queued).toBe(1);
  });

  test('no candidates: no extractor call, kv still written', () => {
    const { ctx } = setup({ threads: [THREADS.noreply(), THREADS.calendar()] });
    const stats = ctx.runInboxSweep();
    expect(ctx.Extract.email).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ filtered: 2, queued: 0 });
    expect(ctx.Store.kvGet('inbox.lastFiltered').count).toBe(2);
  });

  test('skips when another run holds the lock', () => {
    const { ctx, gmail } = setup();
    ctx.__mocks.LockService.__available = false;
    expect(ctx.runInboxSweep()).toBeNull();
    expect(gmail.search).not.toHaveBeenCalled();
  });

  test('pages through search results 100 at a time', () => {
    const threads = [];
    for (let i = 0; i < 130; i++) threads.push({ id: 'n' + i, messages: [msg({ id: 'nm' + i, from: 'noreply@example.com', subject: 'x' })] });
    const { ctx, gmail } = setup({ threads });
    const stats = ctx.runInboxSweep();
    expect(gmail.search.mock.calls.map(c => c[1])).toEqual([0, 100]);
    expect(stats.seen).toBe(130);
    expect(stats.byReason.noreply).toBe(130);
    expect(ctx.Store.kvGet('inbox.lastFiltered').examples).toHaveLength(10);
  });
});
