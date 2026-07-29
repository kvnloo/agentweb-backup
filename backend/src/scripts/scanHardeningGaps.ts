/**
 * ENG-204 completeness scan (ops / CI-with-DB). Surfaces skills that still need
 * hardening so scope stays data-derived:
 *   - Blindspot 4: published skills with an EMPTY systemPrompt.
 *   - Blindspot 1: skills holding a send/write/delete tool but no SAFETY block.
 * Scans AW-Skills for the current NODE_ENV. Exit 1 if any gaps found.
 *
 *   NODE_ENV=development npx ts-node src/scripts/scanHardeningGaps.ts
 */
import { skillService } from "../services/skillService";
import { hasEmptyPrompt, needsSafetyBlock, powerToolsOf } from "../utils/hardeningGaps";

async function main(): Promise<void> {
  const skills = await skillService.getAllSkills();

  const emptyPublished = skills.filter((s) => s.isPublished && hasEmptyPrompt(s));
  const uncapped = skills.filter((s) => needsSafetyBlock(s));

  console.log(`\n== Blindspot 4: published skills with EMPTY prompt (${emptyPublished.length}) ==`);
  for (const s of emptyPublished) console.log(`  ✗ ${s.skillId}  ${s.name}`);

  console.log(`\n== Blindspot 1: send/write/delete power, no SAFETY block (${uncapped.length}) ==`);
  for (const s of uncapped) {
    console.log(`  ✗ ${s.skillId}  ${s.name}  [${powerToolsOf(s).join(", ")}]`);
  }

  const gaps = emptyPublished.length + uncapped.length;
  console.log(`\nScanned ${skills.length} skills; ${gaps} gap(s).`);
  process.exit(gaps > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
