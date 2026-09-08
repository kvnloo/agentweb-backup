// ENG-1722 (ENG-1609 AC #1-#5): the "Daily LinkedIn Connection + Outreach Agent"
// system template. `createScheduleFromTemplate` COPIES startingMessage onto each
// new schedule rather than referencing it, so a defect seeded here is permanent
// for every schedule created before it is noticed — these tests are the gate on
// the one artifact that cannot be fixed in place.

jest.mock('../services/db', () => ({
  scheduleTemplateDb: {
    getTemplatesByVisibility: jest.fn(),
    createTemplate: jest.fn(),
  },
}));

import { scheduleTemplateDb } from '../services/db';
import {
  LINKEDIN_OUTREACH_TEMPLATE_ID,
  LINKEDIN_OUTREACH_TEMPLATE_NAME,
  LINKEDIN_OUTREACH_TEMPLATE_CATEGORY,
  LINKEDIN_OUTREACH_STARTING_MESSAGE,
  VARIABLE_DESCRIPTIONS,
  SYSTEM_TEMPLATE_CREATOR,
  buildLinkedInOutreachTemplate,
  extractTemplateVariableNames,
} from '../scripts/seed-eng1609-linkedin-outreach-template';

describe('template shape (AC #1)', () => {
  const template = buildLinkedInOutreachTemplate('2026-09-07T00:00:00.000Z');

  it('is a SYSTEM template with a non-empty category, so the listing can find it', () => {
    // getScheduleTemplates merges getTemplatesByVisibility('system') into every
    // user's list, and that query runs on VisibilityCategoryIndex — where
    // `visibility` is the HASH key and `category` the RANGE key. A blank category
    // makes the row invisible to the very listing AC #1 requires it to appear in.
    expect(template.visibility).toBe('system');
    expect(template.category).toBe(LINKEDIN_OUTREACH_TEMPLATE_CATEGORY);
    expect(template.category.length).toBeGreaterThan(0);
    expect(template.createdBy).toBe(SYSTEM_TEMPLATE_CREATOR);
    expect(template.createdBy.length).toBeGreaterThan(0);
    expect(template.name).toBe(LINKEDIN_OUTREACH_TEMPLATE_NAME);
    expect(template.suggestedFrequency).toBe('daily');
  });

  it('carries a usable description and a STABLE id across builds', () => {
    // Stable, not per-run (CodeRabbit): a fresh id each run meant two concurrent
    // seeds could both pass a check-then-create and publish DUPLICATE system
    // templates. The fixed id makes the conditional create itself the uniqueness
    // check. Changing it would seed a second template rather than update this one.
    expect(template.description.length).toBeGreaterThan(40);
    expect(template.templateId).toBe(LINKEDIN_OUTREACH_TEMPLATE_ID);
    expect(buildLinkedInOutreachTemplate().templateId).toBe(LINKEDIN_OUTREACH_TEMPLATE_ID);
  });
});

describe('variables (AC #2)', () => {
  const template = buildLinkedInOutreachTemplate();

  it('declares exactly the placeholders the prompt uses — no more, no fewer', () => {
    // There are no optional variables: a declared variable left blank hard-fails
    // the run before the model is called, and a placeholder with no declared
    // variable is never substituted and reaches the model as literal "{{x}}".
    const inPrompt = extractTemplateVariableNames(LINKEDIN_OUTREACH_STARTING_MESSAGE).sort();
    const declared = template.variables.map((v) => v.name).sort();
    expect(declared).toEqual(inPrompt);
    expect(Object.keys(VARIABLE_DESCRIPTIONS).sort()).toEqual(inPrompt);
  });

  it('is the variable set the parent ticket specifies', () => {
    expect(template.variables.map((v) => v.name).sort()).toEqual([
      'daily_connection_target',
      'icp_description',
      'lead_list_id',
      'message_template',
    ]);
  });

  it('gives every variable a description that actually explains what to type', () => {
    template.variables.forEach((v) => {
      expect(v.description.length).toBeGreaterThan(40);
      expect(['text', 'long_text']).toContain(v.type);
    });
  });

  it('documents a literal default for each field the ticket calls "optional"', () => {
    // Neither can be genuinely optional, so each needs a value a user can type
    // that the prompt then handles. Both the description and the prompt must name
    // the same literal, or the owner types a word the prompt ignores.
    expect(VARIABLE_DESCRIPTIONS.message_template.description).toContain('"default"');
    expect(LINKEDIN_OUTREACH_STARTING_MESSAGE).toContain('the literal word "default"');
    expect(VARIABLE_DESCRIPTIONS.lead_list_id.description).toContain('"create new"');
    expect(LINKEDIN_OUTREACH_STARTING_MESSAGE).toContain('the literal phrase "create new"');
  });

  it('throws rather than seeding a placeholder nobody documented', () => {
    const orphan = VARIABLE_DESCRIPTIONS.icp_description;
    delete (VARIABLE_DESCRIPTIONS as any).icp_description;
    try {
      expect(() => buildLinkedInOutreachTemplate()).toThrow(/icp_description/);
    } finally {
      (VARIABLE_DESCRIPTIONS as any).icp_description = orphan;
    }
  });
});

describe('validation wiring (AC #4)', () => {
  const template = buildLinkedInOutreachTemplate();

  it('declares linkedin_outreach — the field ENG-1132 gates its whole chain on', () => {
    expect(template.requiredFunctionCalls).toEqual(['linkedin_outreach']);
  });

  it('sets the minimum to exactly 1', () => {
    // 1 is meaningful only because ENG-1720 made the verdict action-aware: it now
    // reads "at least one send actually succeeded". A HIGHER minimum is worse, not
    // stricter — the press loop still counts by name and fires on under-calling,
    // so mandating several calls drags a cooldown-stopped run into the press
    // ENG-1715 had to bound.
    expect(template.functionCallMinCalls).toEqual({ linkedin_outreach: 1 });
  });
});

