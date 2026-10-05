/**
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — shared LinkedIn
 * "resolve a company from a title/headline" helpers.
 *
 * Moved verbatim (zero logic changes) from module scope in
 * `services/agentModeService.ts`, where both were previously non-exported
 * module-scope functions reachable only via the file's own `__testHooks`.
 * Promoted here because BOTH of this round's two extraction targets need
 * them and they no longer land in the same module:
 *  - `resolveEmployersForSizeFilter` (`emma/impl/linkedin.ts`)
 *  - `importLeadsFromSearch` (`emma/impl/leads.ts`)
 *
 * `batchParseCompaniesFromTitlesWithLLM` needed ZERO signature changes to
 * make this move — it already took its LLM gateway as an explicit
 * `Pick<AgentModeService, 'callLLM'> | null` parameter rather than reading
 * `this`, so both call sites just switch from passing the whole class
 * instance (`this`) to passing `{ callLLM }`, where `callLLM` is itself an
 * injected function parameter on the two moved methods (the same
 * `this.callLLM.bind(this)` shape used throughout this series' Pattern A:
 * `createHtmlFromTemplate`, ...). `Pick<AgentModeService, 'callLLM'>` is kept
 * verbatim (not replaced with a narrower local type) specifically so this
 * function's own signature never has to change — `AgentModeService` is
 * imported here as a type only, which TypeScript fully erases at compile
 * time, so this does not introduce any real (value-level) circular import:
 * `agentModeService.ts` already imports `emma/impl/linkedin.ts` and
 * `emma/impl/leads.ts` at the value level (for their delegating wrappers),
 * and this module importing `AgentModeService`'s TYPE back does not run at
 * runtime at all.
 */
import type { AgentModeService } from '../../../services/agentModeService';

/**
 * Tier 2 of company resolution for LinkedIn-search leads: cheap regex on
 * the lead's headline / title. Looks for "Role at Company" or "Role @ Company"
 * (case-insensitive on "at"). Other separators (|, ·, –) are left to Tier 3
 * (LLM) so we don't false-positive on "Senior Engineer - Backend".
 */
export function parseCompanyFromTitle(title: any): string | null {
  if (typeof title !== 'string' || !title) return null;
  const match = title.match(/^.*?\S\s+(?:at|@)\s+(\S.*?)\s*$/i);
  if (!match) return null;
  const company = match[1].split(/\s*[|·•‧]\s*/)[0].trim();
  return company || null;
}

/**
 * Tier 3 of company resolution: ONE shared-gateway call per page that takes the
 * full batch of titles and returns a parallel array of company names (or
 * "NONE"). Caller passes the gateway seam so the helper stays pure and
 * easily mockable. On any error or response-shape mismatch, returns an
 * all-"NONE" array so callers fall through to Tier 4 (Unipile getProfile).
 */
export async function batchParseCompaniesFromTitlesWithLLM(
  titles: string[],
  gateway: Pick<AgentModeService, 'callLLM'> | null,
  userId?: string,
): Promise<string[]> {
  if (!Array.isArray(titles) || titles.length === 0) return [];
  if (!gateway?.callLLM) return titles.map(() => 'NONE');
  try {
    const systemPrompt = [
      'You extract company names from professional / LinkedIn titles in batch.',
      'Input is a JSON array of titles. Return a JSON array of the SAME length where each entry is either the extracted company name as plain text, or the literal string "NONE" if no company is identifiable.',
      '',
      'Examples:',
      'Input:  ["Software Engineer at Google", "Founder | Acme Inc", "Senior Engineer", "Developer · Microsoft"]',
      'Output: ["Google", "Acme Inc", "NONE", "Microsoft"]',
      '',
      'Output rules:',
      '- Return ONLY the JSON array, no preamble, no markdown fence, no commentary.',
      '- Same length as input.',
      '- Plain text company names, no quotes inside the strings.',
      '- Use "NONE" (uppercase) when uncertain.',
    ].join('\n');
    const userPrompt = `Titles: ${JSON.stringify(titles)}`;
    const completion = await gateway.callLLM(
      'gemini-3.1-flash-lite',
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        max_completion_tokens: Math.max(500, titles.length * 30),
        temperature: 0.1,
        usageContext: { userId, feature: 'title_company_parse' },
        taskClass: 'nonstandard_consumer',
      },
    );
    const raw = String(completion?.choices?.[0]?.message?.content ?? '').trim();
    // Gemini Flash often adds preamble / postamble / markdown fences despite
    // explicit instructions. Locate the widest `[ ... ]` substring instead of
    // strict-parsing the whole response.
    const firstBracket = raw.indexOf('[');
    const lastBracket = raw.lastIndexOf(']');
    if (firstBracket < 0 || lastBracket <= firstBracket) {
      console.warn('[batchParseCompaniesFromTitlesWithLLM] no JSON array in response:', raw.slice(0, 200));
      return titles.map(() => 'NONE');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    } catch (parseErr: any) {
      console.warn('[batchParseCompaniesFromTitlesWithLLM] JSON.parse failed:', parseErr?.message, '| raw:', raw.slice(0, 200));
      return titles.map(() => 'NONE');
    }
    if (!Array.isArray(parsed) || parsed.length !== titles.length) {
      return titles.map(() => 'NONE');
    }
    return parsed.map((v: any) => {
      if (typeof v !== 'string') return 'NONE';
      const t = v.trim();
      if (!t) return 'NONE';
      if (t.toUpperCase() === 'NONE') return 'NONE';
      if (t.length > 100) return 'NONE';
      return t;
    });
  } catch (e: any) {
    console.warn('[batchParseCompaniesFromTitlesWithLLM] failed:', e?.message ?? String(e));
    return titles.map(() => 'NONE');
  }
}
