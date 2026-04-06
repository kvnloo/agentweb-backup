import { emmaToolRegistry } from './registry';
import { tempEmailDb } from '../services/db';
import { TEMP_EMAIL_PREFIX, TEMP_EMAIL_DOMAIN } from '../config';

/**
 * Derive a session-scoped temp email address using the first 6 chars of the session ID.
 * e.g. test+abc123@updates.agentweb.pro
 */
function getTempEmailAddress(sessionId: string): string {
  const tag = sessionId.slice(0, 6).toLowerCase();
  return `${TEMP_EMAIL_PREFIX}+${tag}@${TEMP_EMAIL_DOMAIN}`;
}

emmaToolRegistry.register({
  name: 'get_temp_email',
  definition: {
    name: 'get_temp_email',
    description:
      'Returns a temporary email address you can use when signing up for services or receiving verification emails during a task. ' +
      'The address is unique to this session. Use check_temp_inbox to read emails sent to it.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context: any) => {
    const sessionId = context?.sessionId;
    if (!sessionId) {
      throw new Error('No session context available for temp email generation');
    }
    const address = getTempEmailAddress(sessionId);
    return { address };
  },
});

emmaToolRegistry.register({
  name: 'check_temp_inbox',
  definition: {
    name: 'check_temp_inbox',
    description:
      'Check emails received at the temporary email address for this session. ' +
      'Returns a list of emails with from, subject, and body text. ' +
      'Optionally filter by a minimum received timestamp or a subject keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description:
            'ISO 8601 timestamp. Only return emails received at or after this time. ' +
            'Useful to ignore stale emails from previous runs.',
        },
        subject_contains: {
          type: 'string',
          description: 'Only return emails whose subject contains this substring (case-insensitive).',
        },
      },
      required: [],
    },
  },
  execute: async (args: any, context: any) => {
    const sessionId = context?.sessionId;
    if (!sessionId) {
      throw new Error('No session context available for temp inbox check');
    }
    const address = getTempEmailAddress(sessionId);
    const emails = await tempEmailDb.getByAddress(address, args.since);

    let results = emails;
    if (args.subject_contains) {
      const filter = args.subject_contains.toLowerCase();
      results = emails.filter((e: any) =>
        (e.subject || '').toLowerCase().includes(filter)
      );
    }

    if (results.length === 0) {
      return {
        address,
        count: 0,
        message: 'No emails received yet. If you just signed up, wait a few seconds and try again.',
        emails: [],
      };
    }

    return {
      address,
      count: results.length,
      emails: results.map((e: any) => ({
        from: e.fromAddress,
        subject: e.subject,
        receivedAt: e.receivedAt,
        body: e.text,
      })),
    };
  },
});
