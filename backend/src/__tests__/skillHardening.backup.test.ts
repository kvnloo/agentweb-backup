import fs from "fs";
import os from "os";
import path from "path";
import {
  serializeSkillBackup,
  parseSkillBackup,
  backupSkill,
} from "../services/skillHardening/backup";

const skill = {
  skillId: "s-123",
  name: "Test Skill",
  description: "d",
  toolNames: ["a_tool", "b_tool"],
  systemPrompt: "hello",
  isPublished: true,
  createdAt: "t0",
  updatedAt: "t1",
} as any;

describe("skill backup", () => {
  it("round-trips a skill through serialize/parse without loss", () => {
    expect(parseSkillBackup(serializeSkillBackup(skill))).toEqual(skill);
  });

  it("serializes with stable (sorted) key order for reviewable diffs", () => {
    const json = serializeSkillBackup(skill);
    const keys = Object.keys(JSON.parse(json));
    expect(keys).toEqual([...keys].sort());
  });

  it("writes a snapshot file named <skillId>.<stamp>.json and reads back equal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eng204-bk-"));
    try {
      const file = backupSkill(skill, dir, "20260729T000000Z");
      expect(path.basename(file)).toBe("s-123.20260729T000000Z.json");
      expect(parseSkillBackup(fs.readFileSync(file, "utf8"))).toEqual(skill);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
