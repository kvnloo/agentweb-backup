import { classifyToolFailureType, FAILURE_TYPES } from '../utils/toolFailureType';

/**
 * Decision-layer classification for agent tool failures. Sits on top of the
 * technical errorClass taxonomy (classifyToolErrorClass) and answers "what kind
 * of action does this failure need" so retire/keep decisions and the weekly
 * scorecard run off failure TYPE, not raw failure rate (per dev.md 2026-06-13).
 *
 * Strings below are real error messages sampled from Dev-AW-LoopEvents.
 */
describe('classifyToolFailureType', () => {
  it('exposes the five canonical types', () => {
    expect([...FAILURE_TYPES].sort()).toEqual(
      ['bug', 'by_design', 'config', 'model_uninstalled_tool', 'schema_reject'].sort(),
    );
  });

  describe('model_uninstalled_tool — model called a tool the user does not have', () => {
    it('classifies "not available / install the required skill"', () => {
      expect(
        classifyToolFailureType('Error', 'Tool "search_tool_response" is not available. You must install the required skill first'),
      ).toBe('model_uninstalled_tool');
    });
    it('takes precedence over the "required" keyword (not a schema reject)', () => {
      // message contains "required" but is an uninstalled-tool error, not arg validation
      expect(
        classifyToolFailureType('Error', 'Tool "wait_seconds" is not available. You must install the required skill first'),
      ).toBe('model_uninstalled_tool');
    });
  });

  describe('by_design — validator/policy correctly rejected the request', () => {
    it('classifies a policy_blocked errorClass', () => {
      expect(classifyToolFailureType('policy_blocked', 'blocked by gateway policy')).toBe('by_design');
    });
    it('classifies run_local_agent_task scope rejection (historical events)', () => {
      expect(
        classifyToolFailureType('Error', 'Task rejected: local agent may only be used for web browsing and data extraction'),
      ).toBe('by_design');
    });
    // ENG-1844: the brand-logo gate correctly refusing to generate an invented-logo
    // page is the tool working as designed, not a bug — must not inflate the 'bug'
    // reliability count for a defect-free gate.
    it('classifies missing_brand_logo errorClass', () => {
      expect(
        classifyToolFailureType('missing_brand_logo', 'API error (422): No brand logo is saved in Brand Guidelines.'),
      ).toBe('by_design');
    });
    it('classifies the local agent deprecation stub error (ENG-383) — retired-by-design, not a bug', () => {
      expect(
        classifyToolFailureType(
          'Error',
          'local_agent_deprecated: The local agent relay was retired in July 2026. For web research use you_search_web / you_search_news; other local-agent workloads are being replaced (see ENG-381).',
        ),
      ).toBe('by_design');
    });
    it('classifies the LinkedIn anti-spam invitation delay', () => {
      expect(classifyToolFailureType('Error', 'Should delay new invitation to this recipient')).toBe('by_design');
    });
    it('classifies a sequencing guard, NOT as schema_reject despite "required"', () => {
      expect(
        classifyToolFailureType('Error', 'Cannot mark steps as completed. Required function calls have not been made yet'),
      ).toBe('by_design');
    });
  });

  describe('schema_reject — arguments failed validation before execution', () => {
    it('classifies an invalid_args errorClass', () => {
      expect(
        classifyToolFailureType('invalid_args', 'Tool "read_tool_response" arguments failed schema validation before execution.'),
      ).toBe('schema_reject');
    });
    it('classifies "Both s3_key and query are required"', () => {
      expect(classifyToolFailureType('Error', 'Both s3_key and query are required')).toBe('schema_reject');
    });
    it('classifies a single missing required arg', () => {
      expect(classifyToolFailureType('Error', 's3_key is required')).toBe('schema_reject');
    });
  });

  describe('config — environment/credentials/quota, fixable without touching tool logic', () => {
    it('classifies rate_limit / 429', () => {
      expect(classifyToolFailureType('rate_limit', '429 Too Many Requests')).toBe('config');
    });
    it('classifies a provider 429 from the MESSAGE even when errorClass is the unhelpful "Error" (old events)', () => {
      // pre-classifier events recorded errorClass:'Error' on every failure, so
      // the message must carry the rate-limit signal on its own.
      expect(
        classifyToolFailureType('Error', 'Error: 429 Too Many Requests\n{"type":"ErrorResponse"}'),
      ).toBe('config');
    });
    it('classifies an auth errorClass', () => {
      expect(classifyToolFailureType('auth', 'Unauthorized')).toBe('config');
    });
    it('classifies a not_found errorClass (missing resource)', () => {
      expect(classifyToolFailureType('not_found', 'Request failed with status code 404')).toBe('config');
    });
    it('classifies a missing S3 bucket', () => {
      expect(classifyToolFailureType('Error', 'The specified bucket does not exist')).toBe('config');
    });
    it('classifies the Slack bot not being in the channel', () => {
      expect(classifyToolFailureType('Error', 'The Slack bot is not a member of channel C09JU')).toBe('config');
    });
    // ENG-2819: update_email_draft_for_lead's no-contact-channel skip (ENG-2082) and
    // do-not-contact refusal are deliberate guards, not handler bugs.
    it('classifies the email-draft no-contact-channel skip as by_design (ENG-2819)', () => {
      expect(
        classifyToolFailureType('Error', 'This lead has neither an email address nor a LinkedIn profile — there is nothing to draft.'),
      ).toBe('by_design');
    });

    it('classifies the email-draft do-not-contact refusal as by_design (ENG-2819)', () => {
      expect(
        classifyToolFailureType('Error', 'Cannot draft email for this lead: Unsubscribed. Remove the do-not-contact flag first if you want to contact them.'),
      ).toBe('by_design');
    });

    it('classifies the read_google_doc non-Google URL refusal as by_design (ENG-2907)', () => {
      expect(
        classifyToolFailureType('Error', 'Not a Google Docs/Sheets/Drive URL (luma.com): read_google_doc only reads Google files. Use a web page fetch tool for other URLs.'),
      ).toBe('by_design');
    });

    it('classifies the landing-page share non-member refusal as by_design (ENG-2585)', () => {
      expect(
        classifyToolFailureType('Error', "API error (400): 'x@y.com' is not a member of the page owner's organization"),
      ).toBe('by_design');
    });
    it('classifies a Google Ads serving_chain state report as by_design (ENG-2611)', () => {
      expect(classifyToolFailureType('Error', '{"customerId":"4149815605","state":"UNVERIFIED","campaigns":[]}')).toBe('by_design');
      expect(classifyToolFailureType('Error', '{"customerId":"1","state":"BLOCKED_BY_POLICY","blockers":[]}')).toBe('by_design');
      expect(classifyToolFailureType('Error', '{"customerId":"1","state":"DELIVERY_FAILED"}')).toBe('bug');
    });
    it('classifies the LinkedIn identity-mismatch send refusal as by_design (ENG-2619)', () => {
      const msg =
        'Refused to send: the LinkedIn profile at https://www.linkedin.com/in/someone does not appear to belong to this lead (Jane Doe, Acme). Profile company differs. Verify or correct the lead\'s LinkedIn URL before contacting them.';
      expect(classifyToolFailureType('Error', msg)).toBe('by_design');
      expect(classifyToolFailureType('not_found', msg)).toBe('by_design');
      expect(classifyToolFailureType('', msg)).toBe('by_design');
      expect(classifyToolFailureType('not_found', 'Lead not found')).toBe('config');
    });
    it('classifies a landing-page authorization gap', () => {
      expect(classifyToolFailureType('Error', 'Not authorized to edit this landing page.')).toBe('config');
    });
    it('classifies bad credentials', () => {
      expect(classifyToolFailureType('Error', 'Authentication Failed: Bad credentials')).toBe('config');
    });
    it('classifies a Meta insights job timeout (config pattern, not transient)', () => {
      expect(classifyToolFailureType('timeout', 'Meta Insights Job timed out.')).toBe('config');
    });
  });

  describe('bug — genuine code defect / unknown to investigate (default)', () => {
    it('classifies a network drop (transient, but worth investigating if recurring)', () => {
      expect(classifyToolFailureType('network', 'socket hang up')).toBe('bug');
    });
    it('classifies an opaque error', () => {
      expect(classifyToolFailureType('Error', 'An unknown error has occurred.')).toBe('bug');
    });
    it('classifies an opaque success=false', () => {
      expect(classifyToolFailureType('Error', 'Tool returned success=false')).toBe('bug');
    });
    it('classifies a playwright locator timeout as a bug (browser robustness), NOT config', () => {
      // distinct from an AbortController "operation was aborted" — a 5s locator
      // timeout is real browser flakiness to fix, not tunable infra.
      expect(classifyToolFailureType('Error', 'TimeoutError: Timeout 5000ms exceeded waiting for locator')).toBe('bug');
    });
    it('handles empty/undefined input without throwing', () => {
      expect(classifyToolFailureType('', '')).toBe('bug');
      expect(classifyToolFailureType(undefined as unknown as string, undefined as unknown as string)).toBe('bug');
    });
  });

  describe('tuned rules — reclassify the previously-bug-tagged misclassifications', () => {
    it('LinkedIn "Cannot resend yet" is by_design (platform state)', () => {
      expect(classifyToolFailureType('Error', 'Cannot resend yet')).toBe('by_design');
    });
    it('LinkedIn "Recipient cannot be reached" is by_design', () => {
      expect(classifyToolFailureType('Error', 'Recipient cannot be reached')).toBe('by_design');
    });
    it('"No search results found" is by_design, not a bug', () => {
      expect(classifyToolFailureType('Error', 'No search results found')).toBe('by_design');
    });
    it('a corrupted/password-protected PDF is by_design (bad input)', () => {
      expect(
        classifyToolFailureType('Error', 'Failed to parse PDF file. The file may be corrupted or password-protected. Invalid PDF structure'),
      ).toBe('by_design');
    });
    it('a too-long LinkedIn invitation note is schema_reject (arg constraint)', () => {
      expect(
        classifyToolFailureType('Error', 'Invitation message is too long (201 characters). LinkedIn limits invitation notes to 200 characters'),
      ).toBe('schema_reject');
    });
    it('the summarizer cascade is config (downstream of a 429)', () => {
      expect(classifyToolFailureType('Error', 'Unable to retrieve a Summarizer summary.')).toBe('config');
    });
    it('a perform_data_analysis 404 is config (missing resource)', () => {
      expect(classifyToolFailureType('Error', 'Request failed with status code 404')).toBe('config');
    });
    it('an AbortController timeout is config (tunable infra), not a code bug', () => {
      expect(classifyToolFailureType('timeout', 'AbortError: This operation was aborted')).toBe('config');
    });
  });
});

