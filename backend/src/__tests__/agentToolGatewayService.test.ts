import {
  AgentToolPolicyBlockedError,
  executeAgentToolThroughGateway,
  evaluateAgentToolPolicy,
  summarizeAgentToolPolicyFlags,
  summarizeAgentToolPolicyModes,
  validateAndRepairToolArgs,
} from '../services/agentToolGatewayService';

describe('agentToolGatewayService', () => {
  it('treats read tools as low-risk and allowed', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'search_web',
      args: { query: 'agent reliability architecture' },
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: 'observe',
      effect: 'read',
      risk: 'low',
      flags: [],
    });
  });

  it('flags external send tools as high-risk and confirmation recommended', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'send_email',
      args: { to: 'customer@example.com', subject: 'hello' },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.effect).toBe('external_send');
    expect(decision.risk).toBe('high');
    expect(decision.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'confirmation_recommended', severity: 'critical' }),
    ]));
  });

  it('can enforce critical policy flags behind an explicit switch', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'publish_blog_article',
      args: { status: 'published' },
      enforce: true,
    });

    expect(decision.mode).toBe('enforce');
    expect(decision.allowed).toBe(false);
    expect(decision.flags.map((flag) => flag.code)).toContain('confirmation_recommended');
  });

  it('detects a GTM-plan tool chosen for task-like language', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'create_gtm_plan',
      args: {
        title: 'Internal follow-up',
        description: 'Create a task to review the AgentRun stress trace',
      },
    });

    expect(decision.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'possible_task_tool_mismatch', severity: 'warning' }),
    ]));
  });

  it('marks session-state tools as low-risk side effects', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'save_memory',
      args: { content: 'User prefers concise status updates' },
    });

    expect(decision.effect).toBe('session_state');
    expect(decision.risk).toBe('low');
    expect(decision.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'side_effecting_tool', severity: 'info' }),
    ]));
  });

  it('raises shared-session side effects to high risk', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'update_html_file',
      args: { file_url: 'https://example.com/page.html' },
      isSharedSession: true,
    });

    expect(decision.effect).toBe('internal_write');
    expect(decision.risk).toBe('high');
    expect(decision.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'shared_session_side_effect', severity: 'critical' }),
    ]));
  });

  it('summarizes policy decisions for compact AgentRun telemetry', () => {
    const decisions = [
      evaluateAgentToolPolicy({ toolName: 'search_web' }),
      evaluateAgentToolPolicy({ toolName: 'send_email' }),
    ];

    expect(summarizeAgentToolPolicyFlags(decisions)).toContain('send_email:confirmation_recommended:critical');
    expect(summarizeAgentToolPolicyModes(decisions)).toContain('search_web:read:low:observe');
  });

  it('executes allowed tools and returns the exact result object', async () => {
    const result = { ok: true, nested: { id: 'same-reference' } };
    let now = 100;

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'search_web',
      args: { query: 'agent runtime' },
      now: () => {
        now += 25;
        return now;
      },
      execute: async () => result,
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result).toBe(result);
      expect(outcome.durationMs).toBe(25);
      expect(outcome.policyDecision.effect).toBe('read');
    }
  });

  it('preserves the exact error object when the tool throws', async () => {
    const error = new Error('tool failed');

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'search_web',
      execute: async () => {
        throw error;
      },
    });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toBe(error);
      expect(outcome.policyDecision.allowed).toBe(true);
    }
  });

  it('blocks before execution only when policy is already enforcing', async () => {
    const execute = jest.fn(async () => ({ shouldNotRun: true }));

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'publish_blog_article',
      args: { status: 'published' },
      enforce: true,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toBeInstanceOf(AgentToolPolicyBlockedError);
      expect(outcome.policyDecision.allowed).toBe(false);
    }
  });

  describe('tool contract validation', () => {
    const readFileSchema = {
      type: 'object',
      properties: {
        file_url: { type: 'string' }
      },
      required: ['file_url'],
      additionalProperties: false
    };

    it('passes args through when no object schema exists', () => {
      const args = { anything: ['goes'] };

      expect(validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args,
      })).toEqual({
        status: 'valid',
        args,
        issues: [],
        repairs: [],
      });

      expect(validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args,
        inputSchema: { type: 'string' },
      })).toEqual({
        status: 'valid',
        args,
        issues: [],
        repairs: [],
      });
    });

    it('rejects non-object args before tool code runs', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: ['https://example.com/pasted-text.txt'],
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.issues).toEqual([
          expect.objectContaining({ code: 'invalid_args', path: '$' }),
        ]);
      }
    });

    it('passes valid args unchanged', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: { file_url: 'https://example.com/pasted-text.txt' },
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('valid');
      expect(result.args).toEqual({ file_url: 'https://example.com/pasted-text.txt' });
      expect(result.repairs).toEqual([]);
    });

    it('repairs low-risk url alias drift before execution', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: { url: 'https://example.com/pasted-text.txt' },
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({ file_url: 'https://example.com/pasted-text.txt' });
      expect(result.repairs).toEqual(['url->file_url']);
    });

    it('repairs known optional alias fields when the canonical required field is missing', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: { url: 'https://example.com/pasted-text.txt' },
        inputSchema: {
          type: 'object',
          properties: {
            file_url: { type: 'string' },
            url: { type: 'string' }
          },
          required: ['file_url']
        },
        effect: 'read',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({ file_url: 'https://example.com/pasted-text.txt' });
      expect(result.repairs).toEqual(['url->file_url']);
    });

    it('repairs camelCase property drift when the target field is known', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: { fileUrl: 'https://example.com/pasted-text.txt' },
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({ file_url: 'https://example.com/pasted-text.txt' });
      expect(result.repairs).toEqual(['fileUrl->file_url']);
    });

    it('does not guess when URL alias repair is ambiguous', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'compare_pages',
        args: { url: 'https://example.com/page-a.html' },
        inputSchema: {
          type: 'object',
          properties: {
            source_url: { type: 'string' },
            target_url: { type: 'string' },
          },
          required: ['source_url', 'target_url'],
          additionalProperties: false
        },
        effect: 'read',
      });

      expect(result.status).toBe('invalid');
      expect(result.repairs).toEqual([]);
      if (result.status === 'invalid') {
        expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
          'unknown_property',
          'missing_required',
        ]));
      }
    });

    it('rejects missing required args with a model-visible retry message', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: {},
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.modelMessage).toContain('failed schema validation before execution');
        expect(result.modelMessage).toContain('Missing required argument "file_url"');
      }
    });

    it('does not semantically repair URL aliases for side-effecting tools', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'send_email',
        args: { url: 'https://example.com' },
        inputSchema: {
          type: 'object',
          properties: {
            body_url: { type: 'string' }
          },
          required: ['body_url'],
          additionalProperties: false
        },
        effect: 'external_send',
      });

      expect(result.status).toBe('invalid');
      expect(result.args).toEqual({ url: 'https://example.com' });
      expect(result.repairs).toEqual([]);
    });

    it('rejects unknown fields when schema is strict', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: {
          file_url: 'https://example.com/pasted-text.txt',
          unexpected: true
        },
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.issues.map((issue) => issue.code)).toContain('unknown_property');
      }
    });

    it('allows extra fields when the schema permits additional properties', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: {
          file_url: 'https://example.com/pasted-text.txt',
          metadata: { source: 'upload' }
        },
        inputSchema: {
          type: 'object',
          properties: {
            file_url: { type: 'string' }
          },
          required: ['file_url']
        },
        effect: 'read',
      });

      expect(result.status).toBe('valid');
      expect(result.args).toEqual({
        file_url: 'https://example.com/pasted-text.txt',
        metadata: { source: 'upload' }
      });
    });

    it('rejects wrong primitive types before tool code runs', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'read_file_content',
        args: { file_url: 123 },
        inputSchema: readFileSchema,
        effect: 'read',
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'type_mismatch', path: '$.file_url' }),
        ]));
      }
    });

    it('validates common JSON schema primitive types', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          ratio: { type: 'number' },
          enabled: { type: 'boolean' },
          tags: { type: 'array' },
          options: { type: 'object' },
          maybe: { type: ['string', 'null'] },
        },
        required: ['count', 'ratio', 'enabled', 'tags', 'options', 'maybe'],
        additionalProperties: false
      };

      expect(validateAndRepairToolArgs({
        toolName: 'read_metrics',
        args: {
          count: 2,
          ratio: 0.5,
          enabled: true,
          tags: ['a'],
          options: { compact: true },
          maybe: null,
        },
        inputSchema: schema,
        effect: 'read',
      }).status).toBe('valid');

      const result = validateAndRepairToolArgs({
        toolName: 'read_metrics',
        args: {
          count: 2.5,
          ratio: Number.POSITIVE_INFINITY,
          enabled: 'true',
          tags: 'a',
          options: ['compact'],
          maybe: false,
        },
        inputSchema: schema,
        effect: 'read',
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
          '$.count',
          '$.ratio',
          '$.enabled',
          '$.tags',
          '$.options',
          '$.maybe',
        ]));
      }
    });

    it('repairs explicit schema aliases even for side-effecting tools', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'coding_agent',
        args: {
          landing_page_id: 'lp_123',
          instructions: 'Make the hero headline clearer'
        },
        inputSchema: {
          type: 'object',
          properties: {
            page_id: { type: 'string', 'x-aliases': ['landing_page_id'] },
            task_description: { type: 'string', 'x-aliases': ['instructions'] },
          },
          required: ['page_id', 'task_description'],
          additionalProperties: false
        },
        effect: 'internal_write',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({
        page_id: 'lp_123',
        task_description: 'Make the hero headline clearer'
      });
      expect(result.repairs).toEqual([
        'landing_page_id->page_id',
        'instructions->task_description',
      ]);
    });

    it('enforces array minItems and item types from schema', () => {
      const emptyResult = validateAndRepairToolArgs({
        toolName: 'install_skills',
        args: { skillIds: [] },
        inputSchema: {
          type: 'object',
          properties: {
            skillIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
          required: ['skillIds'],
          additionalProperties: false
        },
        effect: 'session_state',
      });

      expect(emptyResult.status).toBe('invalid');
      if (emptyResult.status === 'invalid') {
        expect(emptyResult.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_args',
            path: '$.skillIds',
            message: 'Argument "skillIds" must contain at least 1 item(s).',
          }),
        ]));
      }

      const wrongItemResult = validateAndRepairToolArgs({
        toolName: 'install_skills',
        args: { skillIds: ['__other_skills__', 123] },
        inputSchema: {
          type: 'object',
          properties: {
            skillIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
          required: ['skillIds'],
          additionalProperties: false
        },
        effect: 'session_state',
      });

      expect(wrongItemResult.status).toBe('invalid');
      if (wrongItemResult.status === 'invalid') {
        expect(wrongItemResult.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'type_mismatch', path: '$.skillIds[1]' }),
        ]));
      }
    });
  });
});
