const { loadGas } = require('./helpers/gas');
const { respond } = require('./helpers/mocks');

const URL = 'https://api.anthropic.com/v1/messages';
const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } },
  required: ['items']
};

function setup(props) {
  const ctx = loadGas(['Config.js', 'Util.js', 'Http.js', 'Claude.js'], {
    props: props || { ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_MODEL: 'claude-test-model' }
  });
  ctx.Http.jitter_ = () => 0;
  return ctx;
}

const toolResponse = (input, extra) => respond.json(Object.assign({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-model', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit', input }],
  usage: { input_tokens: 100, output_tokens: 20 }
}, extra || {}));

describe('Claude.json', () => {
  test('builds a forced tool-use request and returns the tool input', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, toolResponse({ items: [{ title: 'Send deck' }] }));
    const out = ctx.Claude.json({ system: 'sys', user: 'transcript', schema: SCHEMA, maxTokens: 2000 });
    expect(out).toEqual({ items: [{ title: 'Send deck' }] });

    const call = ctx.__mocks.UrlFetchApp.__calls[0];
    expect(call.method).toBe('POST');
    expect(call.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.params.contentType).toBe('application/json');
    expect(call.json).toEqual({
      model: 'claude-test-model',
      max_tokens: 2000,
      system: 'sys',
      messages: [{ role: 'user', content: 'transcript' }],
      tools: [{ name: 'emit', description: expect.any(String), input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'emit' }
    });
    expect(ctx.Claude.lastUsage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  test('defaults max_tokens, omits system when absent, supports model/temperature override', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, toolResponse({ items: [] }));
    ctx.Claude.json({ user: 'u', schema: SCHEMA, model: 'other', temperature: 0 });
    const body = ctx.__mocks.UrlFetchApp.__calls[0].json;
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBeUndefined();
    expect(body.model).toBe('other');
    expect(body.temperature).toBe(0);
  });

  test('picks the emit tool_use block among other content', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, respond.json({
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', name: 'emit', input: { items: [1] } }]
    }));
    expect(ctx.Claude.json({ user: 'u', schema: SCHEMA })).toEqual({ items: [1] });
  });

  test('truncates long user content with a marker', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, toolResponse({ items: [] }));
    const long = 'x'.repeat(150010);
    ctx.Claude.json({ user: long, schema: SCHEMA });
    const content = ctx.__mocks.UrlFetchApp.__calls[0].json.messages[0].content;
    expect(content.startsWith('x'.repeat(150000))).toBe(true);
    expect(content).toMatch(/\[…truncated 10 chars\]$/);
    expect(content.length).toBeLessThan(150100);
  });

  test('throws when no tool_use block or output truncated', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, [
      respond.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }),
      toolResponse({ items: [] }, { stop_reason: 'max_tokens' })
    ]);
    expect(() => ctx.Claude.json({ user: 'u', schema: SCHEMA })).toThrow(/no emit tool_use block \(stop_reason=end_turn\)/);
    expect(() => ctx.Claude.json({ user: 'u', schema: SCHEMA })).toThrow(/truncated at max_tokens/);
  });

  test('validates schema', () => {
    const ctx = setup();
    expect(() => ctx.Claude.json({ user: 'u' })).toThrow(/schema required/);
    expect(() => ctx.Claude.json({ user: 'u', schema: { type: 'array' } })).toThrow(/type must be "object"/);
  });

  test('requires ANTHROPIC_API_KEY and CLAUDE_MODEL', () => {
    const ctx = setup({ ANTHROPIC_API_KEY: 'k' });
    expect(() => ctx.Claude.json({ user: 'u', schema: SCHEMA })).toThrow(/Missing Script Property: CLAUDE_MODEL/);
    const ctx2 = setup({ CLAUDE_MODEL: 'm' });
    expect(() => ctx2.Claude.json({ user: 'u', schema: SCHEMA })).toThrow(/Missing Script Property: ANTHROPIC_API_KEY/);
  });

  test('retries overloaded (529) via Http then succeeds; 400 is not retried', () => {
    const ctx = setup();
    ctx.__mocks.UrlFetchApp.__on('POST', URL, [respond.status(529, '{"type":"error","error":{"type":"overloaded_error"}}'), toolResponse({ items: [] })]);
    expect(ctx.Claude.json({ user: 'u', schema: SCHEMA })).toEqual({ items: [] });
    expect(ctx.__mocks.UrlFetchApp.__calls).toHaveLength(2);

    const ctx2 = setup();
    ctx2.__mocks.UrlFetchApp.__on('POST', URL, respond.status(400, '{"error":"bad"}'));
    expect(() => ctx2.Claude.json({ user: 'u', schema: SCHEMA })).toThrow(expect.objectContaining({ status: 400 }));
    expect(ctx2.__mocks.UrlFetchApp.__calls).toHaveLength(1);
  });
});
