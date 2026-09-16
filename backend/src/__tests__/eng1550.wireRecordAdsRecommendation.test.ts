/**
 * ENG-1550 — guards on the script that wires `record_ads_recommendation` into live
 * production skills.
 *
 * This script edits customer-facing skill rows that have no draft, no version
 * history and no undo (ENG-917). The properties worth pinning are therefore about
 * what it CANNOT do, not what it does:
 *
 *   1. It must use `ADD` on the toolNames set and never `put` the row. A wholesale
 *      put is the mechanism that deleted RULE 8.5 — it can drop tools and clobber
 *      systemPrompt. A test that only checked "the tool ends up present" would pass
 *      just as happily on the dangerous implementation.
 *   2. It must fail closed when a skillId no longer names the skill it was written
 *      against, since production contains genuine duplicate skill NAMES and ids can
 *      in principle be reused.
 *   3. Dry run and already-wired must write nothing at all.
 */

import { wireToolIntoSkills, TARGET_SKILLS, TOOL_NAME } from '../scripts/eng1550-wire-record-ads-recommendation';

const TABLE = 'AW-Skills-test';

function makeSkill(skillId: string, name: string, tools: string[]) {
  return { skillId, name, systemPrompt: 'do not clobber me', toolNames: { values: tools } };
}

/** Minimal DocumentClient stand-in that records every call it receives. */
function makeDocClient(rows: Record<string, any>) {
  const calls = { get: [] as any[], update: [] as any[], put: [] as any[] };
  return {
    calls,
    client: {
      get: (params: any) => {
        calls.get.push(params);
        return { promise: async () => ({ Item: rows[params.Key.skillId] }) };
      },
      update: (params: any) => {
        calls.update.push(params);
        const row = rows[params.Key.skillId];
        const added: string[] = params.ExpressionAttributeValues[':t'].values;
        const next = Array.from(new Set([...(row.toolNames.values as string[]), ...added]));
        row.toolNames = { values: next };
        return { promise: async () => ({ Attributes: { toolNames: { values: next } } }) };
      },
      put: (params: any) => {
        calls.put.push(params);
        return { promise: async () => ({}) };
      },
      createSet: (vals: string[]) => ({ values: vals }),
    } as any,
  };
}

function allThreeRows() {
  const rows: Record<string, any> = {};
  TARGET_SKILLS.forEach((t, i) => {
    rows[t.skillId] = makeSkill(t.skillId, t.expectedName, [`existing_tool_${i}`]);
  });
  return rows;
}

describe('ENG-1550 wire record_ads_recommendation into skills', () => {
  it('adds the tool to every target skill via ADD, never a put', async () => {
    const rows = allThreeRows();
    const { client, calls } = makeDocClient(rows);

    const results = await wireToolIntoSkills({ apply: true, docClient: client, table: TABLE });

    expect(results.every((r) => r.applied)).toBe(true);
    expect(calls.update).toHaveLength(TARGET_SKILLS.length);

    // THE guard: a wholesale put is what destroys systemPrompt / drops tools.
    expect(calls.put).toHaveLength(0);
    for (const call of calls.update) {
      expect(call.UpdateExpression).toBe('ADD toolNames :t');
      expect(call.ConditionExpression).toBe('attribute_exists(skillId)');
      // Nothing but toolNames may appear in the update.
      expect(call.UpdateExpression).not.toMatch(/systemPrompt|name|isPublished/);
    }

    for (const t of TARGET_SKILLS) {
      expect(rows[t.skillId].toolNames.values).toContain(TOOL_NAME);
      expect(rows[t.skillId].systemPrompt).toBe('do not clobber me');
    }
  });

  it('never removes an existing tool', async () => {
    const rows = allThreeRows();
    const before = TARGET_SKILLS.map((t) => [...rows[t.skillId].toolNames.values]);
    const { client } = makeDocClient(rows);

    await wireToolIntoSkills({ apply: true, docClient: client, table: TABLE });

    TARGET_SKILLS.forEach((t, i) => {
      for (const tool of before[i]) {
        expect(rows[t.skillId].toolNames.values).toContain(tool);
      }
    });
  });

  it('writes nothing on a dry run', async () => {
    const rows = allThreeRows();
    const { client, calls } = makeDocClient(rows);

    const results = await wireToolIntoSkills({ apply: false, docClient: client, table: TABLE });

    expect(calls.update).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(results.every((r) => !r.applied)).toBe(true);
    expect(results[0].toolsAfter).toBe((results[0].toolsBefore ?? 0) + 1);
  });

  it('is idempotent — a re-run writes nothing', async () => {
    const rows = allThreeRows();
    const first = makeDocClient(rows);
    await wireToolIntoSkills({ apply: true, docClient: first.client, table: TABLE });

    const second = makeDocClient(rows);
    const results = await wireToolIntoSkills({ apply: true, docClient: second.client, table: TABLE });

    expect(second.calls.update).toHaveLength(0);
    expect(results.every((r) => r.skippedReason === 'already wired')).toBe(true);
  });

  it('fails closed when a skillId no longer names the expected skill', async () => {
    const rows = allThreeRows();
    const victim = TARGET_SKILLS[1];
    rows[victim.skillId].name = 'Some Completely Different Skill';
    const { client, calls } = makeDocClient(rows);

    const results = await wireToolIntoSkills({ apply: true, docClient: client, table: TABLE });

    const skipped = results.find((r) => r.skillId === victim.skillId)!;
    expect(skipped.applied).toBe(false);
    expect(skipped.skippedReason).toMatch(/name mismatch/);
    expect(rows[victim.skillId].toolNames.values).not.toContain(TOOL_NAME);
    // The other two still proceed — one bad id does not abort the whole run.
    expect(calls.update).toHaveLength(TARGET_SKILLS.length - 1);
  });

  it('skips a missing skill without throwing', async () => {
    const rows = allThreeRows();
    delete rows[TARGET_SKILLS[0].skillId];
    const { client } = makeDocClient(rows);

    const results = await wireToolIntoSkills({ apply: true, docClient: client, table: TABLE });

    expect(results[0].skippedReason).toBe('skill not found');
    expect(results.filter((r) => r.applied)).toHaveLength(TARGET_SKILLS.length - 1);
  });

  it('excludes Conversion Tracking Validator and Landing Page Checker on purpose', () => {
    // Tracking fixes move measured CPL because the MEASUREMENT changed, not because
    // performance did — logging those as predictions would write confounded wins.
    const names = TARGET_SKILLS.map((t) => t.expectedName);
    expect(names).not.toContain('Conversion Tracking Validator');
    expect(names).not.toContain('Landing Page Checker (Ads)');
    expect(TARGET_SKILLS).toHaveLength(3);
  });
});
