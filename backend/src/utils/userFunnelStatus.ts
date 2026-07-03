const USER_FUNNEL_STATUS_LABELS: Record<string, string> = {
  follow_up: 'Follow-up',
  call_booking: 'Call Booking',
  sales_conversation: 'Sales Conversation',
  design_trial: 'Design Trial',
  trial_agreed: 'Trial Agreed',
  account_setup: 'Account Setup',
  activation: 'Activation',
  evaluation_period: 'Evaluation Period',
  decision_day: 'Decision Day',
  payment_conversion: 'Payment Conversion',
  paid_retention_handoff: 'Paid / Retention Handoff',
  parked: 'Parked',
};

const USER_FUNNEL_STATUS_PRIORITY_TAGS: Record<string, string> = {
  follow_up: 'Sales',
  call_booking: 'Sales',
  sales_conversation: 'Sales',
  design_trial: 'Sales',
  trial_agreed: 'Sales',
  account_setup: 'Setup',
  activation: 'Activated',
  evaluation_period: 'Activated',
  decision_day: 'Activated',
  payment_conversion: 'Activated',
  paid_retention_handoff: 'Retention',
  parked: 'Parked',
};

export function getUserFunnelStatusLabel(funnelStatus?: string | null): string | null {
  if (!funnelStatus) return null;
  return USER_FUNNEL_STATUS_LABELS[funnelStatus] ?? funnelStatus;
}

export function getUserFunnelStatusIssueTags(funnelStatus?: string | null): string[] {
  const label = getUserFunnelStatusLabel(funnelStatus);
  if (!label) return [];

  const tags = [`Status: ${label}`];
  const priorityTag = USER_FUNNEL_STATUS_PRIORITY_TAGS[funnelStatus || ''];
  if (priorityTag && !tags.includes(priorityTag)) {
    tags.push(priorityTag);
  }

  return tags;
}
