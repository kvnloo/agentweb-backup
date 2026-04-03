export type LeadEvent = 'lead.created' | 'lead.updated' | 'lead.deleted';

export interface SendEmailAction {
  type: 'send_email';
  toType: 'list_owner' | 'custom';
  toEmails?: string[];
  subjectTemplate: string;
  bodyTemplate: string;
}

export interface LinkedInConnectAction {
  type: 'linkedin_connect';
  messageTemplate?: string;
}

export type TriggerAction = SendEmailAction | LinkedInConnectAction;

export interface CRMTrigger {
  triggerId: string;
  listId: string;
  userId: string;
  event: LeadEvent;
  name: string;
  description?: string;
  enabled: boolean;
  conditionExpression: string;
  action: TriggerAction;
  createdAt: string;
  updatedAt: string;
}

export interface CRMTriggerLog {
  logId: string;
  triggerId: string;
  listId: string;
  userId: string;
  event: LeadEvent;
  leadId: string;
  leadEmail?: string;
  status: 'fired' | 'skipped' | 'error';
  errorMessage?: string;
  expressionResult?: boolean;
  actionTaken?: string;
  createdAt: string;
  ttl?: number;
}
