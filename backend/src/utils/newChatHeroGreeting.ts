export interface NewChatHeroGreeting {
  namedTemplate: string;
  anonymousText: string;
}

export const NEW_CHAT_HERO_GREETING_SETTING = 'agent_mode_new_chat_hero_greeting';
export const NEW_CHAT_HERO_GREETING_MAX_LENGTH = 120;

export const DEFAULT_NEW_CHAT_HERO_GREETING: Readonly<NewChatHeroGreeting> = Object.freeze({
  namedTemplate: "Hey {firstName}! Let's get after it",
  anonymousText: "Hey! Let's get after it",
});

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;
const RAW_HTML_TAG = /<\/?[a-z][^>]*>/i;
const TEMPLATE_TOKEN = /\{[^{}]*\}/g;

function validateLine(label: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${label} must be a string`;
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required`;
  if (trimmed.length > NEW_CHAT_HERO_GREETING_MAX_LENGTH) {
    return `${label} must be ${NEW_CHAT_HERO_GREETING_MAX_LENGTH} characters or fewer`;
  }
  if (CONTROL_CHARACTERS.test(trimmed)) return `${label} must be a single line`;
  if (RAW_HTML_TAG.test(trimmed)) return `${label} must be plain text`;
  return null;
}

export function validateNewChatHeroGreeting(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'New Chat hero greeting must be an object';
  }

  const candidate = value as Partial<NewChatHeroGreeting>;
  const namedError = validateLine('Named greeting template', candidate.namedTemplate);
  if (namedError) return namedError;
  const anonymousError = validateLine('Anonymous greeting', candidate.anonymousText);
  if (anonymousError) return anonymousError;

  const namedTemplate = candidate.namedTemplate!.trim();
  const tokens = namedTemplate.match(TEMPLATE_TOKEN) ?? [];
  if (tokens.length !== 1 || tokens[0] !== '{firstName}') {
    return 'Named greeting template must contain exactly one {firstName} token';
  }
  if (namedTemplate.replace(TEMPLATE_TOKEN, '').includes('{') || namedTemplate.replace(TEMPLATE_TOKEN, '').includes('}')) {
    return 'Named greeting template contains a malformed token; only {firstName} is supported';
  }
  if (candidate.anonymousText!.includes('{') || candidate.anonymousText!.includes('}')) {
    return 'Anonymous greeting does not support template tokens';
  }

  return null;
}

export function parseNewChatHeroGreetingSetting(rawValue: unknown): NewChatHeroGreeting {
  let candidate: unknown = rawValue;
  if (typeof rawValue === 'string') {
    try {
      candidate = JSON.parse(rawValue);
    } catch {
      return { ...DEFAULT_NEW_CHAT_HERO_GREETING };
    }
  }

  if (validateNewChatHeroGreeting(candidate)) {
    return { ...DEFAULT_NEW_CHAT_HERO_GREETING };
  }

  const valid = candidate as NewChatHeroGreeting;
  return {
    namedTemplate: valid.namedTemplate.trim(),
    anonymousText: valid.anonymousText.trim(),
  };
}