describe('prompt content', () => {
  const prompt = LINKEDIN_OUTREACH_STARTING_MESSAGE;
  // Matched against whitespace-collapsed text: the prompt is hard-wrapped for
  // readability, so a phrase can straddle a newline and an otherwise-correct
  // assertion would fail on where the line happened to break.
  const flat = prompt.replace(/\s+/g, ' ');

  it('AC #3: makes stop-on-first-account-level-block the default path', () => {
    expect(prompt).toContain('STOP ON THE FIRST ACCOUNT-LEVEL BLOCK');
    expect(flat).toMatch(/do not try other recipients/i);
    expect(flat).toMatch(/do not switch accounts/i);
    // And distinguishes it from a per-recipient failure, which must NOT stop the run.
    expect(flat).toMatch(/per-recipient failure/i);
  });

  it('AC #7: states no numeric per-run cap of its own — volume is the backend\'s', () => {
    // ENG-1631 had to run a production migration because a prompt-level
    // "max 5 invites/run" outlived the backend cap it mirrored. The only number
    // this prompt may carry is the note character limit, which is LinkedIn's own
    // hard constraint on the text and not a volume decision.
    const volumeClaims = flat.match(/\b\d+\s*(?:invit|connection|request|send|message)/gi) || [];
    expect(volumeClaims).toEqual([]);
    expect(flat).toMatch(/you do not count for it and you do not decide it/i);
    expect(flat).toMatch(/never call set-daily-invite-cap/i);
  });

  it('carries the ENG-1640 signal-channel ladder, with announcement text demoted to last', () => {
    const engagement = prompt.indexOf('ENGAGEMENT MINING');
    const twoHop = prompt.indexOf('EMPLOYER-EVENT TWO-HOP');
    const announcement = prompt.indexOf('ANNOUNCEMENT-TEXT SEARCH');
    expect(engagement).toBeGreaterThan(-1);
    expect(engagement).toBeLessThan(twoHop);
    expect(twoHop).toBeLessThan(announcement);
  });

  it('reads the backlog before sourcing, and never reports an unreadable one as empty', () => {
    // ENG-1718 restored the three named outcomes; the prompt has to use them or
    // the truthfulness fix stops at the tool boundary.
    expect(prompt).toContain('list-sent-invitations');
    expect(prompt).toMatch(/liveUnavailable/);
    expect(flat).toMatch(/never report "no pending invitations"/i);
  });

  it('requires a completion ledger and forbids claiming unconfirmed sends', () => {
    expect(flat).toMatch(/completion ledger/i);
    expect(flat).toMatch(/never state or imply an invitation went out unless the tool result confirmed it/i);
  });

  it('refuses anonymized results and the note-quota auto-retry', () => {
    expect(flat).toMatch(/anonymized/i);
    expect(flat).toMatch(/noteQuotaExceeded/);
    expect(flat).toMatch(/do not retry automatically/i);
  });

  it('does not promise a warm-up ramp that is not built yet', () => {
    // ENG-1721 (AC #6) is unbuilt. A prompt claiming a ramp would be describing
    // behaviour the backend does not have.
    expect(flat).not.toMatch(/warm-?up/i);
  });
});

describe('seed idempotency (AC #6)', () => {
  const mockDb = scheduleTemplateDb as jest.Mocked<typeof scheduleTemplateDb>;
  // The script only self-invokes under `require.main === module`, so importing it
  // here is inert; `main` is reached through the module's own export surface.
  const runSeed = async () => {
    const mod = await import('../scripts/seed-eng1609-linkedin-outreach-template');
    await (mod as any).main();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('writes exactly one row on a clean table, conditionally', async () => {
    mockDb.createTemplate.mockResolvedValue(undefined as any);

    await runSeed();

    expect(mockDb.createTemplate).toHaveBeenCalledTimes(1);
    expect(mockDb.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: LINKEDIN_OUTREACH_TEMPLATE_ID,
        name: LINKEDIN_OUTREACH_TEMPLATE_NAME,
        visibility: 'system',
        requiredFunctionCalls: ['linkedin_outreach'],
      }),
      // The condition is what makes it safe against a concurrent second run.
      { onlyIfAbsent: true },
    );
  });

  it('running it twice leaves exactly one row', async () => {
    const seeded: any[] = [];
    mockDb.createTemplate.mockImplementation(async (t: any) => {
      if (seeded.some((x) => x.templateId === t.templateId)) {
        const e: any = new Error('exists'); e.alreadyExists = true; throw e;
      }
      seeded.push(t); return t;
    });

    await runSeed();
    await runSeed();

    expect(seeded).toHaveLength(1);
  });

  it('a CONCURRENT second run loses the race cleanly instead of duplicating', async () => {
    // The case a check-then-create could not survive: both runs see an empty table.
    const e: any = new Error('exists'); e.alreadyExists = true;
    mockDb.createTemplate.mockRejectedValue(e);

    await expect(runSeed()).resolves.toBeUndefined();
  });

  it('a real database error is NOT swallowed as "already exists"', async () => {
    mockDb.createTemplate.mockRejectedValue(new Error('dynamo down'));
    await expect(runSeed()).rejects.toThrow('dynamo down');
  });


});
