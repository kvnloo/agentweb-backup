/**
 * How long a push will take to SEND, for the preview (ENG-673). Smartlead releases leads as the mailboxes' daily limits allow;
 * the push itself finishes in seconds. Advisory only: a mailbox limit counts warmup mail too, and can change after approval.
 */
export interface SendEstimate {
  /** Leads Smartlead can start a day: the mailboxes' limits added up, capped by the campaign's own daily maximum. */
  perDay: number;
  days: number;
}

export function estimateDaysToSend(input: { leads: number; mailboxLimits: Array<number | undefined>; campaignMaxLeadsPerDay?: number }): SendEstimate | undefined {
  const limits = input.mailboxLimits.filter((n): n is number => typeof n === "number" && n > 0);
  if (limits.length === 0 || input.leads <= 0) return undefined;
  let perDay = limits.reduce((sum, n) => sum + n, 0);
  if (input.campaignMaxLeadsPerDay && input.campaignMaxLeadsPerDay > 0) perDay = Math.min(perDay, input.campaignMaxLeadsPerDay);
  return { perDay, days: Math.ceil(input.leads / perDay) };
}
