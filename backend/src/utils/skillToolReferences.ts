import type { Skill } from "../services/skillService";

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blindspot 5 guard (ENG-204): find the tool names a skill's `systemPrompt`
 * references but that are NOT declared in its `toolNames`.
 *
 * Only names present in `allToolNames` (the real registry universe — the union
 * of `emmaToolRegistry` + `mcpToolRegistry`) are considered, so ordinary prose
 * is ignored and we never guess at made-up identifiers. Matching is whole-token
 * (an underscore counts as a word char) so a shorter tool like `search_web`
 * never matches inside a longer one like `you_search_web`.
 *
 * Pure and registry-agnostic: callers pass the tool universe, which keeps this
 * unit-testable without importing the (heavy) tool registries.
 */
export function findUndeclaredToolReferences(
  skill: Pick<Skill, "toolNames" | "systemPrompt">,
  allToolNames: Iterable<string>,
): string[] {
  const prompt = skill.systemPrompt;
  if (!prompt) return [];

  const declared = new Set(skill.toolNames || []);
  const undeclared = new Set<string>();

  for (const tool of allToolNames) {
    if (!tool || declared.has(tool)) continue;
    // Only identifier-like names (snake_case with an underscore) are
    // unambiguous tool references. Bare dictionary-word tool names (e.g.
    // `email`) are indistinguishable from prose and would false-positive on
    // every "send an email" sentence, so we skip them.
    if (!tool.includes("_")) continue;
    // (?<![\w]) / (?![\w]) — a word char (incl. underscore) on either side
    // means this is part of a longer identifier, not a standalone reference.
    const re = new RegExp(`(?<![\\w])${escapeRegExp(tool)}(?![\\w])`);
    if (re.test(prompt)) undeclared.add(tool);
  }

  return [...undeclared].sort();
}
