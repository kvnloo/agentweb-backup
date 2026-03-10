import type { Setting } from '../services/settingsService';

export const REDACTED_PLACEHOLDER = '••••••••';

/**
 * Setting names that always indicate secrets, regardless of value content.
 */
const SENSITIVE_NAME_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /credential/i,
];

/**
 * Value prefixes that indicate secrets (Stripe, AWS, etc.)
 */
const SENSITIVE_VALUE_PREFIXES = [
  'sk_test_', 'sk_live_',   // Stripe secret keys
  'pk_test_', 'pk_live_',   // Stripe publishable keys
  'rk_test_', 'rk_live_',   // Stripe restricted keys
  'whsec_',                  // Stripe webhook secrets
  'AKIA',                    // AWS access key IDs
  'sk-',                     // OpenAI keys
];

/**
 * JSON object keys that indicate secrets and should be redacted.
 */
const SENSITIVE_JSON_KEYS = /^(api[_-]?key|secret[_-]?key|token|password|auth[_-]?token|access[_-]?key|private[_-]?key|secret|authorization|credential)$/i;

function isSensitiveSettingName(name: string): boolean {
  return SENSITIVE_NAME_PATTERNS.some(p => p.test(name));
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PREFIXES.some(prefix => value.startsWith(prefix));
}

/**
 * Recursively redact sensitive keys in a parsed JSON object.
 */
function redactJsonObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => redactJsonObject(item));
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_JSON_KEYS.test(key) && typeof value === 'string') {
        result[key] = REDACTED_PLACEHOLDER;
      } else {
        result[key] = redactJsonObject(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Redact sensitive values from settings before sending to admin UI.
 * Returns a new array — does not mutate the input.
 */
export function redactSensitiveValues(settings: Setting[]): Setting[] {
  return settings.map(setting => {
    // If the setting name itself indicates a secret, redact entirely
    if (isSensitiveSettingName(setting.settingName)) {
      return { ...setting, settingValue: REDACTED_PLACEHOLDER };
    }

    // If the raw value looks like a known key format, redact entirely
    if (isSensitiveValue(setting.settingValue)) {
      return { ...setting, settingValue: REDACTED_PLACEHOLDER };
    }

    // If value is JSON, recursively redact sensitive keys within
    if (setting.settingValue.startsWith('{') || setting.settingValue.startsWith('[')) {
      try {
        const parsed = JSON.parse(setting.settingValue);
        const redacted = redactJsonObject(parsed);
        return { ...setting, settingValue: JSON.stringify(redacted) };
      } catch {
        // Not valid JSON, return as-is
        return { ...setting };
      }
    }

    return { ...setting };
  });
}
