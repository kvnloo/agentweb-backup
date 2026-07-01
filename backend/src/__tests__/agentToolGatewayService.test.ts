import {
  AgentToolBudgetExceededError,
  AgentToolPolicyBlockedError,
  AgentToolRepeatedFailureError,
  _resetAgentToolFailureBreaker,
  executeAgentToolThroughGateway,
  evaluateAgentToolPolicy,
  summarizeAgentToolPolicyFlags,
  summarizeAgentToolPolicyModes,
  validateAndRepairToolArgs,
} from '../services/agentToolGatewayService';

describe('agentToolGatewayService', () => {
  it('treats read tools as low-risk and allowed', () => {
    const decision = evaluateAgentToolPolicy({
      toolName: 'you_search_web',
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
      evaluateAgentToolPolicy({ toolName: 'you_search_web' }),
      evaluateAgentToolPolicy({ toolName: 'you_search_news' }),
      evaluateAgentToolPolicy({ toolName: 'google_search_web' }),
      evaluateAgentToolPolicy({ toolName: 'send_email' }),
    ];

    expect(summarizeAgentToolPolicyFlags(decisions)).toContain('send_email:confirmation_recommended:critical');
    expect(summarizeAgentToolPolicyModes(decisions)).toContain('you_search_web:read:low:observe');
    expect(summarizeAgentToolPolicyModes(decisions)).toContain('you_search_news:read:low:observe');
    expect(summarizeAgentToolPolicyModes(decisions)).toContain('google_search_web:read:low:observe');
  });

  it('executes allowed tools and returns the exact result object', async () => {
    const result = { ok: true, nested: { id: 'same-reference' } };
    let now = 100;

    const outcome = await executeAgentToolThroughGateway({
      toolName: 'you_search_web',
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
      toolName: 'you_search_web',
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

    describe('scalar coercion (number/boolean string repair)', () => {
      // Mirrors the real read_tool_response / search_tool_response schemas, which
      // were the #1 production failure cluster: the model emits numeric args as
      // strings ("0", "8000") and the type validator hard-rejected them.
      const readToolResponseSchema = {
        type: 'object',
        properties: {
          s3_key: { type: 'string' },
          char_offset: { type: 'number' },
          char_length: { type: 'number' },
        },
        required: ['s3_key'],
      };
      const searchToolResponseSchema = {
        type: 'object',
        properties: {
          s3_key: { type: 'string' },
          query: { type: 'string' },
          match_offset: { type: 'number' },
          max_matches: { type: 'number' },
          context_chars: { type: 'number' },
        },
        required: ['s3_key', 'query'],
      };

      it('coerces stringified numbers for read_tool_response (repro: real failure mode)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_tool_response',
          args: { s3_key: 'tool-responses/abc', char_offset: '0', char_length: '8000' },
          inputSchema: readToolResponseSchema,
          effect: 'read',
        });

        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({ s3_key: 'tool-responses/abc', char_offset: 0, char_length: 8000 });
        expect(result.repairs).toEqual(
          expect.arrayContaining(['char_offset:scalar_coerce', 'char_length:scalar_coerce']),
        );
      });

      it('coerces stringified match_offset for search_tool_response (repro: real failure mode)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'search_tool_response',
          args: { s3_key: 'tool-responses/abc', query: 'link_url', match_offset: '20' },
          inputSchema: searchToolResponseSchema,
          effect: 'read',
        });

        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({ s3_key: 'tool-responses/abc', query: 'link_url', match_offset: 20 });
        expect(result.repairs).toEqual(expect.arrayContaining(['match_offset:scalar_coerce']));
      });

      it('coerces decimal and signed numbers', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_tool_response',
          args: { s3_key: 'k', char_offset: '-5', char_length: '12.5' },
          inputSchema: readToolResponseSchema,
          effect: 'read',
        });
        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({ s3_key: 'k', char_offset: -5, char_length: 12.5 });
      });

      it('coerces stringified booleans', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'some_tool',
          args: { enabled: 'true', disabled: 'FALSE' },
          inputSchema: {
            type: 'object',
            properties: { enabled: { type: 'boolean' }, disabled: { type: 'boolean' } },
            required: [],
          },
          effect: 'read',
        });
        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({ enabled: true, disabled: false });
      });

      it('does NOT coerce when the schema also accepts string (behavior preserved)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'some_tool',
          args: { val: '42' },
          inputSchema: {
            type: 'object',
            properties: { val: { type: ['string', 'number'] } },
            required: [],
          },
          effect: 'read',
        });
        expect(result.status).toBe('valid');
        expect(result.args).toEqual({ val: '42' });
      });

      it('leaves already-correct numbers unchanged (success path behavior-preserving)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_tool_response',
          args: { s3_key: 'k', char_offset: 0, char_length: 8000 },
          inputSchema: readToolResponseSchema,
          effect: 'read',
        });
        expect(result.status).toBe('valid');
        expect(result.args).toEqual({ s3_key: 'k', char_offset: 0, char_length: 8000 });
        expect(result.repairs).toEqual([]);
      });

      it('still rejects a non-numeric string as a type mismatch (no silent NaN)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_tool_response',
          args: { s3_key: 'k', char_offset: 'beginning' },
          inputSchema: readToolResponseSchema,
          effect: 'read',
        });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues.map((i) => i.code)).toContain('type_mismatch');
        }
      });
    });

    describe('container coercion (stringified array/object repair)', () => {
      // Mirrors read_knowledge_base_files (ENG-127): the model double-encodes the
      // required `files` array as a JSON string, and the type validator hard-rejected
      // it with "Expected array." even though the decoded value is a valid array.
      const readKnowledgeBaseFilesSchema = {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kb_identifier: { type: 'string' },
                file_name: { type: 'string' },
              },
              required: ['kb_identifier', 'file_name'],
            },
          },
        },
        required: ['files'],
      };

      it('coerces a stringified array of objects for read_knowledge_base_files (repro: ENG-127)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_knowledge_base_files',
          args: { files: '[{"kb_identifier":"task123","file_name":"knowledge-base.txt"}]' },
          inputSchema: readKnowledgeBaseFilesSchema,
          effect: 'read',
        });

        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({
          files: [{ kb_identifier: 'task123', file_name: 'knowledge-base.txt' }],
        });
        expect(result.repairs).toEqual(expect.arrayContaining(['files:json_parse']));
      });

      it('coerces a stringified array of plain string identifiers', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'some_tool',
          args: { ids: '["a","b","c"]' },
          inputSchema: {
            type: 'object',
            properties: { ids: { type: 'array', items: { type: 'string' } } },
            required: ['ids'],
          },
          effect: 'read',
        });
        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({ ids: ['a', 'b', 'c'] });
        expect(result.repairs).toEqual(expect.arrayContaining(['ids:json_parse']));
      });

      it('coerces a stringified object when the schema expects an object', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'some_tool',
          args: { config: '{"enabled":true,"limit":5}' },
          inputSchema: {
            type: 'object',
            properties: { config: { type: 'object' } },
            required: ['config'],
          },
          effect: 'read',
        });
        expect(result.status).toBe('repaired');
        expect(result.args).toEqual({ config: { enabled: true, limit: 5 } });
        expect(result.repairs).toEqual(expect.arrayContaining(['config:json_parse']));
      });

      it('leaves an already-valid array unchanged (behavior-preserving)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_knowledge_base_files',
          args: { files: [{ kb_identifier: 'task123', file_name: 'knowledge-base.txt' }] },
          inputSchema: readKnowledgeBaseFilesSchema,
          effect: 'read',
        });
        expect(result.status).toBe('valid');
        expect(result.repairs).toEqual([]);
      });

      it('does NOT coerce when the schema also accepts string', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'some_tool',
          args: { val: '["a"]' },
          inputSchema: {
            type: 'object',
            properties: { val: { type: ['string', 'array'] } },
            required: [],
          },
          effect: 'read',
        });
        expect(result.status).toBe('valid');
        expect(result.args).toEqual({ val: '["a"]' });
      });

      it('still rejects a non-JSON string as a type mismatch (no silent pass)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_knowledge_base_files',
          args: { files: 'knowledge-base.txt' },
          inputSchema: readKnowledgeBaseFilesSchema,
          effect: 'read',
        });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues.map((i) => i.code)).toContain('type_mismatch');
        }
      });

      it('does NOT coerce a stringified object when the schema expects an array', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_knowledge_base_files',
          args: { files: '{"kb_identifier":"task123"}' },
          inputSchema: readKnowledgeBaseFilesSchema,
          effect: 'read',
        });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues.map((i) => i.code)).toContain('type_mismatch');
        }
      });
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
        // 'yes' is not a coercible boolean (only 'true'/'false' coerce), so it must
        // still surface as a type mismatch. 2.5 is not a valid integer; Infinity is
        // not a finite number.
        args: {
          count: 2.5,
          ratio: Number.POSITIVE_INFINITY,
          enabled: 'yes',
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

    it('repairs explicit JSON aliases by serializing object values to the canonical string field', () => {
      const operations = [{
        action: 'replaceInner',
        selector: 'p',
        html: 'The gateway normalized the alias and the update still worked.'
      }];

      const result = validateAndRepairToolArgs({
        toolName: 'update_html_file',
        args: {
          file_url: 'https://example.com/source.html',
          replacement_json: operations,
          update_type: 'css',
        },
        inputSchema: {
          type: 'object',
          properties: {
            file_url: { type: 'string' },
            operations_json: {
              type: 'string',
              description: 'JSON array of CSS-selector operations',
              'x-aliases': ['replacement_json'],
            },
            update_type: { type: 'string' },
          },
          required: ['file_url', 'operations_json'],
          additionalProperties: false,
        },
        effect: 'internal_write',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({
        file_url: 'https://example.com/source.html',
        operations_json: JSON.stringify(operations),
        update_type: 'css',
      });
      expect(result.repairs).toEqual([
        'replacement_json->operations_json',
        'operations_json:json_stringify',
      ]);
    });

    it('repairs common content aliases through the central gateway contract map', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'create_html_file',
        args: {
          title: 'Gateway Alias Test',
          html_content: '<h1>Hello</h1><p>Body</p>',
        },
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content_draft: { type: 'string' },
            format_requirements: { type: 'string' },
          },
          required: ['title', 'content_draft'],
          additionalProperties: false,
        },
        effect: 'internal_write',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({
        title: 'Gateway Alias Test',
        content_draft: '<h1>Hello</h1><p>Body</p>',
      });
      expect(result.repairs).toEqual(['html_content->content_draft']);
    });

    it('repairs create_html_file title and content aliases from model-shaped HTML args', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'create_html_file',
        args: {
          file_name: 'tool-gateway-schema-stress-test',
          html_content: '<h1>Gateway Alias Test</h1><p>Body</p>',
        },
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              'x-aliases': ['file_name', 'filename', 'name', 'headline', 'subject'],
            },
            content_draft: {
              type: 'string',
              'x-aliases': ['html_content', 'content', 'body', 'text', 'markdown', 'document_content'],
            },
            format_requirements: { type: 'string' },
          },
          required: ['title', 'content_draft'],
          additionalProperties: false,
        },
        effect: 'internal_write',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({
        title: 'tool-gateway-schema-stress-test',
        content_draft: '<h1>Gateway Alias Test</h1><p>Body</p>',
      });
      expect(result.repairs).toEqual([
        'file_name->title',
        'html_content->content_draft',
      ]);
    });

    it('repairs common save_file aliases without tool-specific handler code', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'save_file',
        args: {
          filename: 'report.html',
          content: '<html>Saved</html>',
        },
        inputSchema: {
          type: 'object',
          properties: {
            file_name: { type: 'string' },
            file_content: { type: 'string' },
          },
          required: ['file_name', 'file_content'],
          additionalProperties: false,
        },
        effect: 'internal_write',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({
        file_name: 'report.html',
        file_content: '<html>Saved</html>',
      });
      expect(result.repairs).toEqual([
        'filename->file_name',
        'content->file_content',
      ]);
    });

    it('repairs blog draft aliases while preserving canonical values when present', () => {
      const repaired = validateAndRepairToolArgs({
        toolName: 'create_blog_article',
        args: {
          title: 'Launch lessons',
          content: 'Draft article body',
        },
        inputSchema: {
          type: 'object',
          properties: {
            title_draft: { type: 'string' },
            content_draft: { type: 'string' },
          },
          required: ['title_draft', 'content_draft'],
          additionalProperties: false,
        },
        effect: 'internal_write',
      });

      expect(repaired.status).toBe('repaired');
      expect(repaired.args).toEqual({
        title_draft: 'Launch lessons',
        content_draft: 'Draft article body',
      });

      const canonical = validateAndRepairToolArgs({
        toolName: 'create_blog_article',
        args: {
          title_draft: 'Canonical title',
          title: 'Alias title',
          content_draft: 'Canonical body',
        },
        inputSchema: {
          type: 'object',
          properties: {
            title_draft: { type: 'string' },
            content_draft: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['title_draft', 'content_draft'],
          additionalProperties: true,
        },
        effect: 'internal_write',
      });

      expect(canonical.status).toBe('valid');
      expect(canonical.args).toEqual({
        title_draft: 'Canonical title',
        title: 'Alias title',
        content_draft: 'Canonical body',
      });
    });

    it('repairs S3 key aliases for tool-response readers', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'search_tool_response',
        args: {
          key: 'tool-responses/session/result.json',
          q: 'destination_url',
        },
        inputSchema: {
          type: 'object',
          properties: {
            s3_key: { type: 'string' },
            query: { type: 'string' },
          },
          required: ['s3_key', 'query'],
          additionalProperties: false,
        },
        effect: 'read',
      });

      expect(result.status).toBe('repaired');
      expect(result.args).toEqual({
        s3_key: 'tool-responses/session/result.json',
        query: 'destination_url',
      });
      expect(result.repairs).toEqual([
        'key->s3_key',
        'q->query',
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

    it('rejects LinkedIn send-invite notes over the conservative 200 character agent limit before dispatch', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'linkedin_outreach',
        args: {
          action: 'send-invite',
          profile_url: 'https://www.linkedin.com/in/example/',
          message: 'x'.repeat(201),
        },
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            profile_url: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['action'],
        },
        effect: 'external_send',
      });

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_args',
            path: '$.message',
          }),
        ]));
        expect(result.modelMessage).toContain('200 characters or fewer');
        expect(result.modelMessage).toContain('201');
      }
    });

    it('allows LinkedIn send-message bodies over 200 characters because the invite-note limit is action-specific', () => {
      const result = validateAndRepairToolArgs({
        toolName: 'linkedin_outreach',
        args: {
          action: 'send-message',
          profile_url: 'https://www.linkedin.com/in/example/',
          message: 'x'.repeat(500),
        },
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            profile_url: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['action'],
        },
        effect: 'external_send',
      });

      expect(result.status).toBe('valid');
    });
  });

  describe('call_hubspot_api effect classification', () => {
    const cases: Array<{ action: string; expectedEffect: string }> = [
      { action: 'LIST', expectedEffect: 'read' },
      { action: 'GET', expectedEffect: 'read' },
      { action: 'GET_STATS', expectedEffect: 'read' },
      { action: 'CREATE', expectedEffect: 'internal_write' },
      { action: 'UPDATE', expectedEffect: 'internal_write' },
      { action: 'CLONE', expectedEffect: 'internal_write' },
      { action: 'ADD_CONTACTS', expectedEffect: 'internal_write' },
      { action: 'ARCHIVE', expectedEffect: 'internal_write' },
      { action: 'DELETE', expectedEffect: 'destructive' },
      { action: 'DELETE_BROADCAST', expectedEffect: 'destructive' },
      { action: 'REMOVE_CONTACTS', expectedEffect: 'destructive' },
      { action: 'PUBLISH', expectedEffect: 'destructive' },
      { action: 'CREATE_BROADCAST', expectedEffect: 'external_publish' },
    ];

    for (const { action, expectedEffect } of cases) {
      it(`action=${action} → effect=${expectedEffect}`, () => {
        const decision = evaluateAgentToolPolicy({
          toolName: 'call_hubspot_api',
          args: { entity_type: 'CAMPAIGN', action },
        });
        expect(decision.effect).toBe(expectedEffect);
      });
    }
  });

  describe('repeated-failure circuit breaker', () => {
    beforeEach(() => {
      _resetAgentToolFailureBreaker();
    });

    const failingExecute = (message: string) => () => Promise.reject(new Error(message));

    async function failNTimes(runId: string, toolName: string, message: string, n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName,
          args: { attempt: i },
          runId,
          execute: failingExecute(message),
        });
        expect(outcome.status).toBe('error');
      }
    }

    it('blocks the next call after three identical failures in the same run', async () => {
      await failNTimes('run-a', 'linkedin_outreach', 'Invalid parameters', 3);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite' },
        runId: 'run-a',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        const message = (outcome.error as Error).message;
        expect(message).toContain('linkedin_outreach');
        expect(message).toContain('Invalid parameters');
        expect(message.toLowerCase()).toContain('do not retry');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('resets the failure count when the tool succeeds', async () => {
      await failNTimes('run-b', 'linkedin_outreach', 'Invitation message is too long', 2);

      const success = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite' },
        runId: 'run-b',
        execute: () => Promise.resolve({ ok: true }),
      });
      expect(success.status).toBe('success');

      await failNTimes('run-b', 'linkedin_outreach', 'Invitation message is too long', 2);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite' },
        runId: 'run-b',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('does not trip on three different errors for the same tool', async () => {
      await failNTimes('run-c', 'update_html_file', 'File hash mismatch', 1);
      await failNTimes('run-c', 'update_html_file', 'No selectors matched', 1);
      await failNTimes('run-c', 'update_html_file', 'Schema validation failed', 1);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'update_html_file',
        args: {},
        runId: 'run-c',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('blocks expensive media tools after two failures even when the error messages differ', async () => {
      await failNTimes('run-media', 'generate_image', 'Safety filter rejected image prompt', 1);
      await failNTimes('run-media', 'generate_image', 'Google image generation timed out after 10 minutes', 1);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'generate_image',
        args: { prompt: 'try one more expensive generation' },
        runId: 'run-media',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolBudgetExceededError);
        expect((outcome.error as Error).message).toContain('retry budget of 2');
        expect((outcome.error as Error).message.toLowerCase()).toContain('do not call it again');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('blocks expensive media retries across overlapping runs in the same session budget scope', async () => {
      const sessionScope = 'session-bodylever-image-storm';
      for (const runId of ['run-media-a', 'run-media-b']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'generate_image',
          args: { prompt: 'high-fidelity product ad' },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('Gemini image generation timed out after 600 seconds'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'generate_image',
        args: { prompt: 'one more overlapping attempt' },
        runId: 'run-media-c',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolBudgetExceededError);
        expect((outcome.error as Error).message).toContain('in this session');
        expect((outcome.error as Error).message).toContain('retry budget of 2');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('does not apply the expensive media budget to ordinary tools', async () => {
      await failNTimes('run-non-media', 'you_search_web', '429 rate limit', 1);
      await failNTimes('run-non-media', 'you_search_web', 'network timeout', 1);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'you_search_web',
        args: { query: 'fallback research' },
        runId: 'run-non-media',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('isolates failure counts between runs', async () => {
      await failNTimes('run-d', 'linkedin_outreach', 'Invalid parameters', 3);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: {},
        runId: 'run-e',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('evicts the oldest run once the tracked-run cap is exceeded', async () => {
      await failNTimes('run-oldest', 'linkedin_outreach', 'Invalid parameters', 3);

      // Push 500 more runs through to evict run-oldest from the tracker.
      for (let i = 0; i < 500; i += 1) {
        await failNTimes(`run-filler-${i}`, 'you_search_web', 'No search results found', 1);
      }

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: {},
        runId: 'run-oldest',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('never blocks calls without a runId', async () => {
      for (let i = 0; i < 4; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: {},
          execute: failingExecute('Invalid parameters'),
        });
        expect(outcome.status).toBe('error');
        if (outcome.status === 'error') {
          expect(outcome.error).not.toBeInstanceOf(AgentToolRepeatedFailureError);
        }
      }

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: {},
        execute,
      });
      expect(outcome.status).toBe('success');
    });
  });

  describe('call_hubspot_api effect classification', () => {
    const cases: Array<{ action: string; expectedEffect: string }> = [
      { action: 'LIST', expectedEffect: 'read' },
      { action: 'GET', expectedEffect: 'read' },
      { action: 'GET_STATS', expectedEffect: 'read' },
      { action: 'CREATE', expectedEffect: 'internal_write' },
      { action: 'UPDATE', expectedEffect: 'internal_write' },
      { action: 'CLONE', expectedEffect: 'internal_write' },
      { action: 'ADD_CONTACTS', expectedEffect: 'internal_write' },
      { action: 'ARCHIVE', expectedEffect: 'internal_write' },
      { action: 'DELETE', expectedEffect: 'destructive' },
      { action: 'DELETE_BROADCAST', expectedEffect: 'destructive' },
      { action: 'REMOVE_CONTACTS', expectedEffect: 'destructive' },
      { action: 'PUBLISH', expectedEffect: 'destructive' },
      { action: 'CREATE_BROADCAST', expectedEffect: 'external_publish' },
    ];

    for (const { action, expectedEffect } of cases) {
      it(`action=${action} → effect=${expectedEffect}`, () => {
        const decision = evaluateAgentToolPolicy({
          toolName: 'call_hubspot_api',
          args: { entity_type: 'CAMPAIGN', action },
        });
        expect(decision.effect).toBe(expectedEffect);
      });
    }
  });
});