describe('payment_required → config (ENG-664)', () => {
  it('treats X credit exhaustion as a config/quota gap, not a tool bug', () => {
    expect(classifyToolFailureType('payment_required')).toBe('config');
  });

  it('classifies a 402 credit message as config even without an errorClass', () => {
    expect(
      classifyToolFailureType('', 'X API error (HTTP 402): AgentWeb X plan out of credits'),
    ).toBe('config');
  });
});

describe('402 alternation is HTTP-status-anchored, not a bare number (ENG-664)', () => {
  it('does NOT classify an unrelated "402" (id / line number) as config', () => {
    expect(classifyToolFailureType('', 'failed at line 402 while parsing row')).toBe('bug');
    expect(classifyToolFailureType('', 'record 402 not found')).not.toBe('config');
  });
  it('still classifies a real HTTP 402 credit message as config', () => {
    expect(classifyToolFailureType('', 'X API error (HTTP 402): out of credits')).toBe('config');
    expect(classifyToolFailureType('', 'status code 402 payment required')).toBe('config');
  });
});

describe('publisher_refused → by_design, not config or bug (ENG-1162)', () => {
  it('treats a publisher bot-block/WAF refusal as by_design — the tool worked, a third party declined it', () => {
    expect(classifyToolFailureType('publisher_refused')).toBe('by_design');
  });

  it('does not route it to config — there is no credential/account fix on our side', () => {
    expect(
      classifyToolFailureType(
        'publisher_refused',
        'The publisher refused this fetch (HTTP 403: Forbidden) — this is a site-side access block (bot filtering, WAF, or paywall), not an AgentWeb account or permissions problem.',
      ),
    ).not.toBe('config');
  });

  it('classifies the real net::ERR_EMPTY_RESPONSE browser-navigation shape as by_design, not bug', () => {
    expect(
      classifyToolFailureType(
        'publisher_refused',
        'Error: browserBackend.callTool: net::ERR_EMPTY_RESPONSE at https://ramaonhealthcare.com/example',
      ),
    ).toBe('by_design');
  });

  it('still classifies as by_design from the MESSAGE alone, without errorClass — the marker text contains "Forbidden", which would otherwise match CONFIG_RE and silently fall to config', () => {
    expect(
      classifyToolFailureType(
        '',
        'The publisher refused this fetch (HTTP 403: Forbidden) — this is a site-side access block (bot filtering, WAF, or paywall), not an AgentWeb account or permissions problem.',
      ),
    ).toBe('by_design');
    expect(
      classifyToolFailureType(
        undefined,
        'Error: browserBackend.callTool: net::ERR_EMPTY_RESPONSE at https://ramaonhealthcare.com/example',
      ),
    ).toBe('by_design');
  });
});

