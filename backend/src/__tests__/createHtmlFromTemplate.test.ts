import { AgentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: {
    update: jest.fn()
  }
}));

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

// Mock crypto
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mock-hash')
  })),
  getRandomValues: jest.fn((arr) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }),
  // Pipeline defect fix (pre-existing, unrelated to ENG-2103 F2): this
  // whole-module crypto mock predates controllers/agentModeController.ts's
  // scheduled-run lease work, whose module-scope `require('uuid').v4()`
  // (SCHEDULED_RUN_INSTANCE_ID) now sits on this test's own
  // agentModeService.ts import chain. `uuid`'s rng.js calls
  // `crypto.randomFillSync` directly — missing from this mock, it threw
  // `TypeError: (0, crypto_1.randomFillSync) is not a function` and failed
  // this entire suite to load, on `origin/main`, independent of this round's
  // changes (confirmed via `git stash`). A deterministic passthrough is
  // sufficient: nothing in this suite asserts on the generated UUID's value.
  randomFillSync: jest.fn((buf) => buf)
}));

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

// Mock s3Utils
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/test-template.html'
  })
}));



describe('AgentModeService - createHtmlFromTemplate', () => {
  let agentModeService: AgentModeService;
  let mockS3: any;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Setup S3 mock
    const AWS = require('aws-sdk');
    mockS3 = new AWS.S3();

    // Setup crypto mock
    const { createHash } = require('crypto');
    const mockHash = {
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('test-hash-123')
    };
    createHash.mockReturnValue(mockHash);

    // Create service instance
    agentModeService = new AgentModeService();
  });

  describe('createHtmlFromTemplate', () => {
    const mockTemplate = {
      template_id: 'test-template-id',
      template_name: 'test-template',
      html_content: '<html><body><h1>{{title}}</h1><p>{{content}}</p></body></html>',
      subject: 'Test Subject: {{title}}',
      variables: ['title', 'content'],
      arrayVariables: []
    };

    beforeEach(() => {
      // Mock the settingsService to return the template
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([mockTemplate])
      });

      // Mock callLLM to return a successful response
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Test Title</h1><p>Test Content</p></body></html>',
              final_subject: 'Test Subject: Test Title'
            })
          }
        }]
      });

      // Mock S3 upload
      mockS3.upload().promise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/bucket/test-template.html'
      });
    });

    it('should create HTML from template with valid parameters', async () => {

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/test-template.html');
      expect(result.final_subject).toBe('Test Subject: Test Title');
      expect(agentModeService.callLLM).toHaveBeenCalledWith(
        agentModeService.default_model,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('You are a template engine')
          })
        ]),
        expect.objectContaining({
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      );

    });

    it('should handle array variables correctly', async () => {
      const templateWithArrays = {
        ...mockTemplate,
        arrayVariables: ['items'],
        html_content: '<html><body><ul>{{#items}}<li>{{item}}</li>{{/items}}</ul></body></html>'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { items: [{ item: 'Item 1' }, { item: 'Item 2' }] },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(agentModeService.callLLM).toHaveBeenCalled();

      // ENG-1877 regression guard: an earlier version of the escaping fix ran every
      // value through String(value), which collapses an object array item to the
      // literal text "[object Object]" instead of preserving its real fields — a
      // silent full data-loss regression a bare success-flag check would not catch.
      const [, messages] = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      const promptContent = messages[0].content;
      expect(promptContent).not.toContain('[object Object]');
      expect(promptContent).toContain('Item 1');
      expect(promptContent).toContain('Item 2');
    });

    // ENG-1877 follow-up (round 2 review): escaping must preserve structure (objects,
    // arrays, null) while still escaping every STRING leaf, however deeply nested —
    // not flatten everything through String(value).
    it('should escape string leaves nested inside object array items without losing structure', async () => {
      const templateWithArrays = {
        ...mockTemplate,
        arrayVariables: ['items'],
        html_content: '<html><body><ul>{{#items}}<li>{{item}}</li>{{/items}}</ul></body></html>'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { items: [{ item: '<script>alert(1)</script>' }, { item: 'Safe Item', note: null }] },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const [, messages] = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      const promptContent = messages[0].content;

      expect(promptContent).not.toContain('[object Object]');
      expect(promptContent).not.toContain('<script>alert(1)</script>');
      expect(promptContent).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(promptContent).toContain('Safe Item');
      // null is a real JSON value, not the literal text "null" a String(value) coercion
      // would have produced.
      expect(promptContent).toContain('"note": null');
      expect(promptContent).not.toContain('"note": "null"');
    });

    // ENG-1877: variable values (campaign names, CRM data) are not trusted HTML, but the
    // LLM is instructed to copy them through verbatim — so an unescaped value reaches the
    // rendered report unchanged. Asserts on the actual PROMPT sent to callLLM, since that's
    // where escaping has to happen (post-hoc sanitizing the LLM's output can't tell a
    // value's markup apart from the template's own static markup).
    it('should HTML-escape scalar variable values before building the substitution prompt', async () => {
      const maliciousTitle = '<script>alert(1)</script> & "Sale" <b>Bold</b>';

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: maliciousTitle, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const [, messages] = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      const promptContent = messages[0].content;

      expect(promptContent).not.toContain('<script>alert(1)</script>');
      expect(promptContent).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(promptContent).toContain('&amp;');
      expect(promptContent).toContain('&quot;Sale&quot;');
      expect(promptContent).toContain('&lt;b&gt;Bold&lt;/b&gt;');
    });

    it('ENG-1960: logs markup-like variable paths without mutating the values', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // This test exercises an array_variable_values entry ('items'), so the
        // template mock must declare it in arrayVariables — otherwise the
        // pre-existing "Extra array variables provided" validation rejects the
        // call before it ever reaches the ENG-1960 detection code below.
        const templateWithItems = {
          ...mockTemplate,
          arrayVariables: ['items'],
          html_content: '<html><body><h1>{{title}}</h1><p>{{content}}</p><ul>{{#items}}<li>{{item}}</li>{{/items}}</ul></body></html>',
        };
        (settingsService.getSetting as jest.Mock).mockResolvedValue({
          settingValue: JSON.stringify([templateWithItems]),
        });

        await (agentModeService as any).createHtmlFromTemplate(
          agentModeService.default_model,
          'test-template-id',
          {
            title: 'Quarterly report',
            content: '<ul><li><strong>Revenue</strong></li></ul>',
          },
          {
            items: [{ item: '- first point\n- second point' }],
          },
          'user123',
          'session123'
        );

        const markupWarning = warnSpy.mock.calls.find(
          ([message]) => message === '[ENG-1960] create_html_from_template received markup-like variable values'
        );
        expect(markupWarning).toBeDefined();
        expect(markupWarning?.[1]).toEqual({
          count: 2,
          paths: ['variable_values.content', 'array_variable_values.items[0].<field>'],
          paths_truncated: false,
        });

        // Detection is observability only. Existing escaping/substitution owns behavior.
        const [, messages] = (agentModeService.callLLM as jest.Mock).mock.calls[0];
        expect(messages[0].content).toContain('&lt;ul&gt;&lt;li&gt;&lt;strong&gt;Revenue&lt;/strong&gt;&lt;/li&gt;&lt;/ul&gt;');
        expect(messages[0].content).toContain('- first point\\n- second point');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('ENG-1960: detects common Markdown forms, redacts nested keys, and caps logged paths', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const templateWithItems = {
          ...mockTemplate,
          arrayVariables: ['items'],
          html_content: '<html><body><ul>{{#items}}<li>{{item}}</li>{{/items}}</ul></body></html>',
        };
        (settingsService.getSetting as jest.Mock).mockResolvedValue({
          settingValue: JSON.stringify([templateWithItems]),
        });
        const items = Array.from({ length: 25 }, (_, index) => ({
          [`customer_secret_${index}`]:
            index % 3 === 0 ? '*emphasis*' : index % 3 === 1 ? '`inline code`' : '> quoted text',
        }));

        await (agentModeService as any).createHtmlFromTemplate(
          agentModeService.default_model,
          'test-template-id',
          { title: 'Quarterly report', content: 'Plain text' },
          { items },
          'user123',
          'session123'
        );

        const markupWarning = warnSpy.mock.calls.find(
          ([message]) => message === '[ENG-1960] create_html_from_template received markup-like variable values'
        );
        expect(markupWarning).toBeDefined();
        expect(markupWarning?.[1].count).toBe(25);
        expect(markupWarning?.[1].paths).toHaveLength(20);
        expect(markupWarning?.[1].paths_truncated).toBe(true);
        expect(markupWarning?.[1].paths.every((p: string) => p.includes('.<field>'))).toBe(true);
        expect(JSON.stringify(markupWarning?.[1])).not.toContain('customer_secret_');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('ENG-1960: detects quoted underscore emphasis without treating identifiers as Markdown', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await (agentModeService as any).createHtmlFromTemplate(
          agentModeService.default_model,
          'test-template-id',
          { title: '"_urgent_"', content: 'north_america_east' },
          {},
          'user123',
          'session123'
        );

        const markupWarning = warnSpy.mock.calls.find(
          ([message]) => message === '[ENG-1960] create_html_from_template received markup-like variable values'
        );
        expect(markupWarning?.[1]).toMatchObject({
          count: 1,
          paths: ['variable_values.title'],
          paths_truncated: false,
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('ENG-1960: does not flag ordinary punctuation such as a lone asterisk in a name', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await (agentModeService as any).createHtmlFromTemplate(
          agentModeService.default_model,
          'test-template-id',
          { title: 'A* Star', content: "Vince's ad — north_america_east" },
          {},
          'user123',
          'session123'
        );

        expect(
          warnSpy.mock.calls.some(
            ([message]) => message === '[ENG-1960] create_html_from_template received markup-like variable values'
          )
        ).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    // A single-quoted HTML attribute (e.g. <img src='{{url}}'>) is valid HTML the template
    // author could write, and nothing forbids it. Escaping only &, <, >, " (not ') leaves this
    // vector wide open: a value of `' onerror='alert(1)` breaks out of the attribute without
    // ever containing any of the 4 escaped characters, so the earlier assertions above (which
    // only test double-quote/no-quote contexts) would not have caught this gap.
    it('should HTML-escape single quotes, closing the single-quoted-attribute breakout vector', async () => {
      const breakoutValue = "' onerror='alert(1)";

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: breakoutValue, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const [, messages] = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      const promptContent = messages[0].content;

      expect(promptContent).not.toContain("' onerror='alert(1)");
      expect(promptContent).toContain('&#39; onerror=&#39;alert(1)');
    });

    // Escaping the PROMPT only proves the request was safe — it says nothing about
    // whether the LLM actually reproduced the escaped form rather than "cleaning up"
    // what looked like a stray HTML entity. This simulates exactly that failure: the
    // model is asked to escape but the mocked response leaks the raw value anyway.
    // Auto-CORRECTS rather than rejecting outright — this function is shared by ~35
    // other real templates never tested against this change, and a reject-on-detect
    // design would turn any of their models' occasional imperfect escaping into a
    // customer-visible outage unrelated to security. See round-3 review discussion.
    it('should auto-correct a raw, unescaped value the LLM reproduced in its output', async () => {
      const maliciousTitle = '<script>alert(1)</script>';

      (agentModeService.callLLM as jest.Mock).mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              // Simulates a misbehaving model that decoded the escaped entity back
              // to raw HTML instead of reproducing it as sent.
              final_html: `<html><body><h1>${maliciousTitle}</h1><p>Test Content</p></body></html>`,
              final_subject: 'Test Subject: has a title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: maliciousTitle, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const { uploadFileToS3 } = require('../utils/s3Utils');
      const uploadedHtml = (uploadFileToS3 as jest.Mock).mock.calls[0][0];
      expect(uploadedHtml).not.toContain('<script>alert(1)</script>');
      expect(uploadedHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    // Round-3 review finding: an exact, case-sensitive match let a model evade the
    // output-verification check via trivial reformatting — `<SCRIPT>` is just as
    // browser-executable as `<script>`, so a case-sensitive check missing it entirely
    // would defeat the correction for zero real difficulty on the model's part.
    it('should auto-correct even if the LLM reproduces the raw value with different casing', async () => {
      const maliciousTitle = '<script>alert(1)</script>';

      (agentModeService.callLLM as jest.Mock).mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1><SCRIPT>alert(1)</SCRIPT></h1><p>Test Content</p></body></html>',
              final_subject: 'Test Subject: has a title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: maliciousTitle, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const { uploadFileToS3 } = require('../utils/s3Utils');
      const uploadedHtml = (uploadFileToS3 as jest.Mock).mock.calls[0][0];
      expect(uploadedHtml.toLowerCase()).not.toContain('<script>alert(1)</script>');
      expect(uploadedHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    // Round-4 review finding: `subject` (docs/html-templates.md) is a real email subject
    // line, never HTML-rendered — escaping it doesn't protect anything, it just shows
    // literal "&amp;"/"&#39;" text in a real customer's inbox. The subject must come back
    // as plain, decoded text even when the LLM faithfully echoes the escaped values it
    // was given.
    it('should decode HTML entities in final_subject — it is plain text, never rendered', async () => {
      const clientName = 'O\'Brien & Sons "Premium"';

      (agentModeService.callLLM as jest.Mock).mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Report</h1></body></html>',
              // Simulates the LLM faithfully copying the escaped value into the subject,
              // exactly as it's instructed to do for the HTML body.
              final_subject: 'Report for O&#39;Brien &amp; Sons &quot;Premium&quot;'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: clientName, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.final_subject).toBe('Report for O\'Brien & Sons "Premium"');
      expect(result.final_subject).not.toContain('&amp;');
      expect(result.final_subject).not.toContain('&#39;');
      expect(result.final_subject).not.toContain('&quot;');
    });

    // Round-4 review finding, verified by direct execution in the review itself: passing
    // the escaped value as a plain string (not a function) to String.replace lets a `$`
    // adjacent to certain characters trigger JS's special replacement-pattern syntax
    // (e.g. `$&` re-inserts the matched text), silently RE-introducing the raw value the
    // correction was supposed to remove — the "fix" reopening the exact injection it exists
    // to close.
    it('should not reinject raw content via $-pattern replacement-string interpretation', async () => {
      const maliciousTitle = '<b>Price$&Info</b>';

      (agentModeService.callLLM as jest.Mock).mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: `<html><body><h1>${maliciousTitle}</h1></body></html>`,
              final_subject: 'Test Subject: has a title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: maliciousTitle, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const { uploadFileToS3 } = require('../utils/s3Utils');
      const uploadedHtml = (uploadFileToS3 as jest.Mock).mock.calls[0][0];
      expect(uploadedHtml).not.toContain('<b>Price');
      expect(uploadedHtml).not.toContain('</b>');
      expect(uploadedHtml).toContain('&lt;b&gt;Price$&amp;Info&lt;/b&gt;');
    });

    // Round-4 review finding, verified by direct execution: when one flagged raw value is
    // a literal substring of another (plausible with real HTML-snippet-shaped data),
    // correcting the shorter one first destroys the exact string the longer one's pattern
    // needs to match, silently no-oping the longer one's own correction.
    it('should correct both values when one raw value is a substring of another', async () => {
      const shortValue = '<b>Alpha</b>';
      const longValue = '<div><b>Alpha</b></div>';

      (agentModeService.callLLM as jest.Mock).mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              // The model leaked both raw forms — the short one standalone (title) and
              // the long one containing it (content).
              final_html: `<html><body><h1>${shortValue}</h1><p>${longValue}</p></body></html>`,
              final_subject: 'Test Subject: has a title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: shortValue, content: longValue },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const { uploadFileToS3 } = require('../utils/s3Utils');
      const uploadedHtml = (uploadFileToS3 as jest.Mock).mock.calls[0][0];
      expect(uploadedHtml).not.toContain('<b>Alpha</b>');
      expect(uploadedHtml).not.toContain('<div>');
      expect(uploadedHtml).toContain('&lt;b&gt;Alpha&lt;/b&gt;');
      expect(uploadedHtml).toContain('&lt;div&gt;&lt;b&gt;Alpha&lt;/b&gt;&lt;/div&gt;');
    });

    // Round-3 review finding: including '/&/" in the output-verification check made an
    // ordinary apostrophe in a real name ("O'Brien's Q3") a false-positive trigger if that
    // short substring coincidentally reappeared anywhere else in the LLM's output — failing
    // a legitimate report for no real security benefit, since an apostrophe alone (without
    // a `<`/`>`) cannot construct a new HTML element regardless of where it lands.
    it('should NOT fail closed on an ordinary apostrophe reappearing elsewhere in the output', async () => {
      const clientName = "O'Brien's Q3";

      (agentModeService.callLLM as jest.Mock).mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              // The client name legitimately appears twice — once as the real
              // substitution, once incidentally repeated by the model elsewhere.
              final_html: `<html><body><h1>${clientName}</h1><p>Report for ${clientName}</p></body></html>`,
              final_subject: `Report: ${clientName}`
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: clientName, content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
    });

    it('should HTML-escape array variable values before building the substitution prompt', async () => {
      const templateWithArrays = {
        ...mockTemplate,
        arrayVariables: ['items'],
        html_content: '<html><body><ul>{{#items}}<li>{{item}}</li>{{/items}}</ul></body></html>'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArrays])
      });

      const maliciousItem = '<img src=x onerror=alert(1)>';

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { items: [maliciousItem] },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      const [, messages] = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      const promptContent = messages[0].content;

      expect(promptContent).not.toContain('<img src=x onerror=alert(1)>');
      expect(promptContent).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('should validate that all required variables are provided', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title' }, // Missing 'content'
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required variables');
      expect(result.message).toContain('content');
    });

    it('should validate that no extra variables are provided', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content', extra: 'Extra' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Extra variables provided');
      expect(result.message).toContain('extra');
    });

    it('should validate array variables are arrays', async () => {
      const templateWithArrays = {
        ...mockTemplate,
        arrayVariables: ['items']
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { items: 'not-an-array' }, // Should be array
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Array variable items must be an array');
    });

    it('should handle template not found', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([]) // Empty templates array
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'nonexistent-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Template \'nonexistent-template-id\' not found');
    });

    it('ENG-1888: not_found names the missing id and lists available templates', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{ template_id: 'real-tpl', template_name: 'Real', html_content: '<p/>', subject: 's' }])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model, 'nonexistent-template-id', {}, {}, 'user123', 'session123'
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('TEMPLATE_NOT_FOUND');
      expect(result.missing_template_id).toBe('nonexistent-template-id');
      expect(result.available_templates).toEqual(expect.arrayContaining([{ template_id: 'real-tpl', template_name: 'Real' }]));
      expect(result.message).toContain('list_html_templates');
    });

    it('should handle LLM API errors', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('OpenAI API error'));

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to process template with LLM');
    });

    it('should handle invalid LLM response', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [
          {
            message: {
              content: 'invalid-json-response'
            }
          }
        ]
      });


      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse LLM response');
    });

    it('should handle JSON wrapped in markdown code block (```json)', async () => {
      const wrappedJson = '```json\n' + JSON.stringify({
        final_html: '<html><body><h1>Test Title</h1><p>Test Content</p></body></html>',
        final_subject: 'Test Subject: Test Title'
      }) + '\n```';

      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: wrappedJson
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/test-template.html');
      expect(result.final_subject).toBe('Test Subject: Test Title');
    });

    it('should handle JSON wrapped in plain markdown code block (```)', async () => {
      const wrappedJson = '```\n' + JSON.stringify({
        final_html: '<html><body><h1>Test Title</h1><p>Test Content</p></body></html>',
        final_subject: 'Test Subject: Test Title'
      }) + '\n```';

      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: wrappedJson
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/test-template.html');
    });

    it('should fail when code block contains invalid JSON', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: '```json\nnot valid json here\n```'
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse LLM response');
    });

    it('classifies empty LLM substitution output as invalid_output', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{ message: { content: '' } }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.errorClass).toBe('invalid_output');
      expect(result.error).toContain('LLM did not return substitution result');
    });

    it('should handle missing final_html in LLM response', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_subject: 'Test Subject: Test Title'
              // Missing final_html
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('LLM response missing final_html');
    });

    it('should handle S3 upload errors', async () => {
      const { uploadFileToS3 } = require('../utils/s3Utils');
      uploadFileToS3.mockResolvedValueOnce({
        success: false,
        error: 'S3 upload failed'
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to upload to S3');
    });

    it('should include proper metadata in S3 upload', async () => {
      const { uploadFileToS3 } = require('../utils/s3Utils');

      await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(uploadFileToS3).toHaveBeenCalledWith(
        expect.any(String), // finalHtml
        expect.stringMatching(/^html_.*\.html$/), // filename
        'user123', // userId
        'text/html' // contentType
      );
    });

    it('should handle undefined variable_values and array_variable_values', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        undefined,
        undefined,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required variables');
    });

    it('should validate template structure', async () => {
      const invalidTemplate = {
        template_id: 'test-template-id',
        template_name: 'test-template',
        // Missing required fields
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([invalidTemplate])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid template structure');
      // ENG-1888: config-class, actionable
      expect(result.errorClass).toBe('not_found');
      expect(result.error_code).toBe('TEMPLATE_INVALID');
      expect(result.message).toContain('list_html_templates');
    });

    it('should handle complex array variables', async () => {
      const templateWithComplexArrays = {
        ...mockTemplate,
        arrayVariables: ['items', 'categories'],
        html_content: '<html><body><ul>{{#items}}<li>{{name}} - {{price}}</li>{{/items}}</ul><div>{{#categories}}<span>{{cat}}</span>{{/categories}}</div></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithComplexArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {
          items: [{ name: 'Item 1', price: '$10' }, { name: 'Item 2', price: '$20' }],
          categories: [{ cat: 'Electronics' }, { cat: 'Books' }]
        },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(agentModeService.callLLM).toHaveBeenCalled();
    });

    it('should handle empty array variables and prompt for placeholder text', async () => {
      const templateWithEmptyArray = {
        ...mockTemplate,
        arrayVariables: ['features_n'],
        html_content: '<html><body><h1>{{title}}</h1><ul class="features-list">{{#features_n}}<li>{{features_1}}</li>{{/features_n}}</ul><p>{{content}}</p></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithEmptyArray])
      });

      // Mock LLM response with placeholder for empty array
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Test Title</h1><ul class="features-list"><li style="color: #888; font-style: italic;">No data available</li></ul><p>Test Content</p></body></html>',
              final_subject: 'Test Subject: Test Title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { features_n: [] }, // Empty array
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);

      // Verify the prompt includes empty array handling instructions
      const callArgs = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      expect(callArgs[1][0].content).toContain('EMPTY ARRAY VARIABLES');
      expect(callArgs[1][0].content).toContain('remove the array variables from the HTML structure');

      // Verify the array variable values are passed as empty
      expect(callArgs[1][0].content).toContain('"features_n": []');
    });

    it('should handle partial empty array variables', async () => {
      const templateWithMixedArrays = {
        ...mockTemplate,
        arrayVariables: ['features_n', 'links_n'],
        html_content: '<html><body><h1>{{title}}</h1><ul class="features">{{#features_n}}<li>{{features_1}}</li>{{/features_n}}</ul><ul class="links">{{#links_n}}<li>{{links_1}}</li>{{/links_n}}</ul></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithMixedArrays])
      });

      // Mock LLM response with one empty array handled
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Test Title</h1><ul class="features"><li>Feature 1</li><li>Feature 2</li></ul><ul class="links"><li style="color: #888;">None</li></ul></body></html>',
              final_subject: 'Test Subject: Test Title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {
          features_n: ['Feature 1', 'Feature 2'],
          links_n: [] // Empty array
        },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);

      // Verify the prompt includes both populated and empty arrays
      const callArgs = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      expect(callArgs[1][0].content).toContain('"features_n"');
      expect(callArgs[1][0].content).toContain('"links_n": []');
    });

    it('should require array variables even if empty', async () => {
      const templateWithArray = {
        ...mockTemplate,
        arrayVariables: ['features_n'],
        html_content: '<html><body><h1>{{title}}</h1><ul class="features">{{#features_n}}<li>{{features_1}}</li>{{/features_n}}</ul><p>{{content}}</p></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArray])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {}, // Missing array variable entirely
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required array variables');
      expect(result.message).toContain('features_n');
      // ENG-1888: argument mismatch, never a tool bug
      expect(result.errorClass).toBe('invalid_args');
    });

    // ENG-46 sibling path: this method is reached with the SESSION's model, so a
    // stale/removed id (e.g. gpt-5.1) must fall back to a served model rather than
    // throwing an opaque "Invalid model" inside callLLM.
    it('falls back to a served model when the session pins a retired model id', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        'gpt-5.1', // retired id — no longer in the allow-list
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      // The substitution still completes instead of failing.
      expect(result.success).toBe(true);
      // callLLM was invoked with the fallback default — never the retired id.
      const callLLMSpy = agentModeService.callLLM as jest.Mock;
      expect(callLLMSpy).toHaveBeenCalled();
      for (const call of callLLMSpy.mock.calls) {
        expect(call[0]).not.toBe('gpt-5.1');
      }
      expect(callLLMSpy.mock.calls[0][0]).toBe(agentModeService.default_model);
    });
  });
});
