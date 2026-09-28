const { loadGas } = require('./helpers/gas');
const { createMocks, formatDate } = require('./helpers/mocks');

const load = opts => loadGas(['Config.js', 'Util.js'], opts || {});

describe('Util', () => {
  test('now returns a Date and can be stubbed', () => {
    const ctx = load();
    expect(ctx.Util.now()).toBeInstanceOf(Date);
    ctx.Util.now = () => new Date('2026-09-24T17:00:00Z');
    expect(ctx.Util.today()).toBe('2026-09-24');
  });

  test('deadline tracks remaining/expired against Util.now', () => {
    const ctx = load();
    let t = 1000000;
    ctx.Util.now = () => new Date(t);
    const d = ctx.Util.deadline(5000);
    expect(d.expired()).toBe(false);
    expect(d.remaining()).toBe(5000);
    t += 3000;
    expect(d.remaining()).toBe(2000);
    expect(d.elapsed()).toBe(3000);
    t += 2000;
    expect(d.expired()).toBe(true);
    expect(d.remaining()).toBe(0);
    expect(ctx.Util.deadline().remaining()).toBe(270000);
  });

  describe('withLock', () => {
    test('runs fn, returns its value, releases lock', () => {
      const ctx = load();
      const lock = ctx.__mocks.LockService.__lock;
      expect(ctx.Util.withLock('job', () => 42)).toBe(42);
      expect(lock.tryLock).toHaveBeenCalledWith(5000);
      expect(lock.releaseLock).toHaveBeenCalledTimes(1);
    });

    test('releases lock when fn throws', () => {
      const ctx = load();
      expect(() => ctx.Util.withLock('job', () => { throw new Error('boom'); })).toThrow('boom');
      expect(ctx.__mocks.LockService.__held).toBe(false);
    });

    test('skips and logs when lock unavailable', () => {
      const ctx = load();
      ctx.__mocks.LockService.__available = false;
      const fn = jest.fn();
      expect(ctx.Util.withLock('runMeetings', fn)).toBeNull();
      expect(fn).not.toHaveBeenCalled();
      expect(ctx.__mocks.logs.join('\n')).toMatch(/runMeetings.*lock/);
    });
  });

  test('hash is stable hex, default 16 chars, configurable length', () => {
    const ctx = load();
    const h = ctx.Util.hash('abc');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    // SHA-256("abc") = ba7816bf8f01cfea…
    expect(h).toBe('ba7816bf8f01cfea');
    expect(ctx.Util.hash('abc', 64)).toHaveLength(64);
    expect(ctx.Util.hash('abd')).not.toBe(h);
  });

  test('normalizeTitle strips punctuation, accents, case', () => {
    const u = load().Util;
    expect(u.normalizeTitle('  Send the "Last-Mile" HPC deck!! ')).toBe('send the last mile hpc deck');
    expect(u.normalizeTitle("Café’s résumé")).toBe('cafes resume');
    expect(u.normalizeTitle(null)).toBe('');
  });

  test('tokens drop stopwords and duplicates', () => {
    expect(load().Util.tokens('Send the deck to Jon and the deck')).toEqual(['send', 'deck', 'jon']);
  });

  test('tokenJaccard and containment', () => {
    const u = load().Util;
    expect(u.tokenJaccard('Send HPC deck to Jon', 'send the hpc deck to jon')).toBe(1);
    expect(u.tokenJaccard('a b c', '')).toBe(0);
    expect(u.tokenJaccard('alpha beta', 'beta gamma')).toBeCloseTo(1 / 3);
    expect(u.containment('Send deck', 'Send the Last Mile HPC deck to Jon Stumpf')).toBe(1);
    expect(u.containment('alpha beta', 'beta gamma delta')).toBe(0.5);
    expect(u.containment('', 'x')).toBe(0);
  });

  test('truncate', () => {
    const u = load().Util;
    expect(u.truncate('hello', 10)).toBe('hello');
    expect(u.truncate('hello world', 6)).toBe('hello…');
    expect(u.truncate(null, 3)).toBe('');
  });

  test('formatDay / isoDate use script time zone', () => {
    const u = load().Util;
    // 2026-09-24 03:00Z is still Wed 23 Sep in Los Angeles
    expect(u.formatDay(new Date('2026-09-24T03:00:00Z'))).toBe('Wed 23 Sep');
    expect(u.formatDay(new Date('2026-09-24T18:00:00Z'))).toBe('Thu 24 Sep');
    expect(u.isoDate(new Date('2026-09-24T03:00:00Z'))).toBe('2026-09-23');
    expect(u.formatDay('2026-09-24T18:00:00Z')).toBe('Thu 24 Sep');
    const other = load({ timeZone: 'Europe/London' }).Util;
    expect(other.isoDate(new Date('2026-09-24T03:00:00Z'))).toBe('2026-09-24');
  });

  test('addDays and DST-safe addDaysIso', () => {
    const u = load().Util;
    expect(u.addDays(new Date('2026-09-24T10:00:00Z'), 7).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(u.addDaysIso('2026-09-24', 7)).toBe('2026-10-01');
    expect(u.addDaysIso('2026-12-30', 3)).toBe('2027-01-02');
    expect(u.addDaysIso('2026-03-08', -1)).toBe('2026-03-07');
    expect(u.addDaysIso(new Date('2026-09-24T18:00:00Z'), 1)).toBe('2026-09-25');
    expect(() => u.addDaysIso('nope', 1)).toThrow(/bad date/);
  });

  test('parseDate / isIsoDate / toDate', () => {
    const u = load().Util;
    expect(u.parseDate('')).toBeNull();
    expect(u.parseDate('garbage')).toBeNull();
    expect(u.parseDate('2026-09-24T10:00:00Z').toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(u.toDate(0).getTime()).toBe(0);
    expect(u.isIsoDate('2026-09-24')).toBe(true);
    expect(u.isIsoDate('2026-9-24')).toBe(false);
  });

  test('emailDomain / parseEmail', () => {
    const u = load().Util;
    expect(u.emailDomain('Jon <jon@GResearch.co.uk>')).toBe('gresearch.co.uk');
    expect(u.emailDomain('nobody')).toBeNull();
    expect(u.parseEmail('"Stumpf, Jon" <Jon.Stumpf@example.com>')).toBe('jon.stumpf@example.com');
    expect(u.parseEmail('')).toBeNull();
  });

  test('chunk / uniq / parseJson / sleep', () => {
    const ctx = load();
    const u = ctx.Util;
    expect(u.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(u.uniq([1, 2, 1, 3])).toEqual([1, 2, 3]);
    expect(u.uniq([{ k: 'a' }, { k: 'a' }, { k: 'b' }], x => x.k)).toHaveLength(2);
    expect(u.parseJson('{"a":1}', null)).toEqual({ a: 1 });
    expect(u.parseJson('{', 'd')).toBe('d');
    u.sleep(50);
    expect(ctx.__mocks.Utilities.__sleeps).toEqual([50]);
  });
});

describe('mock Utilities.formatDate', () => {
  test('supports common SimpleDateFormat patterns', () => {
    const d = new Date('2026-09-24T18:05:09Z');
    expect(formatDate(d, 'America/Los_Angeles', "yyyy-MM-dd'T'HH:mm:ssXXX")).toBe('2026-09-24T11:05:09-07:00');
    expect(formatDate(d, 'UTC', 'EEEE d MMMM yy h:mm a Z')).toBe('Thursday 24 September 26 6:05 PM +0000');
    expect(formatDate(d, 'GMT', "'It''s' HH")).toBe("It's 18");
  });

  test('mocks.reset rebuilds fresh fakes and rebinds a loaded context', () => {
    const mocks = createMocks({ props: { A: '1' } });
    const ctx = loadGas(['Config.js'], { mocks });
    ctx.Config.set('A', '2');
    mocks.reset();
    expect(ctx.Config.get('A')).toBe('1');
  });
});
