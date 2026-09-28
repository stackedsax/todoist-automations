/**
 * Config — Script Properties access, defaults, identity and routing tables.
 *
 * Script Properties (see docs/DESIGN.md "Script Properties"):
 *   Required: TODOIST_API_TOKEN, ANTHROPIC_API_KEY, CLAUDE_MODEL, GRANOLA_API_KEY
 *   Optional: FIREFLIES_API_KEY, SLACK_WORKSPACES, ROUTING, IDENTITY, BACKFILL_DAYS,
 *             DIRECT_CONFIDENCE, STATE_SHEET_ID, TRIAGE_URL, SLACK_TODO_EMOJI
 *
 * JSON overrides (ROUTING, IDENTITY) are deep-merged over the defaults:
 * plain objects merge key by key, arrays and scalars replace.
 */
const Config = {
  DEFAULT_IDENTITY: {
    myNames: ['Alex Scammon', 'Alexander Scammon', 'A Scammon', 'Alex S', 'AlexS', 'Alexander'],
    notMe: ['Alex Blundell'], // a colleague in most ISC meetings: NEVER treat as Alex
    myEmails: ['alex@insightsoftmax.com', 'alex@gr-oss.io', 'alex@alexscammon.com'],
    assistants: ['morasha@insightsoftmax.com'] // Morasha books meetings for Alex
  },

  DEFAULT_ROUTING: {
    projects: { GR: 'GR', ISC: 'ISC', Me: 'Me', SG: 'SG', Inbox: 'Inbox', Waiting: 'Waiting on others' },
    calendars: { 'alex@gr-oss.io': 'GR', 'alex@insightsoftmax.com': 'ISC', 'alex@alexscammon.com': 'Me' },
    domains: {
      'gr-oss.io': 'GR', 'gresearch.co.uk': 'GR', 'gresearch.com': 'GR', 'armadaproject.io': 'GR',
      'nmc2.ai': 'GR', 'arctosalliance.org': 'GR', 'cncf.io': 'GR', 'linuxfoundation.org': 'GR',
      'insightsoftmax.com': 'ISC'
    },
    sectionHints: {
      'arctosalliance.org': 'GR/Arctos',
      'cncf.io': 'GR/KubeCon / Armada / CNCF Batch',
      'armadaproject.io': 'GR/KubeCon / Armada / CNCF Batch'
    },
    neverUseSections: ['Generated Tasks']
  },

  /** Hints shown in Config.require errors. */
  HELP_: {
    TODOIST_API_TOKEN: 'Todoist > Settings > Integrations > Developer > API token',
    ANTHROPIC_API_KEY: 'console.anthropic.com > API keys',
    CLAUDE_MODEL: 'an Anthropic model id, e.g. claude-sonnet-4-5',
    GRANOLA_API_KEY: 'Granola > Settings > API'
  },

  props_() {
    return PropertiesService.getScriptProperties();
  },

  /** Raw string property, or `def` when unset/empty. */
  get(key, def) {
    const v = Config.props_().getProperty(key);
    if (v === null || v === undefined || v === '') return def === undefined ? null : def;
    return v;
  },

  /** Set (or with null/undefined, delete) a Script Property. */
  set(key, value) {
    const p = Config.props_();
    if (value === null || value === undefined) p.deleteProperty(key);
    else p.setProperty(key, String(value));
  },

  /** Property value; throws `Missing Script Property: KEY ...` when unset. */
  require(key) {
    const v = Config.get(key, null);
    if (v === null) {
      const hint = Config.HELP_[key] ? ' (' + Config.HELP_[key] + ')' : '';
      throw new Error('Missing Script Property: ' + key +
        '. Set it in the Apps Script editor: Project Settings > Script Properties > Add script property' + hint + '.');
    }
    return v;
  },

  /** Parsed JSON property, or `def` when unset. Throws a clear error on invalid JSON. */
  json(key, def) {
    const raw = Config.get(key, null);
    if (raw === null) return def === undefined ? null : def;
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error('Script Property ' + key + ' is not valid JSON: ' + e.message);
    }
  },

  /** Integer property with default. */
  int(key, def) {
    const raw = Config.get(key, null);
    const n = raw === null ? NaN : parseInt(raw, 10);
    return isNaN(n) ? def : n;
  },

  /** Identity defaults deep-merged with the IDENTITY override. */
  identity() {
    return Config.merge_(Config.clone_(Config.DEFAULT_IDENTITY), Config.json('IDENTITY', {}) || {});
  },

  /** Routing defaults deep-merged with the ROUTING override. */
  routing() {
    return Config.merge_(Config.clone_(Config.DEFAULT_ROUTING), Config.json('ROUTING', {}) || {});
  },

  /** BACKFILL_DAYS (default 28). */
  backfillDays() {
    return Config.int('BACKFILL_DAYS', 28);
  },

  /** DIRECT_CONFIDENCE (default "high"): minimum item confidence for direct task creation. */
  directConfidence() {
    return String(Config.get('DIRECT_CONFIDENCE', 'high')).toLowerCase();
  },

  /** SLACK_WORKSPACES parsed ([] when unset). */
  slackWorkspaces() {
    const ws = Config.json('SLACK_WORKSPACES', []);
    return Array.isArray(ws) ? ws : [];
  },

  /** True if `email` is one of identity.myEmails (case-insensitive). */
  isMyEmail(email) {
    if (!email) return false;
    const e = String(email).trim().toLowerCase();
    return Config.identity().myEmails.some(function (m) { return m.toLowerCase() === e; });
  },

  /** True if `name` matches identity.notMe (case-insensitive, whitespace-normalised). */
  isNotMe(name) {
    if (!name) return false;
    const n = Config.normName_(name);
    return Config.identity().notMe.some(function (m) { return Config.normName_(m) === n; });
  },

  /** True if `name` matches identity.myNames and is not in notMe. */
  isMyName(name) {
    if (!name || Config.isNotMe(name)) return false;
    const n = Config.normName_(name);
    return Config.identity().myNames.some(function (m) { return Config.normName_(m) === n; });
  },

  normName_(s) {
    return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
  },

  clone_(o) {
    return JSON.parse(JSON.stringify(o));
  },

  isPlain_(o) {
    return o !== null && typeof o === 'object' && !Array.isArray(o);
  },

  merge_(base, over) {
    if (!Config.isPlain_(over)) return base;
    Object.keys(over).forEach(function (k) {
      const v = over[k];
      if (Config.isPlain_(v) && Config.isPlain_(base[k])) base[k] = Config.merge_(base[k], v);
      else base[k] = Config.isPlain_(v) || Array.isArray(v) ? Config.clone_(v) : v;
    });
    return base;
  }
};
