import {
  AI_STYLE_TELL_RULES,
  AiStyleTellCategory,
  AiStyleTellRule,
} from "../config/aiStyleTells";

export interface AiStyleTellHit {
  ruleId: string;
  category: AiStyleTellCategory;
  match: string;
  index: number;
  hint: string;
}

/**
 * Detect AI-tell phrasing in a draft (ENG-1815). Pure; does not rewrite.
 * Hits are sorted by position.
 */
export function detectAiStyleTells(
  text: string,
  rules: readonly AiStyleTellRule[] = AI_STYLE_TELL_RULES
): AiStyleTellHit[] {
  if (!text) return [];
  const hits: AiStyleTellHit[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      hits.push({
        ruleId: rule.id,
        category: rule.category,
        match: m[0],
        index: m.index,
        hint: rule.hint,
      });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
