/**
 * ENG-204 · Blindspot 5 lint (ops / CI-with-DB).
 *
 * Reports skills whose `systemPrompt` references a KNOWN tool that is missing
 * from the skill's `toolNames` — the exact defect that makes a skill call tools
 * it can't invoke (e.g. Brand Strategy & Market Research references
 * `you_search_web` / `search_knowledge_base` but never declares them).
 *
 * Scans the `AW-Skills` table for the current NODE_ENV (Dev-* in development).
 * Exit 0 = clean, 1 = violations found, 2 = error. The reusable matching logic
 * lives in ../utils/skillToolReferences (unit-tested); this script only wires it
 * to the live registries + table.
 *
 *   NODE_ENV=development npx ts-node src/scripts/lintSkillToolReferences.ts
 */
import { skillService } from "../services/skillService";
import { emmaToolRegistry } from "../emma/registry";
import { mcpToolRegistry } from "../mcp/server/registry";
import { findUndeclaredToolReferences } from "../utils/skillToolReferences";

async function collectKnownToolNames(): Promise<Set<string>> {
  // Mirror how the app populates the registries: apiTools registers the MCP
  // tools; emma/tools registers/bridges the Emma-side tools. Both are imported
  // for side effects only.
  await import("../mcp/server/apiTools");
  try {
    await import("../emma/tools");
  } catch (err) {
    console.warn(
      "[lint] Could not load emma/tools; linting against MCP tools only.",
      (err as Error)?.message,
    );
  }
  return new Set<string>([
    ...mcpToolRegistry.getToolNames(),
    ...emmaToolRegistry.getToolNames(),
  ]);
}

async function main(): Promise<void> {
  const known = await collectKnownToolNames();
  const skills = await skillService.getAllSkills();

  let violations = 0;
  for (const skill of skills) {
    const missing = findUndeclaredToolReferences(skill, known);
    if (missing.length > 0) {
      violations++;
      console.log(`✗ ${skill.skillId}  ${skill.name}`);
      console.log(`    prompt references, toolNames lacks: ${missing.join(", ")}`);
    }
  }

  console.log(
    `\nScanned ${skills.length} skills; ${violations} with undeclared tool references. ` +
      `(known tools: ${known.size})`,
  );
  process.exit(violations > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
