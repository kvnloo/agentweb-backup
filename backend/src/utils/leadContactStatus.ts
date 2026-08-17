/**
 * Utility for lead contact status checks.
 * Provides a single source of truth for determining if a lead should not be contacted,
 * with backward compatibility for the legacy `unsubscribedFromGroupEmail` flag.
 */

import { isGroupEmailIneligible } from './validation';

export type ContactStatus = 'active' | 'do-not-contact' | 'unsubscribed';
export type ContactStatusReason = 'opted-out' | 'bounced' | 'requested-removal' | 'admin-flagged' | 'compliance' | 'other';

/**
 * Returns true if the lead should NOT be contacted (email, LinkedIn, etc.).
 * Checks the new contactStatus field first, then falls back to the legacy unsubscribedFromGroupEmail flag.
 */
export function isDoNotContact(lead: any): boolean {
  if (lead.contactStatus === 'do-not-contact' || lead.contactStatus === 'unsubscribed') {
    return true;
  }
  // Backward compat: legacy flag without new contactStatus
  if (!lead.contactStatus && lead.unsubscribedFromGroupEmail === true) {
    return true;
  }
  return false;
}

/**
 * Returns a human-readable reason why a lead is flagged as do-not-contact.
 */
export function getDoNotContactReason(lead: any): string | null {
  if (!isDoNotContact(lead)) return null;

  if (lead.contactStatus === 'do-not-contact' || lead.contactStatus === 'unsubscribed') {
    const status = lead.contactStatus === 'unsubscribed' ? 'Unsubscribed' : 'Do Not Contact';
    const reason = lead.contactStatusReason ? ` (${lead.contactStatusReason})` : '';
    const note = lead.contactStatusNote ? `: ${lead.contactStatusNote}` : '';
    return `${status}${reason}${note}`;
  }

  // Legacy flag
  return 'Unsubscribed from group email';
}

/**
 * Returns true if a lead's email is undeliverable for group-email purposes —
 * either a provider-reported validation status of 'undeliverable', or a
 * deterministic syntax/test-domain issue caught by isGroupEmailIneligible.
 * Shared by the group-email preview and send endpoints (ENG-1194) so the
 * preview's undeliverable count matches what send actually filters.
 */
export function isLeadUndeliverable(lead: any): boolean {
  return lead?.customFields?.email_validation?.status === 'undeliverable' || isGroupEmailIneligible(lead?.email);
}
