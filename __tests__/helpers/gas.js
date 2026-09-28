/**
 * loadGas(files, options) — evaluate Apps Script root files into ONE vm context that
 * shares the fakes from ./mocks.js as globals (like Apps Script's single global scope).
 *
 *   const { loadGas } = require('./helpers/gas');
 *   const ctx = loadGas(['Config.js', 'Util.js', 'Http.js', 'Todoist.js'], { props: { TODOIST_API_TOKEN: 't' } });
 *   ctx.Todoist.projects();
 *   ctx.__mocks.UrlFetchApp.__calls;
 *
 * Notes
 * - Top-level `const X =` / `let X =` at column 0 are rewritten to `var X =` so every module
 *   global is a property of the returned context. Tests may therefore replace whole modules
 *   (`ctx.Todoist = fake`) or individual methods (`ctx.Util.now = () => new Date(...)`).
 * - `options.globals` injects extra globals (e.g. a fake module for a file you didn't load).
 * - `files` omitted -> every production root .js file (alphabetical).
 * - The host realm's Date/Error constructors are shared with the context so `instanceof`
 *   works across mock/test/code boundaries.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMocks } = require('./mocks');

const ROOT = path.join(__dirname, '..', '..');
const NON_GAS = new Set(['eslint.config.js', 'jest.config.js']);

function allFiles() {
  return fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && !NON_GAS.has(f)).sort();
}

function transform(src) {
  return src.replace(/^(const|let)(\s+[A-Za-z_$][\w$]*\s*=)/gm, 'var$2');
}

/**
 * @param {string[]} [files] root-relative file names
 * @param {{mocks?: Object, globals?: Object, props?: Object} & Object} [options]
 *   mocks: an existing createMocks() result (else one is created from the remaining options)
 * @return {Object} the vm context (module globals, entrypoints, mocks, plus `__mocks`)
 */
function loadGas(files, options) {
  const opts = options || {};
  const mocks = opts.mocks || createMocks(opts);
  const context = Object.assign({
    Date, Error, TypeError, RangeError
  }, mocks.globals, opts.globals || {});
  context.__mocks = mocks;
  mocks.__context = context;
  vm.createContext(context);
  (files || allFiles()).forEach(f => {
    const file = path.isAbsolute(f) ? f : path.join(ROOT, f);
    const src = fs.readFileSync(file, 'utf8');
    vm.runInContext(transform(src), context, { filename: file });
  });
  return context;
}

module.exports = { loadGas, allFiles, transform, ROOT };
