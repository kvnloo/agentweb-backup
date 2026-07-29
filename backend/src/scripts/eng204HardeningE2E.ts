/**
 * ENG-204 — E2E verification of the hardening MECHANISM against the real dev
 * DynamoDB round-trip. Creates a throwaway skill, then proves:
 *   1. apply: blocks + tools land, and EVERY other field is preserved
 *   2. idempotent: a second apply changes nothing
 *   3. rollback: restoring the backup yields the original systemPrompt/toolNames
 * Cleans up the throwaway at the end. Manual/dev only. NODE_ENV=development.
 */
import os from "os";
import { skillService } from "../services/skillService";
import { planSkillChange } from "../services/skillHardening/applyHardening";
import { backupSkill, parseSkillBackup } from "../services/skillHardening/backup";
import fs from "fs";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}
const sortedEq = (a: string[] = [], b: string[] = []) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function main() {
  // 1. create a realistic throwaway (real Set shape via createSkill)
  const created = await skillService.createSkill(
    "ENG-204 E2E probe (auto-delete)",
    "throwaway for hardening E2E",
    ["read_brand_guidelines"],
    "Use you_search_web for research.",
    false,
  );
  const id = created.skillId;
  console.log(`created throwaway ${id}`);

  try {
    const original = (await skillService.getSkill(id))!;
    const dir = fs.mkdtempSync(`${os.tmpdir()}/eng204-e2e-`);
    const backupPath = backupSkill(original, dir, "e2e");

    // 2. apply blocks + tools
    const plan = planSkillChange(original, {
      skillId: id,
      blocks: ["safety", "failure"],
      addTools: ["you_search_web", "list_connected_accounts"],
    });
    await skillService.updateSkill(plan.skill);
    const applied = (await skillService.getSkill(id))!;

    check("apply: SAFETY block present", (applied.systemPrompt || "").includes("## SAFETY & VOLUME LIMITS"));
    check("apply: FAILURE block present", (applied.systemPrompt || "").includes("## FAILURE HANDLING"));
    check("apply: original prompt text retained", (applied.systemPrompt || "").includes("Use you_search_web for research."));
    check("apply: tools added", sortedEq(applied.toolNames, ["read_brand_guidelines", "you_search_web", "list_connected_accounts"]));
    check("apply: name preserved", applied.name === original.name);
    check("apply: description preserved", applied.description === original.description);
    check("apply: isPublished preserved", applied.isPublished === original.isPublished);
    check("apply: createdAt preserved", applied.createdAt === original.createdAt);

    // 3. idempotency — second apply must change nothing
    const plan2 = planSkillChange(applied, {
      skillId: id,
      blocks: ["safety", "failure"],
      addTools: ["you_search_web", "list_connected_accounts"],
    });
    check("idempotent: planSkillChange reports changed=false", plan2.changed === false);

    // 4. rollback from backup
    const restored = parseSkillBackup(fs.readFileSync(backupPath, "utf8"));
    await skillService.updateSkill(restored);
    const back = (await skillService.getSkill(id))!;
    check("rollback: systemPrompt restored", back.systemPrompt === original.systemPrompt);
    check("rollback: toolNames restored", sortedEq(back.toolNames, original.toolNames));

    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await skillService.deleteSkill(id);
    console.log(`deleted throwaway ${id}`);
  }

  console.log(`\n${failures === 0 ? "ALL E2E CHECKS PASSED" : failures + " E2E CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
