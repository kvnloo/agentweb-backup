export type LeadEvent =
  // Lead lifecycle
  | 'lead.created'
  | 'lead.updated'
  | 'lead.deleted'
  // Email tracking (Resend webhooks)
  | 'email.received'
  | 'email.opened'
  | 'email.clicked'
  | 'email.delivered'
  | 'email.bounced'
  | 'email.complained'
  // API ingestion events
  | 'api.lead_added'
  | 'api.lead_updated'
  | 'api.lead_failed'
  // Custom events (e.g. custom.linkedin)
  | string;

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
