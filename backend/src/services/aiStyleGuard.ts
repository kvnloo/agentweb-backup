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

export interface AiStyleTellSummary {
  total: number;
  byCategory: Partial<Record<AiStyleTellCategory, number>>;
  byRule: Record<string, number>;
}

interface StyleScannableMessage {
  role: string;
  content?: unknown;
  tool_calls?: any[];
  metadata?: { toolCalls?: Array<{ arguments?: unknown }> };
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Aggregate AI-tell hits across Emma's output in a session (ENG-2429).
 * Scans assistant text and tool-call argument strings (where generated
 * drafts live). User/system/tool messages are ignored. Pure.
 */
export function summarizeAiStyleTells(
  messages: readonly StyleScannableMessage[] = []
): AiStyleTellSummary {
  const summary: AiStyleTellSummary = { total: 0, byCategory: {}, byRule: {} };
  for (const m of messages) {
    if (!m || m.role !== "assistant") continue;
    const texts: string[] = [];
    collectStrings(m.content, texts);
    for (const tc of m.tool_calls ?? []) {
      collectStrings(parseMaybeJson(tc?.function?.arguments ?? tc?.arguments), texts);
    }
    for (const tc of m.metadata?.toolCalls ?? []) {
      collectStrings(parseMaybeJson(tc?.arguments), texts);
    }
    for (const t of texts) {
      for (const hit of detectAiStyleTells(t)) {
        summary.total++;
        summary.byCategory[hit.category] = (summary.byCategory[hit.category] ?? 0) + 1;
        summary.byRule[hit.ruleId] = (summary.byRule[hit.ruleId] ?? 0) + 1;
      }
    }
  }
  return summary;
}
