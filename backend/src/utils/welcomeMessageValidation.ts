import { Parser } from 'htmlparser2';

export const WELCOME_MESSAGE_VALIDATION_ERROR =
  'welcomeMessage must be plain text or Markdown without raw HTML or control characters';

export function validateWelcomeMessage(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'welcomeMessage must be a string';
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return WELCOME_MESSAGE_VALIDATION_ERROR;
  }

  // Ignore code and Markdown autolinks before parsing for raw HTML.
  const parseable = value
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\r\n]*`/g, '')
    .replace(/<(?:https?:\/\/[^\s<>]+|mailto:[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})>/gi, '');
  let rawHtml = false;
  const reject = () => { rawHtml = true; };
  const parser = new Parser({
    onopentag: reject, onclosetag: reject, oncomment: reject, onprocessinginstruction: reject,
  });
  parser.end(parseable);
  return rawHtml ? WELCOME_MESSAGE_VALIDATION_ERROR : null;
}
