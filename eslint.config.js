const js = require('@eslint/js');

// Module globals (docs/DESIGN.md "Files and ownership"): each root file defines one of these.
const MODULES = [
  'Config', 'Util', 'Http', 'Store', 'Todoist', 'Claude', 'Granola', 'Fireflies', 'CalendarLookup',
  'Route', 'Dedupe', 'Extract', 'Meetings', 'Waiting', 'Inbox', 'Slack', 'Checks', 'Triage'
];

// Trigger entrypoints and web-app server functions (top-level function declarations).
const ENTRYPOINTS = [
  'createTaskFromStarred', 'runMeetings', 'runSlack', 'runInboxSweep', 'runWaiting', 'runSummaryCheck',
  'runTriageDigest', 'runBackfill', 'installTriggers', 'uninstallAllTriggers', 'checkSetup',
  'doGet', 'doPost', 'triageList', 'triageAct', 'include',
  // legacy Code.js helpers kept for tests
  'walkHtmlAndExtract', 'createTrigger'
];

const APPS_SCRIPT = [
  'SpreadsheetApp', 'CalendarApp', 'CacheService', 'LockService', 'HtmlService', 'Session', 'Utilities',
  'ContentService', 'GmailApp', 'UrlFetchApp', 'PropertiesService', 'ScriptApp', 'Logger'
];

const toGlobals = (names, mode) => Object.fromEntries(names.map(n => [n, mode]));

const JEST = toGlobals([
  'jest', 'describe', 'test', 'it', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'fail'
], 'readonly');
const NODE = toGlobals([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global', 'console',
  'setTimeout', 'clearTimeout'
], 'readonly');

// Legacy Code.js functions that __tests__/Code.test.js eval()s into the test scope.
const CODE_TEST_EVAL = toGlobals(['extractCleanBodySimple', 'cleanEmailBody', 'createTaskFromStarred'], 'readonly');

const unusedPattern = '^(' + MODULES.concat(ENTRYPOINTS).join('|') + ')$|_$';

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'docs/**'] },
  js.configs.recommended,
  {
    files: ['*.js'],
    ignores: ['eslint.config.js', 'jest.config.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: Object.assign(
        { console: 'readonly' },
        toGlobals(APPS_SCRIPT, 'readonly'),
        toGlobals(MODULES, 'writable')
      )
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: unusedPattern, args: 'none', caughtErrors: 'none' }],
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-undef': 'error',
      'prefer-const': 'warn',
      'no-var': 'warn',
      eqeqeq: 'warn',
      'no-console': 'off',
      'no-extra-semi': 'warn'
    }
  },
  {
    files: ['eslint.config.js', 'jest.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: NODE }
  },
  {
    files: ['__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: Object.assign({}, NODE, JEST, CODE_TEST_EVAL, toGlobals(APPS_SCRIPT, 'writable'), toGlobals(MODULES, 'writable'))
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: unusedPattern, args: 'none', caughtErrors: 'none' }],
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-undef': 'error'
    }
  }
];
