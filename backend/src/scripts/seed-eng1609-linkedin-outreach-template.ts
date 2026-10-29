/**
 * Seed script (ENG-1609 / ENG-1722): the "Daily LinkedIn Connection + Outreach
 * Agent" system schedule template.
 *
 * WHY A SCRIPT AND NOT THE API. `createScheduleTemplate` hardcodes
 * `visibility: 'private' as const` and ignores the body's field entirely, so the
 * user route CANNOT produce a system template — and `manage_schedule_template`'s
 * MCP schema advertises `system` while routing to that endpoint, so Emma asking
 * for one silently gets a private template nobody else can see. Creating one and
 * then PUT-ing the visibility does work, and that it works is the authorization
 * bug filed as ENG-1716; this script deliberately does not rely on it.
 *
 * WHY THE PROMPT MUST BE RIGHT BEFORE THE FIRST SEED. `createScheduleFromTemplate`
 * COPIES `template.startingMessage` onto each new schedule — it does not reference
 * it. Fixing the template later does not fix schedules already created from it, so
 * every adopter between a bad seed and its fix keeps the bad prompt permanently.
 *
 * WHAT THIS TURNS ON. ENG-1132's block-detection / fail-the-run / page-oncall
 * chain is gated on a schedule declaring `linkedin_outreach` in
 * `requiredFunctionCalls`. A read-only production scan of all 523
 * `AW-TaskSchedules` rows (2026-09-03) found 8 that do, all paused — the merged
 * fix protects nobody today. This template is the switch. It is therefore
 * deliberately sequenced AFTER ENG-1720 (action-aware counting, `35dde6c09`) and
 * ENG-1715 (the send-press breaker, `00c9e7e12`): without those it would arm a
 * validation mechanism that does not work and a press loop that does harm.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng1609-linkedin-outreach-template.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-eng1609-linkedin-outreach-template.ts
 *
 * Idempotent: skips if a template with this exact name already exists, so running
 * it twice leaves exactly one row.
 */
export const LINKEDIN_OUTREACH_TEMPLATE_NAME = 'Daily LinkedIn Connection + Outreach Agent';

/**
 * The system-wide account this row is attributed to. `createdBy` is the
 * CreatedByIndex hash key, so it must be a stable non-empty string; a system
 * template is not owned by any human, and pinning it to one admin's userId would
 * make the row disappear from that person's own template list the day their
 * account is removed.
 */
export const SYSTEM_TEMPLATE_CREATOR = 'system';

/**
 * STABLE identity, deliberately not a fresh uuid per run (CodeRabbit on PR #2799).
 *
 * The seed used to check "does a system template with this name exist?" and then
 * create one with a new id. Those are two operations, so two concurrent runs could
 * both observe "absent" and create DUPLICATE system templates — each visible to
 * every customer, and each a separate `startingMessage` that
 * `createScheduleFromTemplate` would go on copying. A fixed id turns the create
 * itself into the uniqueness check (`attribute_not_exists(templateId)`), leaving no
 * window between the two, and makes the row identifiable across environments.
 *
 * Never change this value: a new id would seed a SECOND template rather than
 * update the existing one.
 */
export const LINKEDIN_OUTREACH_TEMPLATE_ID = 'eng1609-linkedin-outreach-agent';

/**
 * `category` is the RANGE key of VisibilityCategoryIndex, which is how
 * `getScheduleTemplates` finds every system template. It must be present and
 * non-empty or the row is invisible to the listing this template exists to appear
 * in (AC #1).
 */
export const LINKEDIN_OUTREACH_TEMPLATE_CATEGORY = 'Outreach';

/**
 * THE PROMPT.
 *
 * Placeholders are the source of truth for the variable list — see
 * `VARIABLE_DESCRIPTIONS` and the test that pins the two together. Do not add a
 * `{{...}}` without a matching description: on the API route the variable list is
 * re-extracted from the message and a hand-passed array that disagrees is
 * overwritten, and at RUN time a schedule with a declared variable left blank
 * hard-fails before the model is ever called ("Scheduled chat cannot run. Missing
 * variable values: {{x}}").
 *
 * There are NO optional variables anywhere in this system, so the two fields the
 * parent ticket describes as optional carry documented literal defaults instead
 * ("default" and "create new"), handled by the prompt logic below.
 *
 * VOLUME IS THE BACKEND'S DECISION. The prompt states no numeric per-run cap of
 * its own — that drift is what ENG-1631 had to run a production migration over,
 * because a prompt-level "max 5 invites/run" outlived the backend cap it was
 * meant to mirror. `{{daily_connection_target}}` is the OWNER's stated intent;
 * `resolveDailyInviteCap` and the pacer are what actually bound the run, and a
 * tool refusal is final.
 */
