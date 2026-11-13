import { announcedNameOf } from '../hotLeadCallConfig';

/**
 * ENG-2783: the name to print in the call-consent notice, from data the generation routes already loaded (no new read):
 * the org's hot-lead-call `announcedName` if configured, else the account's company name, else the org's name, else
 * undefined. A candidate with brackets, quotes or backslashes is skipped (it could be mistaken for a placeholder or break the prompt).
 */
export interface ConsentNameSources { name?: string; hotLeadCall?: { announcedName?: unknown } }
export function registeredBusinessNameOf(org?: ConsentNameSources | null, user?: { companyName?: string } | null): string | undefined {
  const usable = (v: unknown): string | undefined => {
    const t = typeof v === 'string' ? v.trim() : '';
    return t && t.length <= 100 && !/[[\]"\\<>{}\n\r]/.test(t) ? t : undefined;
  };
  return usable(announcedNameOf(org?.hotLeadCall?.announcedName)) ?? usable(user?.companyName) ?? usable(org?.name);
}

