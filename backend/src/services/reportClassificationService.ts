import { agentModeService } from './agentModeService';

export type ReportType = 'creative' | 'research' | 'performance';

const CLASSIFICATION_MODEL = 'gemini-3.1-flash-lite-preview';
const CLASSIFICATION_TIMEOUT_MS = 10000;
const MAX_CONTENT_CHARS = 500;

const SYSTEM_PROMPT = `You classify HTML reports into exactly one category.

Categories:
- creative: blog articles, social media posts, ad copy, content calendars, email campaigns, marketing copy
- performance: paid ads reports, ROAS, CPM, CPC, CTR, ad spend, campaign metrics, conversion rates, media buying analytics
- research: market intelligence, competitor analysis, SEO reports, lead lists, general business reports, summaries, audits, GTM plans

Reply with ONLY one word: creative, performance, or research.`;

export async function classifyReport(filename: string, contentExcerpt: string): Promise<ReportType> {
  const truncated = contentExcerpt.slice(0, MAX_CONTENT_CHARS);
  const userMessage = `Filename: ${filename}\nContent: ${truncated}`;

  try {
    const llmPromise = agentModeService.callLLM(
      CLASSIFICATION_MODEL,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0, max_completion_tokens: 5 }
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Classification timed out')), CLASSIFICATION_TIMEOUT_MS)
    );

    const res = await Promise.race([llmPromise, timeoutPromise]);
    const raw = (res.choices?.[0]?.message?.content ?? '').trim().toLowerCase();

    if (raw === 'creative' || raw === 'performance' || raw === 'research') {
      return raw;
    }
    // Partial match fallback
    if (raw.includes('creative')) return 'creative';
    if (raw.includes('performance')) return 'performance';
    return 'research';
  } catch {
    return 'research';
  }
}
