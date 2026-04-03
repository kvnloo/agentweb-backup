import { CRMTrigger, SendEmailAction } from '../types/crmTriggers';
import { resendService } from './resendService';
import { substituteVariables } from '../utils/emailVariables';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';

export async function runTriggerAction(
  trigger: CRMTrigger,
  lead: Record<string, any>,
  list: Record<string, any>,
  user: Record<string, any>,
  eventData?: Record<string, any>
): Promise<{ actionTaken: string; error?: string }> {
  const { action } = trigger;

  if (action.type === 'send_email') {
    return runSendEmailAction(action, trigger, lead, list, user, eventData);
  }

  // Future action types (linkedin_connect, etc.) would be handled here
  return { actionTaken: `unknown action type: ${(action as any).type}` };
}

async function runSendEmailAction(
  action: SendEmailAction,
  trigger: CRMTrigger,
  lead: Record<string, any>,
  _list: Record<string, any>,
  user: Record<string, any>,
  eventData?: Record<string, any>
): Promise<{ actionTaken: string; error?: string }> {
  try {
    let toEmails: string[];

    if (action.toType === 'list_owner') {
      if (!user?.email) {
        return { actionTaken: '', error: 'List owner email not available' };
      }
      toEmails = [user.email];
    } else {
      if (!action.toEmails || action.toEmails.length === 0) {
        return { actionTaken: '', error: 'No recipient emails configured' };
      }
      toEmails = action.toEmails;
    }

    const subject = substituteVariables(action.subjectTemplate || '', lead, eventData);
    const body = substituteVariables(action.bodyTemplate || '', lead, eventData);

    const from = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;

    await resendService.sendEmail({
      from,
      to: toEmails,
      subject,
      html: body,
    });

    return {
      actionTaken: `send_email to ${toEmails.join(', ')}`,
    };
  } catch (err: any) {
    return {
      actionTaken: '',
      error: err?.message || 'Failed to send email',
    };
  }
}