export const LINKEDIN_OUTREACH_STARTING_MESSAGE = `Run today's LinkedIn connection and outreach cycle.

## WHO TO TARGET
{{icp_description}}

## HOW MANY
The owner's daily target is {{daily_connection_target}} new connection requests.

Treat that as INTENT, not entitlement. The backend enforces this account's real
daily invite cap and paces every write; you do not count for it and you do not
decide it. Never call set-daily-invite-cap from this run — it needs a person to
confirm whether the account is Premium, and there is nobody to ask in a scheduled
run. Proceed at whatever cap is already configured and say so in the ledger.

## STEP 1 — CHECK CAPACITY BEFORE SOURCING ANYTHING
Call list_connected_accounts(platform='unipile') to resolve the account_id. If no
LinkedIn account is connected, stop and report that — do not source leads for an
account that cannot send.

Then call linkedin_outreach with action 'list-sent-invitations' and read the
result honestly:
- "source" 'live' or 'cache' with a large "totalPending": the account is carrying
  a backlog, which is itself what triggers LinkedIn's account-level cooldown.
  Report the backlog size and recommend withdrawing the oldest invitations before
  adding more.
- "source" 'none' WITH liveUnavailable true: we could NOT read the backlog. That
  is not evidence there is none. Say so plainly; never report "no pending
  invitations" from this.
Relay the response's "notice" text rather than summarising it away.

## STEP 2 — SOURCE CANDIDATES, IN THIS ORDER
Only source as many as you still have room to contact. Work the channels in this
order and stop as soon as you have enough — the ordering is evidence-based, not a
preference:

1. ENGAGEMENT MINING — people who commented on or reacted to posts relevant to
   the target audience. They have already shown the interest you are selecting
   for. Use linkedin_outreach action 'list-post-engagers' on a relevant post to
   get its commenters.
2. EMPLOYER-EVENT TWO-HOP — find companies with a recent trigger event first
   (funding, launch, hiring surge, leadership change), then find the people at
   those companies who match the audience above.
3. ANNOUNCEMENT-TEXT SEARCH — searching for the announcement wording itself.
   Deliberately LAST: six consecutive runs on this channel alone produced nothing,
   while the two-hop channel's first rotation surfaced qualified candidates.

Skip anonymized/out-of-network results entirely — they come back with no public
profile URL and a placeholder name, they cannot be contacted or deduplicated, and
they must never be written to the CRM or presented as found leads.

## STEP 3 — SEND
Send connection requests with linkedin_outreach action 'send-invite', one
recipient at a time.

For the note: if {{message_template}} is the literal word "default", write a short
personalised note per recipient grounded in something real from their profile or
the post they engaged with. Otherwise use {{message_template}} as the note,
personalising the placeholders it contains. Keep notes at or under 200 characters
so they arrive complete.

STOP ON THE FIRST ACCOUNT-LEVEL BLOCK. If a send comes back with an account-level
invitation cooldown, a daily volume limit, or a pacing refusal, that applies to
the SENDING ACCOUNT and not to that one recipient. Every remaining send will fail
identically. Stop sending immediately, do not try other recipients, do not switch
accounts, and record the remaining candidates as queued for the next run.

A per-recipient failure ("cannot be reached", already connected, invitation
already pending) is different: note it and continue with the next person.

If a send returns requiresDecision / noteQuotaExceeded, the account's monthly
personalised-note quota is spent and the note was NOT sent. Do not retry
automatically and do not send it note-less on your own initiative — record it as
queued and say the owner needs to choose.

## STEP 4 — RECORD IT IN THE CRM
If {{lead_list_id}} is the literal phrase "create new", create a lead list named
for this audience on the first run and use it from then on. Otherwise use
{{lead_list_id}}.

Pass list_id on every send-invite, plus the invitee's own first_name, last_name,
company and title when you actually know them FOR THAT PERSON — never reuse the
filters you searched with, or the lead is stamped with the wrong employer.

## STEP 5 — REPORT WHAT ACTUALLY HAPPENED
End with a completion ledger: how many were attempted, how many sent, how many
blocked, how many failed and why, and how many are queued for next time. Name the
blocking reason in plain language when there was one.

Never state or imply an invitation went out unless the tool result confirmed it.
A run that sent nothing because the account was at capacity is a useful, honest
report — a run that claims sends it did not make is not.`;

/**
 * One entry per `{{placeholder}}` in the prompt above. A pinned test asserts this
 * map and the prompt's placeholders are exactly the same set, in both directions.
 */
