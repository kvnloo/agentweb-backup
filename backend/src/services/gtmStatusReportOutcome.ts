/**
 * What a GTM status report actually did, and how a caller should answer for it. No imports on purpose: the route, Emma's tool and the
 * tests all use it, and none of them should need the mail service to say "nothing was sent".
 */

/**
 * `recipients` is how many distinct addresses the chosen options resolved to (0 when no option was chosen, or the chosen contacts are
 * not set on the plan), `sent` how many emails the mail service accepted, `failed` how many it refused, `suppressed` (set
 * only when above 0) how many the non-production email guard resolved without delivering, `overCap` (set only when the caller capped the
 * recipients and the report would have gone to more people) the cap, in which case nothing was sent, and `multiAddressContacts` (set only
 * under a cap) how many contacts on the plan hold more than one address, in which case nothing was sent either. A caller that answers
 * "sent" without reading this reports a send that never happened.
 */
export interface StatusReportResult {
  recipients: number;
  sent: number;
  failed: number;
  suppressed?: number;
  overCap?: number;
  multiAddressContacts?: number;
}

/**
 * How a caller should answer for a finished status report: `ok` is false (with the HTTP status to use) when nothing was sent, so
 * "sent successfully" is only ever said about a send that happened. One wording for the route and for Emma's tool.
 */
export function describeStatusReport(result: StatusReportResult, subject: string): { ok: boolean; httpStatus: number; message: string } {
  if (result.multiAddressContacts !== undefined) {
    const n = result.multiAddressContacts;
    return {
      ok: false,
      httpStatus: 400,
      message: `The ${subject} was not sent: ${n} contact${n === 1 ? '' : 's'} on the plan hold${n === 1 ? 's' : ''} more than one email address, and a report sent this way goes to one address per contact. Nothing was emailed. Put a single address in each contact.`,
    };
  }
  if (result.overCap !== undefined) {
    return {
      ok: false,
      httpStatus: 400,
      message: `The ${subject} was not sent: it would go to ${result.recipients} people and one call may email at most ${result.overCap}. Nothing was emailed. Choose fewer contacts.`,
    };
  }
  if (result.recipients === 0) {
    return {
      ok: false,
      httpStatus: 400,
      message: `The ${subject} was not sent: nobody was chosen to receive it, or the contacts chosen (plan owner, plan contact, phase contact) have no email address. Nothing was emailed.`,
    };
  }
  const held = result.suppressed ?? 0;
  if (result.sent === 0 && held === 0) {
    return {
      ok: false,
      httpStatus: 502,
      message: `The ${subject} could not be sent: the mail service refused all ${result.recipients} email${result.recipients === 1 ? '' : 's'}, or the report could not be built. Nothing was delivered.`,
    };
  }
  if (result.sent === 0) {
    // not production: the email guard resolved the sends without delivering them. Not a failure, and not "sent".
    return { ok: true, httpStatus: 200, message: `The ${subject} was NOT delivered: this environment's email guard held back ${held} email${held === 1 ? '' : 's'}${result.failed > 0 ? ` and ${result.failed} could not be sent` : ''}.` };
  }
  const notes = held > 0 ? ` ${held} held back by this environment's email guard.` : '';
  if (result.failed > 0) {
    return { ok: true, httpStatus: 200, message: `The ${subject} was sent to ${result.sent} of ${result.recipients} recipients; ${result.failed} could not be sent.${notes}` };
  }
  return { ok: true, httpStatus: 200, message: `The ${subject} was sent successfully to ${result.sent} recipient${result.sent === 1 ? '' : 's'}.${notes}` };
}
