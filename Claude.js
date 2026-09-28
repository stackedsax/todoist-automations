/**
 * Claude — Anthropic Messages API with forced tool use for structured JSON.
 *
 * Reference: https://docs.anthropic.com/en/api/messages
 *   POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
 *   body: {model, max_tokens, system, messages:[{role:"user", content}], tools:[{name, description, input_schema}],
 *          tool_choice:{type:"tool", name}}
 *   response: {content:[{type:"tool_use", id, name, input}, …], stop_reason, usage}
 * Tool use docs: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
 */
const Claude = {
  URL: 'https://api.anthropic.com/v1/messages',
  VERSION: '2023-06-01',
  TOOL: 'emit',
  MAX_USER_CHARS: 150000,
  DEFAULT_MAX_TOKENS: 4096,

  /** Last response usage ({input_tokens, output_tokens}) for run logging. */
  lastUsage: null,

  /**
   * Call Claude and return the `emit` tool input (an object matching `schema`).
   * @param {{system?: string, user: string, schema: Object, maxTokens?: number, model?: string,
   *          temperature?: number, description?: string}} req
   *   schema must be a JSON Schema with type "object" (tool input_schema requirement).
   * @return {Object}
   */
  json(req) {
    if (!req || !req.schema) throw new Error('Claude.json: schema required');
    if (req.schema.type !== 'object') throw new Error('Claude.json: schema.type must be "object"');
    const body = {
      model: req.model || Config.require('CLAUDE_MODEL'),
      max_tokens: req.maxTokens || Claude.DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: Claude.truncate_(req.user) }],
      tools: [{
        name: Claude.TOOL,
        description: req.description || 'Return the result as structured JSON matching the input schema.',
        input_schema: req.schema
      }],
      tool_choice: { type: 'tool', name: Claude.TOOL }
    };
    if (req.system) body.system = req.system;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;

    const res = Http.fetchJson(Claude.URL, {
      method: 'post',
      headers: { 'x-api-key': Config.require('ANTHROPIC_API_KEY'), 'anthropic-version': Claude.VERSION },
      payload: body
    });
    Claude.lastUsage = (res && res.usage) || null;
    const block = ((res && res.content) || []).find(function (b) { return b.type === 'tool_use' && b.name === Claude.TOOL; });
    if (res && res.stop_reason === 'max_tokens') {
      throw new Error('Claude output truncated at max_tokens=' + body.max_tokens);
    }
    if (!block || !block.input || typeof block.input !== 'object') {
      throw new Error('Claude response had no ' + Claude.TOOL + ' tool_use block (stop_reason=' + (res && res.stop_reason) + ')');
    }
    return block.input;
  },

  truncate_(user) {
    const s = String(user === null || user === undefined ? '' : user);
    if (s.length <= Claude.MAX_USER_CHARS) return s;
    return s.slice(0, Claude.MAX_USER_CHARS) + '\n\n[…truncated ' + (s.length - Claude.MAX_USER_CHARS) + ' chars]';
  }
};
