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

      it('rejects a container-looking but malformed JSON string as a type mismatch (JSON.parse throws)', () => {
        const result = validateAndRepairToolArgs({
          toolName: 'read_knowledge_base_files',
          args: { files: '[{' },
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

    // ENG-243: an over-limit send-invite note must NOT be hard-rejected at the
    // gateway. The send path (sendInvitation) resolves the account-tier limit
    // (200 free / 300 Premium) and auto-trims the note on a word boundary, so a
    // send never fails on length. Pre-rejecting here instead produced repeated
    // invalid_args failures that tripped the anti-loop breaker and sent 0 invites.
    it('does not reject LinkedIn send-invite notes over 200 chars — the tier-aware send path trims them', () => {
      const overLimitNote = 'x'.repeat(201);
      const result = validateAndRepairToolArgs({
        toolName: 'linkedin_outreach',
        args: {
          action: 'send-invite',
          profile_url: 'https://www.linkedin.com/in/example/',
          message: overLimitNote,
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
      // The note is passed through untouched so the tier-aware send path can trim
      // it to the correct per-account limit (a free-tier gateway guess would
      // needlessly clip a Premium account's 300-char allowance).
      expect((result.args as Record<string, unknown>).message).toBe(overLimitNote);
      expect(result.issues).toEqual([]);
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

  // ENG-106: schema/impl contract alignment + semantic validation at the boundary.
  // Inlined copies of the POST-FIX schemas (the real ones in emma/tools.ts) so the
  // test exercises the narrow validateAndRepairToolArgs unit without booting the
  // agentModeService monolith.
  describe('semantic tool contract (ENG-106)', () => {
    describe('send_email_from_sender requires a non-empty body', () => {
      const sendEmailSchema = {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          html: { type: 'string' },
          text: { type: 'string', 'x-aliases': ['body'] },
          body: { type: 'string' },
          sender_id: { type: 'string' },
        },
        required: ['to', 'subject'],
      };

      const validate = (args: Record<string, unknown>) =>
        validateAndRepairToolArgs({
          toolName: 'send_email_from_sender',
          args,
          inputSchema: sendEmailSchema,
          effect: 'external_send',
        });

      it('rejects {to, subject} with no body', () => {
        const result = validate({ to: 'a@example.com', subject: 'Hi' });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: 'invalid_args', path: '$.body' }),
            ]),
          );
          expect(result.modelMessage.toLowerCase()).toContain('body');
        }
      });

      it('rejects a whitespace-only body', () => {
        const result = validate({ to: 'a@example.com', subject: 'Hi', html: '   ' });
        expect(result.status).toBe('invalid');
      });

      it('accepts a non-empty html body', () => {
        const result = validate({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' });
        expect(result.status).toBe('valid');
      });

      it('accepts a non-empty text body', () => {
        const result = validate({ to: 'a@example.com', subject: 'Hi', text: 'hi' });
        expect(result.status).toBe('valid');
      });

      it('accepts a non-empty body alias', () => {
        // `body` is an x-alias of `text`; the repair maps it before semantic check.
        const result = validate({ to: 'a@example.com', subject: 'Hi', body: 'hi' });
        expect(result.status === 'valid' || result.status === 'repaired').toBe(true);
      });
    });

    describe('get_meta_ads_metrics accepts legacy + current campaign-id shapes', () => {
      const metaSchema = {
        type: 'object',
        properties: {
          timeframe: { type: 'string', enum: ['7d', '14d', '30d', '90d'], default: '7d' },
          campaign_ids: { type: ['array', 'string'], items: { type: 'string' }, minItems: 1 },
          campaign_id: { type: 'string' },
        },
      };

      const validate = (args: Record<string, unknown>) =>
        validateAndRepairToolArgs({
          toolName: 'get_meta_ads_metrics',
          args,
          inputSchema: metaSchema,
          effect: 'read',
        });

      it('accepts a non-empty array campaign_ids (current shape)', () => {
        expect(validate({ campaign_ids: ['123'] }).status).toBe('valid');
      });

      it('accepts a legacy string campaign_ids', () => {
        // Was a type_mismatch before broadening the schema to a union type.
        expect(validate({ campaign_ids: '123' }).status).toBe('valid');
      });

      it('accepts a legacy scalar campaign_id', () => {
        // Was missing_required before dropping `required: [campaign_ids]`.
        expect(validate({ campaign_id: '123' }).status).toBe('valid');
      });

      it('normalizes a JSON-encoded campaign_ids array at the gateway boundary', () => {
        expect(validate({ campaign_ids: '["123","456"]' }).args).toEqual({
          campaign_ids: ['123', '456'],
        });
      });

      it('normalizes the legacy singular campaign_id at the gateway boundary', () => {
        expect(validate({ campaign_id: '789' }).args).toEqual({
          campaign_ids: ['789'],
        });
      });

      it('trims and de-duplicates campaign_ids at the gateway boundary', () => {
        expect(validate({ campaign_ids: [' 123 ', '123', '456'] }).args).toEqual({
          campaign_ids: ['123', '456'],
        });
      });

      it('preserves unknown keys and nullable optionals while normalizing the legacy id', () => {
        expect(validate({
          campaign_ids: null,
          campaign_id: '789',
          timeframe: null,
          account_id: null,
          future_option: true,
        }).args).toEqual({
          campaign_ids: ['789'],
          timeframe: null,
          account_id: null,
          future_option: true,
        });
      });

      it('preserves the legacy normalized-key alias repair contract', () => {
        const result = validate({ campaignIds: '789' });
        expect(result).toEqual(expect.objectContaining({
          status: 'repaired',
          args: { campaign_ids: ['789'] },
          repairs: ['campaignIds->campaign_ids'],
        }));
      });

      it('preserves malformed JSON as a bare campaign id', () => {
        expect(validate({ campaign_ids: '[123' }).args).toEqual({ campaign_ids: ['[123'] });
      });

      it('rejects a call with no campaign id at all', () => {
        const result = validate({ timeframe: '7d' });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: 'invalid_args', path: '$.campaign_ids' }),
            ]),
          );
          expect(result.modelMessage.toLowerCase()).toContain('campaign id');
        }
      });

      it('rejects an empty campaign_ids array', () => {
        const result = validate({ campaign_ids: [] });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues).toEqual([
            expect.objectContaining({ path: '$.campaign_ids', message: 'Argument "campaign_ids" must contain at least 1 item(s).' }),
            expect.objectContaining({ path: '$.campaign_ids', message: expect.stringContaining('Provide at least one campaign id') }),
          ]);
        }
      });

      it('preserves item-level errors and semantic issue ordering for numeric ids', () => {
        const result = validate({ campaign_ids: [123] });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.issues).toEqual([
            { code: 'type_mismatch', path: '$.campaign_ids[0]', message: 'Argument "campaign_ids[0]" has the wrong type. Expected string.' },
            expect.objectContaining({ code: 'invalid_args', path: '$.campaign_ids' }),
          ]);
          expect(result.modelMessage).toContain('Argument "campaign_ids[0]" has the wrong type. Expected string. Provide at least one campaign id');
        }
      });

      it('preserves repaired args and repairs when a normalized-key alias is invalid', () => {
        const result = validate({ campaignIds: [123] });
        expect(result).toEqual(expect.objectContaining({
          status: 'invalid',
          args: { campaign_ids: [123] },
          repairs: ['campaignIds->campaign_ids'],
        }));
      });
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

    async function failNTimes(
      runId: string,
      toolName: string,
      message: string,
      n: number,
      budgetScopeId?: string,
    ): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName,
          args: { attempt: i },
          runId,
          ...(budgetScopeId ? { budgetScopeId } : {}),
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

    it('trips after TWO identical NON-retryable failures (ENG-124 — retrying is known-pointless)', async () => {
      // 'Unauthorized: invalid api key' classifies as auth → fast-trip threshold 2.
      await failNTimes('run-nr', 'send_email', 'Unauthorized: invalid api key', 2);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'send_email',
        args: { to: 'x@example.com' },
        runId: 'run-nr',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        expect((outcome.error as Error).message).toContain('send_email');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('still allows a third attempt after two identical RETRYABLE failures (transient classes keep threshold 3)', async () => {
      // 'temporary network glitch, please retry' has no transient-class marker beyond
      // network → classifies as network → retryable → threshold stays 3.
      await failNTimes('run-r', 'you_search_web', 'network error, please retry', 2);

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'you_search_web',
        args: { query: 'retry me' },
        runId: 'run-r',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('resets the failure count when the tool succeeds', async () => {
      // Retryable-class message (timeout) so the fast-trip threshold does not
      // apply — this test pins reset-on-success, not the threshold.
      await failNTimes('run-b', 'linkedin_outreach', 'request timed out, please retry', 2);

      const success = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite' },
        runId: 'run-b',
        execute: () => Promise.resolve({ ok: true }),
      });
      expect(success.status).toBe('success');

      await failNTimes('run-b', 'linkedin_outreach', 'request timed out, please retry', 2);

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

    // ENG-167: a heavy content-generation tool (create_html_file / campaign-brief
    // generation) that keeps TIMING OUT surfaces a slightly different message each
    // attempt (a raw "connection timed out after Nms", an AbortError, a Bedrock
    // "ModelTimeoutException"). Keyed by exact error head, none reaches the per-key
    // threshold, so the model retried the same ~2-min tool until the whole run was
    // consumed and it could never reach any other tool. Timeouts are aggregated by
    // CLASS so N timeouts of one tool trip the breaker regardless of exact wording.
    it('trips the breaker after repeated TIMEOUTS of one tool even when each timeout message differs (ENG-167)', async () => {
      await failNTimes('run-timeout-spiral', 'create_html_file', 'connection timed out after 300000ms', 1);
      await failNTimes('run-timeout-spiral', 'create_html_file', 'The operation was aborted due to timeout', 1);
      await failNTimes('run-timeout-spiral', 'create_html_file', 'ModelTimeoutException: model invocation timed out', 1);

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief', content_draft: 'try again' },
        runId: 'run-timeout-spiral',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        const message = (outcome.error as Error).message;
        expect(message).toContain('create_html_file');
        expect(message.toLowerCase()).toContain('timed out');
        // The model must be told to stop AND given the escalation/report path.
        expect(message.toLowerCase()).toContain('report_product_issues');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('does not trip the timeout aggregate after only two differing timeouts (threshold is 3)', async () => {
      await failNTimes('run-timeout-two', 'create_html_file', 'connection timed out after 300000ms', 1);
      await failNTimes('run-timeout-two', 'create_html_file', 'The operation was aborted due to timeout', 1);

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief', content_draft: 'third attempt' },
        runId: 'run-timeout-two',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('does not let one tool\'s timeout spiral block a DIFFERENT lightweight tool (report_product_issues stays callable)', async () => {
      await failNTimes('run-timeout-iso', 'create_html_file', 'connection timed out after 300000ms', 1);
      await failNTimes('run-timeout-iso', 'create_html_file', 'The operation was aborted due to timeout', 1);
      await failNTimes('run-timeout-iso', 'create_html_file', 'ModelTimeoutException: model invocation timed out', 1);

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'report_product_issues',
        args: { title: 'Skill run keeps timing out' },
        runId: 'run-timeout-iso',
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    // ENG-167 follow-up: the run-scoped timeout aggregate above only ever sees ONE
    // run. Real-world sessions retry across separate runs — the user re-sends "try
    // again" as a new message, which mints a brand-new runId with a zeroed counter.
    // Verified against the actual production session (94253d20-712e...) that filed
    // ENG-167: create_html_file failed 6 times total across 4 separate ~10-minute
    // turns (1-2 per turn), never once reaching 3 within a single run, so the
    // run-scoped breaker above never tripped and the user hit the controller's hard
    // 10-minute wall-clock timeout on every single turn. Timeout-class failures must
    // also aggregate by session (budgetScopeId) across runs so a tool that's timing
    // out spiral-wide gets caught well before the per-run breaker ever could.
    it('trips the SESSION-scoped timeout aggregate across separate runs sharing a budgetScopeId (ENG-167 cross-turn retry)', async () => {
      const sessionScope = 'session-eng167-cross-turn';
      // Turn 1 and turn 2 each fail exactly once, in their OWN runs — mirrors two
      // separate user "try again" turns, each a brand-new runId.
      await failNTimes(
        'run-turn-1', 'create_html_file', 'connection timed out after 300000ms', 1, sessionScope,
      );
      await failNTimes(
        'run-turn-2', 'create_html_file', 'The operation was aborted due to timeout', 1, sessionScope,
      );

      // Third turn, third fresh runId, and — critically — this run has NOT called
      // create_html_file before. Session has now seen 2 timeout failures across
      // turns 1 and 2 only.
      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome3 = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-3',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome3.status).toBe('error');
      if (outcome3.status === 'error') {
        expect(outcome3.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        const message = (outcome3.error as Error).message;
        expect(message).toContain('create_html_file');
        expect(message.toLowerCase()).toContain('timed out');
        expect(message.toLowerCase()).toContain('report_product_issues');
        // Greptile ENG-167 follow-up: run-turn-3 never called create_html_file
        // before this attempt — the message must NOT claim the failures happened
        // "in this run" (factually wrong, contradicts the model's own tool-call
        // history) and must instead say they came from earlier turns/session.
        expect(message.toLowerCase()).not.toContain('in this run');
        expect(message.toLowerCase()).toContain('session');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('does not trip the session-scoped timeout aggregate after only ONE cross-run timeout (threshold is 2)', async () => {
      const sessionScope = 'session-eng167-single-timeout';
      const outcome1 = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-1',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('connection timed out after 300000ms')),
      });
      expect(outcome1.status).toBe('error');

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome2 = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-2',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome2.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a session-scoped timeout spiral for one tool does not block a DIFFERENT tool in a new run (report_product_issues stays callable)', async () => {
      const sessionScope = 'session-eng167-cross-turn-isolation';
      await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-1',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('connection timed out after 300000ms')),
      });
      await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-2',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('ModelTimeoutException: model invocation timed out')),
      });

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'report_product_issues',
        args: { title: 'Skill run keeps timing out' },
        runId: 'run-turn-3',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a session-scoped timeout success clears the aggregate so a later spiral starts fresh', async () => {
      const sessionScope = 'session-eng167-cross-turn-reset';
      await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-1',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('connection timed out after 300000ms')),
      });

      // A later turn succeeds — the session-scoped aggregate for this tool should clear.
      const successOutcome = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-2',
        budgetScopeId: sessionScope,
        execute: () => Promise.resolve({ success: true }),
      });
      expect(successOutcome.status).toBe('success');

      // A single new timeout afterward should NOT trip (aggregate was cleared, back to 1).
      const execute = jest.fn().mockResolvedValue({ success: true });
      await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-3',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('The operation was aborted due to timeout')),
      });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-4',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    // ENG-167 follow-up #2: verified against the actual production session's turn-4
    // event timeline (run mr1cvg71:4crc31) — the model correctly called
    // report_product_issues and it succeeded in 5.2s, but nothing told the model to
    // STOP there. It immediately retried create_html_file again in the SAME run,
    // which hung for 900s and got killed by the controller's 10-minute wall clock
    // before the model could ever tell the user the bug was already filed. Once a
    // run has successfully filed a report, a subsequent timeout trip in that SAME
    // run must say so explicitly — not repeat "offer to file a bug report" as if
    // nothing had been filed yet.
    it('tells the model NOT to file another report when report_product_issues already succeeded this run (ENG-167 follow-up)', async () => {
      const sessionScope = 'session-eng167-already-reported';
      // Two earlier turns/runs already push the session-scoped timeout aggregate to
      // threshold (mirrors turns 1 & 2 of the real session, both fully resolved
      // before the "report bug" turn started).
      await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-1',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('Stream timed out because of no activity for 300000 ms')),
      });
      await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-2',
        budgetScopeId: sessionScope,
        execute: () => Promise.reject(new Error('Stream timed out because of no activity for 300000 ms')),
      });

      // Turn 4's own run: report_product_issues succeeds first...
      const reportOutcome = await executeAgentToolThroughGateway({
        toolName: 'report_product_issues',
        args: { issues: [{ type: 'bug', title: 'Skill run keeps timing out' }] },
        runId: 'run-turn-4',
        budgetScopeId: sessionScope,
        execute: () => Promise.resolve({ success: true }),
      });
      expect(reportOutcome.status).toBe('success');

      // ...then the model retries create_html_file in the SAME run. The
      // session-scoped aggregate is already at threshold, so this trips instantly.
      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-turn-4',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        const message = (outcome.error as Error).message.toLowerCase();
        expect(message).toContain('already filed');
        expect(message).toContain('do not file another');
        // Must NOT repeat the generic "offer to file a bug report" suggestion —
        // that's what already happened once and confused the model into thinking
        // it still needed to do something with report_product_issues.
        expect(message).not.toContain('offer either to try');
        // Greptile ENG-167 follow-up: run-turn-4 never called create_html_file
        // before this attempt — the 2 counted failures came from turns 1 & 2.
        expect(message).not.toContain('in this run');
        expect(message).toContain('session');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('still offers to file a bug report when report_product_issues has NOT been called yet this run (unchanged behavior)', async () => {
      await failNTimes('run-timeout-no-report', 'create_html_file', 'connection timed out after 300000ms', 1);
      await failNTimes('run-timeout-no-report', 'create_html_file', 'The operation was aborted due to timeout', 1);
      await failNTimes('run-timeout-no-report', 'create_html_file', 'ModelTimeoutException: model invocation timed out', 1);

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'create_html_file',
        args: { title: 'Campaign Brief' },
        runId: 'run-timeout-no-report',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        const message = (outcome.error as Error).message.toLowerCase();
        expect(message).toContain('report_product_issues');
        expect(message).not.toContain('already filed');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-182: a per-recipient LinkedIn refusal does not block invites to other recipients', async () => {
      const runId = 'run-eng182';
      // Two DIFFERENT profiles each hit LinkedIn's terminal "Cannot resend yet"
      // (upstream_rejected → fast-trip threshold 2). Keyed on the error text alone
      // these two identical refusals would trip the breaker for the whole tool.
      for (const profile of [
        'https://www.linkedin.com/in/chang-liu/',
        'https://www.linkedin.com/in/liang-guo/',
      ]) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: { action: 'send-invite', profile_url: profile },
          runId,
          execute: failingExecute('Cannot resend yet'),
        });
        expect(outcome.status).toBe('error');
      }

      // A genuinely different recipient, never individually attempted, must still run.
      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: 'https://www.linkedin.com/in/mei-chen/' },
        runId,
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('ENG-182: still trips the breaker when the SAME LinkedIn recipient refuses repeatedly', async () => {
      const runId = 'run-eng182-same';
      const profile = 'https://www.linkedin.com/in/chang-liu/';
      for (let i = 0; i < 2; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: { action: 'send-invite', profile_url: profile },
          runId,
          execute: failingExecute('Cannot resend yet'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: profile },
        runId,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-182: collapses query/trailing-slash variants of one recipient into a single scope', async () => {
      const runId = 'run-eng182-norm';
      // Same profile, two URL shapes LinkedIn hands back (trailing slash + tracking query).
      for (const profile of [
        'https://www.linkedin.com/in/chang-liu/',
        'https://www.linkedin.com/in/chang-liu?miniProfileUrn=urn%3Ali%3Aabc',
      ]) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: { action: 'send-invite', profile_url: profile },
          runId,
          execute: failingExecute('Cannot resend yet'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: 'https://www.linkedin.com/in/chang-liu' },
        runId,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-182: a success for one recipient does NOT reset a pending breaker for another (per-recipient clear)', async () => {
      const runId = 'run-eng182-clear';
      const alice = 'https://www.linkedin.com/in/alice/';
      const bob = 'https://www.linkedin.com/in/bob/';

      // Alice refuses once — below the fast-trip threshold of 2 for "Cannot resend yet".
      const firstAlice = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: alice },
        runId,
        execute: failingExecute('Cannot resend yet'),
      });
      expect(firstAlice.status).toBe('error');

      // Bob succeeds. A tool-wide clear would wipe Alice's pending count here; the
      // per-recipient clear must leave it intact.
      const bobSuccess = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: bob },
        runId,
        execute: () => Promise.resolve({ success: true }),
      });
      expect(bobSuccess.status).toBe('success');

      // Alice refuses a second time — now at the original threshold (2), so she trips.
      const secondAlice = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: alice },
        runId,
        execute: failingExecute('Cannot resend yet'),
      });
      expect(secondAlice.status).toBe('error');

      // The next Alice call is blocked without executing — Bob's success did not
      // reset her counter. If the clear were tool-wide, this would run and succeed.
      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', profile_url: alice },
        runId,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-182: scopes the breaker per provider_id when no profile_url is present', async () => {
      const runId = 'run-eng182-provider';
      // Live send-invite calls often carry provider_id instead of profile_url.
      for (const providerId of ['ACoAA-alice', 'ACoAA-bob']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: { action: 'send-invite', provider_id: providerId },
          runId,
          execute: failingExecute('Cannot resend yet'),
        });
        expect(outcome.status).toBe('error');
      }

      // A third, distinct provider_id is not cross-blocked by the other two.
      const carol = jest.fn().mockResolvedValue({ success: true });
      const carolOutcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', provider_id: 'ACoAA-carol' },
        runId,
        execute: carol,
      });
      expect(carolOutcome.status).toBe('success');
      expect(carol).toHaveBeenCalledTimes(1);

      // A second refusal for the SAME provider_id reaches threshold 2 and trips it.
      const secondAlice = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', provider_id: 'ACoAA-alice' },
        runId,
        execute: failingExecute('Cannot resend yet'),
      });
      expect(secondAlice.status).toBe('error');

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'send-invite', provider_id: 'ACoAA-alice' },
        runId,
        execute,
      });
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-313: a corrected get-profile with a valid profile_url runs after two argument-less failures', async () => {
      const runId = 'run-eng313';
      // The model twice calls get-profile with only keywords (no profile_url /
      // provider_id), so it fails "Either profile_url or provider_id is required"
      // — an invalid_args class (fast-trip threshold 2) with an empty recipient
      // scope. Two of these must NOT block a later, corrected call that finally
      // carries a real profile_url — that is a materially different, now-valid
      // attempt, not a spiral.
      for (let i = 0; i < 2; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: { action: 'get-profile', keywords: 'nalin pradeep' },
          runId,
          execute: failingExecute('Either profile_url or provider_id is required for get-profile'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'get-profile', profile_url: 'https://www.linkedin.com/in/nalinpradeep/' },
        runId,
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('ENG-313: still trips when the SAME get-profile recipient fails repeatedly', async () => {
      const runId = 'run-eng313-same';
      const profile = 'https://www.linkedin.com/in/nalinpradeep/';
      for (let i = 0; i < 2; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'linkedin_outreach',
          args: { action: 'get-profile', profile_url: profile },
          runId,
          execute: failingExecute('Invalid parameters'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ success: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'linkedin_outreach',
        args: { action: 'get-profile', profile_url: profile },
        runId,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    // ENG-291: the Daily Satisfaction Score Report calls get_chat_history over a
    // 24h window with sync=true (on-the-fly score generation). That heavy request
    // timed out twice, tripping the SESSION-scoped timeout aggregate at threshold
    // 2 — which then hard-blocked EVERY subsequent get_chat_history in the session,
    // including the legitimate recovery paths (the same window with sync=false, and
    // a much smaller 6h window). The model was told "STOP retrying" and could never
    // discover that a cheaper request would have completed, so the report produced
    // zero output. Scope the breaker by request COST (sync flag + limit + window
    // duration) so a materially cheaper/smaller call lands in a different bucket and
    // is NOT blocked by an expensive call's timeouts — exactly like the ENG-182 /
    // ENG-313 per-recipient scoping above.
    const HISTORY_24H = { start_time: '2026-07-10T00:00:00Z', end_time: '2026-07-11T00:00:00Z' };
    const HISTORY_6H = { start_time: '2026-07-10T18:00:00Z', end_time: '2026-07-11T00:00:00Z' };

    it('ENG-291: does not block a sync=false get_chat_history after the sync=true request timed out twice', async () => {
      const sessionScope = 'session-eng291-daily-satisfaction';
      // Two identical heavy sync=true requests time out (turns 1 & 2 of the report).
      for (const runId of ['run-history-1', 'run-history-2']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { ...HISTORY_24H, limit: 1000, sync: true },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      // The legitimate recovery path — same window, but sync=false (cached scores
      // only) — is a cheaper request and must still execute.
      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { ...HISTORY_24H, limit: 1000, sync: false },
        runId: 'run-history-3',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('ENG-291: does not block a smaller-window get_chat_history after a larger window timed out twice', async () => {
      const sessionScope = 'session-eng291-smaller-window';
      // The larger 24h window (sync=false) times out twice.
      for (const runId of ['run-history-a', 'run-history-b']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { ...HISTORY_24H, limit: 1000, sync: false },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      // A materially smaller 6h window with a smaller limit is a legitimate reduced
      // request and must still execute.
      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { ...HISTORY_6H, limit: 200, sync: false },
        runId: 'run-history-c',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('ENG-291: still blocks an IDENTICAL get_chat_history request that keeps timing out', async () => {
      const sessionScope = 'session-eng291-identical';
      for (const runId of ['run-history-x', 'run-history-y']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { ...HISTORY_24H, limit: 1000, sync: true },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      // Same expensive request a third time — this should still be blocked so the
      // model stops thrashing on the identical call that keeps timing out.
      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { ...HISTORY_24H, limit: 1000, sync: true },
        runId: 'run-history-z',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        expect((outcome.error as Error).message).toContain('get_chat_history');
        expect((outcome.error as Error).message.toLowerCase()).toContain('timed out');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    // ENG-291 boundary coverage: chatHistoryFailureScope must degrade sanely on the
    // malformed / missing / oversized inputs a model actually sends, since the scope
    // string is what routes a failure into a bucket. These document the invalid-input
    // branches (non-object args, unparsable/missing timestamps, limit clamp/default).
    it('ENG-291: collapses missing/unparsable timestamps into one hours=0 bucket', async () => {
      const sessionScope = 'session-eng291-hours0';
      // Neither request carries a parseable window (malformed timestamps here, none at
      // all on the recovery), so chatHistoryFailureScope derives hours=0 for both and
      // they share sync=0|limit=500|hours=0. This documents that unparsable timestamps
      // re-create the shared-scope bug class the cost-scoping fix targets: after two
      // timeouts a differently-shaped-but-equally-windowless call is still hard-blocked.
      for (const runId of ['run-h0-a', 'run-h0-b']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { start_time: 'not-a-real-date', end_time: 'also-bad' },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { limit: 500 },
        runId: 'run-h0-c',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-291: clamps limit>1000 so over-large limits share one bucket', async () => {
      const sessionScope = 'session-eng291-limit-clamp';
      // limit 5000 and limit 1200 both clamp to 1000, so the same-window recovery is
      // treated as the same request and is blocked after the first times out twice.
      for (const runId of ['run-clamp-a', 'run-clamp-b']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { ...HISTORY_24H, limit: 5000, sync: false },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { ...HISTORY_24H, limit: 1200, sync: false },
        runId: 'run-clamp-c',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-291: defaults a missing limit to 500 so omitted and explicit-500 share one bucket', async () => {
      const sessionScope = 'session-eng291-limit-default';
      // Omitted limit defaults to 500; an explicit limit=500 recovery over the same
      // window lands in the same bucket and is blocked after two timeouts.
      for (const runId of ['run-default-a', 'run-default-b']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { ...HISTORY_24H, sync: false },
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { ...HISTORY_24H, limit: 500, sync: false },
        runId: 'run-default-c',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-291: treats non-object args as scope "" so array and string args share one bucket', async () => {
      const sessionScope = 'session-eng291-nonobject';
      // Non-object args (array, string) carry no cost signature, so the scope is ''
      // for all of them — they collapse to one shared bucket.
      for (const runId of ['run-nonobj-a', 'run-nonobj-b']) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: [],
          runId,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: 'not-an-object',
        runId: 'run-nonobj-c',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('ENG-291: caps total get_chat_history timeouts across varying cost buckets (aggregate session budget)', async () => {
      const sessionScope = 'session-eng291-aggregate';
      // A model that keeps VARYING the limit never accumulates two timeouts in any one
      // cost bucket, so the per-scope session timeout breaker (threshold 2) never trips.
      // Six single-timeout buckets still burn six ~10-minute turns; the coarse aggregate
      // budget (6) caps the session total so a seventh get_chat_history is blocked
      // regardless of its bucket — the session-wide protection cost-scoping removed.
      const limits = [100, 200, 300, 400, 600, 700];
      for (let i = 0; i < limits.length; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'get_chat_history',
          args: { ...HISTORY_24H, limit: limits[i], sync: false },
          runId: `run-agg-${i}`,
          budgetScopeId: sessionScope,
          execute: failingExecute('This operation was aborted'),
        });
        expect(outcome.status).toBe('error');
      }

      // A seventh call in a brand-new (smaller) bucket is still blocked by the coarse cap.
      const execute = jest.fn().mockResolvedValue({ sessions: [] });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'get_chat_history',
        args: { ...HISTORY_6H, limit: 50, sync: false },
        runId: 'run-agg-final',
        budgetScopeId: sessionScope,
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolBudgetExceededError);
        expect((outcome.error as Error).message).toContain('retry budget of 6');
        expect((outcome.error as Error).message).toContain('in this session');
      }
      expect(execute).not.toHaveBeenCalled();
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

    // ENG-101: structured failures ({ success:false } / { isError:true }) must
    // trip the SAME breaker as thrown errors. Tools like performDataAnalysis,
    // getMetaAdsMetrics, fathom_get_meetings, coding_agent resolve with a failure
    // payload instead of throwing; before the fix the gateway treated those as
    // success and even CLEARED prior thrown-error counts, so a tool returning
    // success:false could retry-spiral forever.
    it('trips the breaker when a tool repeatedly RESOLVES with success:false', async () => {
      for (let i = 0; i < 3; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'performDataAnalysis',
          args: { attempt: i },
          runId: 'run-struct',
          execute: () => Promise.resolve({ success: false, error: 'Query failed' }),
        });
        // Shape preserved: still status:'success' so the dispatcher can downgrade
        // and carry the structured payload to the model.
        expect(outcome.status).toBe('success');
      }

      const execute = jest.fn().mockResolvedValue({ success: false, error: 'Query failed' });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'performDataAnalysis',
        args: { attempt: 3 },
        runId: 'run-struct',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        expect((outcome.error as Error).message).toContain('performDataAnalysis');
        expect((outcome.error as Error).message).toContain('Query failed');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('does NOT clear prior thrown-error counts when a structured failure resolves', async () => {
      // Two thrown failures with the same message... ('Metric window mismatch' has no
      // semantic class → legacy 'Error' → default threshold 3, so the third call below
      // is not yet blocked and can demonstrate the no-clear accounting.)
      await failNTimes('run-mixed', 'getMetaAdsMetrics', 'Metric window mismatch', 2);
      // ...then a resolved structured failure carrying the SAME reason. Before the
      // fix this cleared the two thrown counts; now it adds a third on the same key.
      const resolved = await executeAgentToolThroughGateway({
        toolName: 'getMetaAdsMetrics',
        args: {},
        runId: 'run-mixed',
        execute: () => Promise.resolve({ success: false, error: 'Metric window mismatch' }),
      });
      expect(resolved.status).toBe('success');

      const execute = jest.fn().mockResolvedValue({ ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'getMetaAdsMetrics',
        args: {},
        runId: 'run-mixed',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('trips the breaker on repeated isError:true structured failures', async () => {
      for (let i = 0; i < 3; i += 1) {
        const outcome = await executeAgentToolThroughGateway({
          toolName: 'fathom_get_meetings',
          args: { attempt: i },
          runId: 'run-iserror',
          execute: () => Promise.resolve({ isError: true, message: 'boom' }),
        });
        expect(outcome.status).toBe('success');
      }

      const execute = jest.fn().mockResolvedValue({ isError: true, message: 'boom' });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'fathom_get_meetings',
        args: { attempt: 3 },
        runId: 'run-iserror',
        execute,
      });

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.error).toBeInstanceOf(AgentToolRepeatedFailureError);
        expect((outcome.error as Error).message).toContain('boom');
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('still clears the count on a genuine success after structured failures', async () => {
      // Two structured failures, then a genuine success (toolResultError -> null)
      // clears the count; two more failures must not yet trip on the next call.
      for (let i = 0; i < 2; i += 1) {
        await executeAgentToolThroughGateway({
          toolName: 'coding_agent',
          args: { attempt: i },
          runId: 'run-clear',
          execute: () => Promise.resolve({ success: false, error: 'compile error' }),
        });
      }
      const success = await executeAgentToolThroughGateway({
        toolName: 'coding_agent',
        args: {},
        runId: 'run-clear',
        execute: () => Promise.resolve({ success: true, ok: true }),
      });
      expect(success.status).toBe('success');

      for (let i = 0; i < 2; i += 1) {
        await executeAgentToolThroughGateway({
          toolName: 'coding_agent',
          args: { attempt: i },
          runId: 'run-clear',
          execute: () => Promise.resolve({ success: false, error: 'compile error' }),
        });
      }

      const execute = jest.fn().mockResolvedValue({ success: true, ok: true });
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'coding_agent',
        args: {},
        runId: 'run-clear',
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