export const VARIABLE_DESCRIPTIONS: Record<string, { description: string; type: 'text' | 'long_text' }> = {
  icp_description: {
    description:
      'Who to target — role, seniority, industry, company size, location, and any trigger event that makes someone a good fit right now. Free text; the more specific, the better the sourcing.',
    type: 'long_text',
  },
  daily_connection_target: {
    description:
      'How many connection requests to aim for per run. Default 10. The backend clamps this to the account\'s real daily invite cap, so a higher number is not accepted silently — it is simply not reached.',
    type: 'text',
  },
  message_template: {
    description:
      'The connection note to send. Write the literal word "default" to have a short personalised note written per recipient instead of a fixed one. Notes are trimmed to the account\'s limit (200 characters on free LinkedIn, 300 on Premium).',
    type: 'long_text',
  },
  lead_list_id: {
    description:
      'The CRM lead list to attribute this outreach to, so contact volume and follow-up cadence work. Write the literal phrase "create new" to have a list created on the first run.',
    type: 'text',
  },
};

const VARIABLE_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** The placeholder names the prompt actually uses, in first-appearance order. */
export function extractTemplateVariableNames(startingMessage: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  VARIABLE_REGEX.lastIndex = 0;
  while ((match = VARIABLE_REGEX.exec(startingMessage)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

export function buildLinkedInOutreachTemplate(now: string = new Date().toISOString()) {
  const variables = extractTemplateVariableNames(LINKEDIN_OUTREACH_STARTING_MESSAGE).map((name) => {
    const meta = VARIABLE_DESCRIPTIONS[name];
    if (!meta) {
      // Fail loudly rather than seed a template whose variable has no explanation:
      // the owner is asked to fill it in with no idea what it wants.
      throw new Error(`Prompt uses {{${name}}} with no entry in VARIABLE_DESCRIPTIONS`);
    }
    return { name, description: meta.description, type: meta.type };
  });

  return {
    templateId: LINKEDIN_OUTREACH_TEMPLATE_ID,
    createdBy: SYSTEM_TEMPLATE_CREATOR,
    name: LINKEDIN_OUTREACH_TEMPLATE_NAME,
    description:
      'Sources prospects matching your ICP, sends daily LinkedIn connection requests within the account\'s real cap, stops the moment LinkedIn throttles the account instead of burning through recipients, and reports exactly what was sent, blocked and queued.',
    category: LINKEDIN_OUTREACH_TEMPLATE_CATEGORY,
    visibility: 'system' as const,
    startingMessage: LINKEDIN_OUTREACH_STARTING_MESSAGE,
    variables,
    keywords: [],
    // ENG-1132 AC #2 / parent AC #4: this field is the switch that arms the
    // block-detection chain at all.
    requiredFunctionCalls: ['linkedin_outreach'],
    // Deliberately 1, and stated explicitly rather than left to the `|| 1` default
    // so the intent is legible.
    //
    // Before ENG-1720 a minimum of 1 was worthless here: the verdict counted
    // linkedin_outreach calls by NAME, so one successful `search-people` satisfied
    // it while every send was blocked. Action-aware counting changed what 1 MEANS —
    // it now reads "at least one send actually succeeded", which is exactly what
    // AC #4 asks for.
    //
    // A HIGHER minimum would be worse, not stricter. The press loop still counts by
    // name and fires on UNDER-CALLING, so mandating several calls is what drags a
    // cooldown-stopped run into the press ENG-1715 had to bound — pressing an
    // account LinkedIn is already throttling toward more irreversible sends. One is
    // the number that makes validation bite without arming that loop.
    functionCallMinCalls: { linkedin_outreach: 1 },
    suggestedFrequency: 'daily',
    emailNotifications: [],
    dailyDigest: false,
    llmModel: '',
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function main() {
  const { scheduleTemplateDb } = await import('../services/db');

  // The conditional create IS the existence check — no check-then-act window, so
  // two concurrent runs cannot both decide the row is absent.
  const template = buildLinkedInOutreachTemplate();
  try {
    await scheduleTemplateDb.createTemplate(template, { onlyIfAbsent: true });
  } catch (err: any) {
    if (err?.alreadyExists) {
      console.log(
        `Schedule template "${LINKEDIN_OUTREACH_TEMPLATE_NAME}" already exists `
        + `(id: ${LINKEDIN_OUTREACH_TEMPLATE_ID}). Nothing to do.`
      );
      return;
    }
    throw err;
  }
  console.log(`Seeded schedule template "${template.name}" with id: ${template.templateId}`);
  console.log(`  visibility: ${template.visibility} | category: ${template.category}`);
  console.log(`  variables:  ${template.variables.map((v) => v.name).join(', ')}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
