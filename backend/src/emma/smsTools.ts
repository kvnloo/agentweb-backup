import { emmaToolRegistry } from './registry';
import { smsService } from '../services/smsService';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

emmaToolRegistry.register({
  name: 'send_sms',
  definition: {
    name: 'send_sms',
    description:
      'Send an SMS message from a configured sender phone number to a recipient. ' +
      'Both phone numbers must be in E.164 format (e.g. +12065551234). ' +
      'Use get_sms_history to check prior conversation before sending. ' +
      'The from_phone must be a phone number the user has configured as an SMS sender in their CRM settings.',
    inputSchema: {
      type: 'object',
      properties: {
        from_phone: {
          type: 'string',
          description: "Sender's phone number in E.164 format (e.g. +12065551234). Must be configured as an SMS sender in CRM settings.",
        },
        to_phone: {
          type: 'string',
          description: "Recipient's phone number in E.164 format (e.g. +12065551234).",
        },
        message: {
          type: 'string',
          description: 'The SMS message body. Max 1600 characters (10 segments).',
        },
        contact_name: {
          type: 'string',
          description: 'Optional display name of the recipient, used only for the success message.',
        },
      },
      required: ['from_phone', 'to_phone', 'message'],
    },
  },
  execute: async (args: any, _context: any = {}) => {
    const { from_phone, to_phone, message, contact_name } = args;

    if (!from_phone?.trim()) {
      return { success: false, error: 'from_phone is required.' };
    }
    if (!isValidE164(from_phone.trim())) {
      return { success: false, error: `Invalid from_phone format. Use E.164: +12065551234 (got: ${from_phone})` };
    }
    if (!to_phone?.trim()) {
      return { success: false, error: 'to_phone is required.' };
    }
    if (!isValidE164(to_phone.trim())) {
      return { success: false, error: `Invalid to_phone format. Use E.164: +12065551234 (got: ${to_phone})` };
    }
    if (!message?.trim()) {
      return { success: false, error: 'message cannot be empty.' };
    }
    if (message.trim().length > 1600) {
      return { success: false, error: 'Message exceeds 1600 characters. Please shorten it.' };
    }

    try {
      const result = await smsService.sendSMS(from_phone.trim(), to_phone.trim(), message.trim());
      const recipientLabel = contact_name?.trim() ? `${contact_name.trim()} (${to_phone.trim()})` : to_phone.trim();
      return {
        success: true,
        message_sid: result.messageSid,
        status: result.status,
        message: `SMS sent to ${recipientLabel}.`,
      };
    } catch (err: any) {
      return { success: false, error: `Failed to send SMS: ${err?.message || String(err)}` };
    }
  },
});

emmaToolRegistry.register({
  name: 'get_sms_history',
  definition: {
    name: 'get_sms_history',
    description:
      'Retrieve SMS conversation history between a sender phone number and a recipient phone number. ' +
      'Returns messages in both directions sorted by date descending (most recent first). ' +
      'Use this before sending a new SMS to understand prior context.',
    inputSchema: {
      type: 'object',
      properties: {
        from_phone: {
          type: 'string',
          description: "The sender's phone number in E.164 format (e.g. +12065551234). Must be configured as an SMS sender in CRM settings.",
        },
        to_phone: {
          type: 'string',
          description: "The recipient's phone number in E.164 format (e.g. +12065551234).",
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return. Default: 20. Max: 50.',
        },
      },
      required: ['from_phone', 'to_phone'],
    },
  },
  execute: async (args: any, _context: any = {}) => {
    const { from_phone, to_phone, limit } = args;

    if (!from_phone?.trim()) {
      return { success: false, error: 'from_phone is required.' };
    }
    if (!isValidE164(from_phone.trim())) {
      return { success: false, error: `Invalid from_phone format. Use E.164: +12065551234 (got: ${from_phone})` };
    }
    if (!to_phone?.trim()) {
      return { success: false, error: 'to_phone is required.' };
    }
    if (!isValidE164(to_phone.trim())) {
      return { success: false, error: `Invalid to_phone format. Use E.164: +12065551234 (got: ${to_phone})` };
    }

    const resolvedLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 50) : 20;

    try {
      const messages = await smsService.getSMSHistory(from_phone.trim(), to_phone.trim(), resolvedLimit);
      return {
        success: true,
        from_phone: from_phone.trim(),
        to_phone: to_phone.trim(),
        count: messages.length,
        messages: messages.map((m) => ({
          direction: m.direction,
          body: m.body,
          status: m.status,
          created_at: m.createdAt,
        })),
      };
    } catch (err: any) {
      return { success: false, error: `Failed to retrieve SMS history: ${err?.message || String(err)}` };
    }
  },
});
