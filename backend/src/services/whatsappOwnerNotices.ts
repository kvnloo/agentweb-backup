/**
 * Emails to the owner of an account about its WhatsApp connection (ENG-273).
 *
 * WhatsApp can no longer reach the person (they texted STOP, or an approval could not be
 * delivered), so these go by email — the one channel that does not depend on the thing that
 * just stopped working. Best-effort and never throws: telling the owner must not fail the
 * webhook or the request that triggered it. No phone number is put in a subject (the mail
 * layer logs subjects) and none in a log line.
 */
import { settingsService } from './settingsService';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function send(userId: string, subject: string, paragraphs: string[]): Promise<boolean> {
  try {
    const { userDb } = await import('./db');
    const user: any = await userDb.getUserById(userId);
    if (!user?.email) return false;
    const { emailService } = await import('./emailService');
    const outcome = await emailService.sendEmail(
      user.email,
      subject,
      paragraphs.join('\n\n'),
      paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join(''),
    );
    if (outcome === 'failed') {
      console.error(`[whatsapp-notice] could not email the owner of user ${userId}: "${subject}"`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[whatsapp-notice] could not email the owner of user ${userId}:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/** They texted STOP: WhatsApp was disconnected from the account. */
export async function notifyOwnerStopDisconnected(
  userId: string,
  cancelledApprovals: number,
): Promise<boolean> {
  const paragraphs = [
    'You replied STOP on WhatsApp, so AgentWeb has disconnected WhatsApp from your account and will not message that number.',
    'Your account now has no messaging platform. Until you connect one again (Settings in AgentWeb), AgentWeb has nowhere to ask you for approvals: tasks that require approval will deliver their results to their subscribers without waiting for your review.',
  ];
  if (cancelledApprovals > 0) {
    paragraphs.push(
      `${cancelledApprovals} approval request${cancelledApprovals === 1 ? ' that was' : 's that were'} still waiting for your answer ${cancelledApprovals === 1 ? 'has' : 'have'} been cancelled and marked rejected, and the results they were holding will not be sent. Request approval again after you reconnect.`,
    );
  }
  paragraphs.push(
    'If you did not mean to stop messages: reply START on WhatsApp, then open Settings in AgentWeb and connect WhatsApp again.',
  );
  return send(userId, 'Your WhatsApp connection was removed', paragraphs);
}

/**
 * An approval request could not be delivered to their WhatsApp. At most one email per
 * account per day, however many approvals fail, so a standing problem is one nudge and not
 * a flood.
 */
export async function notifyOwnerUnreachable(userId: string): Promise<boolean> {
  try {
    const first = await settingsService.setSettingIfAbsent(
      `whatsapp:unreachable-notice:${userId}`,
      '1',
      'WhatsApp unreachable notice already sent (rate limit)',
      'system',
      Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    );
    if (!first) return false;
  } catch {
    // Rate-limit store down: better one extra email than none.
  }
  const sent = await sendUnreachable(userId);
  if (!sent) {
    // The email did not go: give the day's slot back so the next failure can try again.
    try {
      await settingsService.deleteSetting(`whatsapp:unreachable-notice:${userId}`);
    } catch {
      // Best-effort: at worst the next failure waits out the day.
    }
  }
  return sent;
}

function sendUnreachable(userId: string): Promise<boolean> {
  return send(userId, "We couldn't reach you on WhatsApp", [
    "AgentWeb tried to send you an approval request on WhatsApp and it could not be delivered. The results waiting on that approval are on hold.",
    "This usually means the number can't receive WhatsApp messages from AgentWeb right now (for example you blocked the number, or the number changed). Open Settings in AgentWeb to check your WhatsApp connection or connect again.",
  ]);
}
