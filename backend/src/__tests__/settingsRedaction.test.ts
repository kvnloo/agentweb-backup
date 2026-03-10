import { redactSensitiveValues, REDACTED_PLACEHOLDER } from '../utils/settingsRedaction';

describe('Settings value redaction — API key protection', () => {
  // --- FAIL TESTS ---

  it('should redact values that look like Stripe secret keys', () => {
    const settings = [
      { settingName: 'stripe_key', settingValue: 'sk_test_51ABC123def456', description: 'Stripe', updatedAt: '', updatedBy: '' },
    ];
    const result = redactSensitiveValues(settings);
    expect(result[0].settingValue).toBe(REDACTED_PLACEHOLDER);
  });

  it('should redact values that look like Stripe publishable keys', () => {
    const settings = [
      { settingName: 'stripe_pk', settingValue: 'pk_test_51ABC123def456', description: 'Stripe PK', updatedAt: '', updatedBy: '' },
    ];
    const result = redactSensitiveValues(settings);
    expect(result[0].settingValue).toBe(REDACTED_PLACEHOLDER);
  });

  it('should redact values that look like AWS keys', () => {
    const settings = [
      { settingName: 'aws_key', settingValue: 'AKIAIOSFODNN7EXAMPLE', description: 'AWS', updatedAt: '', updatedBy: '' },
    ];
    const result = redactSensitiveValues(settings);
    expect(result[0].settingValue).toBe(REDACTED_PLACEHOLDER);
  });

  it('should redact JSON values containing sensitive keys in nested objects', () => {
    const mcpConfig = JSON.stringify({
      servers: [
        { name: 'test', url: 'https://example.com', api_key: 'sk-abc123secret' },
      ],
    });
    const settings = [
      { settingName: 'mcp_servers', settingValue: mcpConfig, description: 'MCP', updatedAt: '', updatedBy: '' },
    ];
    const result = redactSensitiveValues(settings);
    const parsed = JSON.parse(result[0].settingValue);
    expect(parsed.servers[0].api_key).toBe(REDACTED_PLACEHOLDER);
    // Non-sensitive fields preserved
    expect(parsed.servers[0].name).toBe('test');
    expect(parsed.servers[0].url).toBe('https://example.com');
  });

  it('should redact setting names that indicate secrets even if value looks innocent', () => {
    const settings = [
      { settingName: 'openai_api_key', settingValue: 'looks-normal-but-is-key', description: '', updatedAt: '', updatedBy: '' },
      { settingName: 'anthropic_secret', settingValue: 'also-a-secret', description: '', updatedAt: '', updatedBy: '' },
    ];
    const result = redactSensitiveValues(settings);
    expect(result[0].settingValue).toBe(REDACTED_PLACEHOLDER);
    expect(result[1].settingValue).toBe(REDACTED_PLACEHOLDER);
  });

  // --- SUCCESS TESTS (should NOT redact) ---

  it('should preserve non-sensitive settings unchanged', () => {
    const settings = [
      { settingName: 'default_image_model', settingValue: 'openai-image-1', description: 'Default model', updatedAt: '2024-01-01', updatedBy: 'admin' },
      { settingName: 'email_templates_public', settingValue: '[]', description: 'Templates', updatedAt: '2024-01-01', updatedBy: 'admin' },
      { settingName: 'site_title', settingValue: 'AgentWeb', description: 'Title', updatedAt: '2024-01-01', updatedBy: 'admin' },
    ];
    const result = redactSensitiveValues(settings);
    expect(result[0].settingValue).toBe('openai-image-1');
    expect(result[1].settingValue).toBe('[]');
    expect(result[2].settingValue).toBe('AgentWeb');
  });

  it('should not mutate the original settings array', () => {
    const original = [
      { settingName: 'secret_key', settingValue: 'sk_test_abc', description: '', updatedAt: '', updatedBy: '' },
    ];
    const originalValue = original[0].settingValue;
    redactSensitiveValues(original);
    expect(original[0].settingValue).toBe(originalValue);
  });
});