describe('quota_exceeded → config, not bug (ENG-1220)', () => {
  it('treats hard quota exhaustion as a config/billing gap, not a tool bug', () => {
    expect(classifyToolFailureType('quota_exceeded')).toBe('config');
  });

  it('classifies a real OpenAI/Azure quota message as config even without the class (message-only fallback)', () => {
    expect(
      classifyToolFailureType('', 'gpt-image-2 API failed: You exceeded your current quota, please check your plan and billing details.'),
    ).toBe('config');
    expect(classifyToolFailureType('', 'insufficient_quota')).toBe('config');
  });

  it('does NOT fall through to bug — the automated tool-failure proposal system reads failureType to decide "investigate the handler" vs. "resolve the account"', () => {
    expect(classifyToolFailureType('quota_exceeded', 'gpt-image-2 API failed: Request failed with status code 429')).not.toBe('bug');
  });
});

describe('ENG-2583 — unconnected integrations / unconfigured resources / CRM role refusals', () => {
  it('"<Service> not connected … Connected Accounts" is config, not bug', () => {
    expect(
      classifyToolFailureType('Error', 'Google Drive not connected. Connect Google Drive in Settings → Connected Accounts.'),
    ).toBe('config');
  });

  it('"No <thing> is configured" is config, not bug', () => {
    expect(
      classifyToolFailureType('Error', 'No Slack channel is configured for your account. Ask your admin to set one up.'),
    ).toBe('config');
  });

  it('CRM list role refusal is by_design (role boundary working as designed)', () => {
    expect(
      classifyToolFailureType(
        'Error',
        'Only the list owner, the org owner, or a listed CRM editor can do this. Ask your org admin to add you as a CRM editor.',
      ),
    ).toBe('by_design');
  });

  it('does not reclassify unrelated messages that merely mention connection/configuration', () => {
    expect(classifyToolFailureType('Error', 'socket hang up: connection reset by peer')).toBe('bug');
    expect(classifyToolFailureType('Error', 'Webhook configured successfully but delivery returned 500')).toBe('bug');
    expect(classifyToolFailureType('Error', 'Client disconnected unexpectedly')).toBe('bug');
  });

  // ENG-2810: the hubspotMarketingPreflight refusals name a plan/grant gap the
  // customer fixes in HubSpot or Connected Accounts — not a handler bug.
  it('classifies HubSpot Marketing Hub capability refusals as config, not bug', () => {
    expect(classifyToolFailureType('Error',
      'This HubSpot portal does not have Marketing Hub, so it cannot read or write FORM (a Marketing Hub object). '
      + 'Marketing access was requested when the account was connected and HubSpot did not grant it.')).toBe('config');
    expect(classifyToolFailureType('Error',
      'This HubSpot connection was authorised for CRM access only, so it cannot read or write EMAIL (a Marketing Hub object).')).toBe('config');
  });
});
