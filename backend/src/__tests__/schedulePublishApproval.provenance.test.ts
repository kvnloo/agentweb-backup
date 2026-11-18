/**
 * ENG-2816 (step 3): every "unattended default = authorized" gate treats a schedule a share-link visitor wrote into as WITHHELD.
 *
 * These gates default to AUTHORIZED (an absent opt-out means "may"), which is right for the owner's own schedules and exactly wrong
 * for one whose content a visitor wrote under the owner's userId: it would let that content send Slack messages to the owner's
 * channels, run with the owner's irreversible-decision waiver, and so on. The publish gate is covered in
 * schedulePublishAuthorization.provenance.test.ts; this covers the rest of the family.
 */
import {
  describeSlackSendState,
  filterSlackSendFromRequiredIfWithheld,
  resolveSlackSendAuthorized,
} from '../utils/schedulePublishApproval';
import { autonomyWaiverApplies } from '../utils/scheduleProvenance';
import { getUnattendedExecutionDirective } from '../docs/agentModeSystemPrompt';

const realSet = (members: string[]) => new (jest.requireActual('aws-sdk').DynamoDB.DocumentClient)({ region: 'us-west-2' }).createSet(members);

describe('Slack-send gate (ENG-2204 default: authorized)', () => {
  it('an UNMARKED schedule is exactly as before', () => {
    expect(resolveSlackSendAuthorized({})).toBe(true);
    expect(resolveSlackSendAuthorized({ requireSlackApproval: false })).toBe(true);
    expect(resolveSlackSendAuthorized({ requireSlackApproval: true })).toBe(false);
    expect(resolveSlackSendAuthorized({ provenance: undefined })).toBe(true);
    expect(resolveSlackSendAuthorized({ provenance: [] })).toBe(true);
    expect(resolveSlackSendAuthorized(null)).toBe(false);
    expect(resolveSlackSendAuthorized(undefined)).toBe(false);
  });

  it('a MARKED schedule is withheld, whatever the owner\'s setting says (array, real Set and unreadable alike)', () => {
    for (const provenance of [['startingMessage'], realSet(['keywords']), 17]) {
      expect(resolveSlackSendAuthorized({ provenance })).toBe(false);
      expect(resolveSlackSendAuthorized({ provenance, requireSlackApproval: false })).toBe(false);
    }
  });

  it('says WHY: "visitor_edited" for a marked schedule, nothing extra for the owner\'s own opt-out', () => {
    expect(describeSlackSendState({ provenance: ['keywords'] })).toEqual({ authorized: false, reason: 'visitor_edited' });
    expect(describeSlackSendState({ provenance: ['keywords'], requireSlackApproval: true })).toEqual({ authorized: false, reason: 'visitor_edited' });
    expect(describeSlackSendState({ requireSlackApproval: true })).toEqual({ authorized: false });
    expect(describeSlackSendState({})).toEqual({ authorized: true });
    expect(describeSlackSendState(null)).toEqual({ authorized: false });
  });

  it('the required-call filter drops slack_send_message for a marked schedule (no nagging for a send the run is told not to make)', () => {
    const required = ['get_marketing_tips', 'slack_send_message'];
    expect(filterSlackSendFromRequiredIfWithheld(required, resolveSlackSendAuthorized({ provenance: ['startingMessage'] }))).toEqual(['get_marketing_tips']);
    expect(filterSlackSendFromRequiredIfWithheld(required, resolveSlackSendAuthorized({}))).toEqual(required);
  });
});

describe('the unattended directive tells the model the TRUE reason Slack is withheld', () => {
  const directive = (...args: [boolean, ('visitor_edited' | undefined)?]) =>
    getUnattendedExecutionDirective('scheduled', false, 'authorized', ['post_on_connected_account'], ...args);

  it('authorized: the live-approval bypass is there', () => {
    expect(directive(true)).toContain('SLACK NOTIFICATIONS IN UNATTENDED RUNS (CRITICAL');
    expect(directive(true)).not.toContain('WITHHELD (CRITICAL — ENG-2204)');
  });

  it('withheld by the owner\'s own setting: the text is unchanged', () => {
    const text = directive(false);
    expect(text).toContain('SLACK NOTIFICATIONS IN UNATTENDED RUNS — WITHHELD (CRITICAL — ENG-2204)');
    expect(text).toContain('The owner has turned ON "Require approval before Slack sends" for this schedule.');
    expect(text).toContain('because this schedule requires approval before Slack sends.');
  });

  it('withheld because a visitor wrote the schedule: says so, and does not blame a setting the owner never touched', () => {
    const text = directive(false, 'visitor_edited');
    expect(text).toContain('WITHHELD (CRITICAL — ENG-2204)');
    expect(text).toContain('set up or edited through a share link and has not been adopted by its owner');
    expect(text).toContain('the owner can adopt it in the portal');
    expect(text).not.toContain('The owner has turned ON "Require approval before Slack sends"');
  });
});

describe('owner\'s full-autonomy waiver (ENG-396)', () => {
  it('applies to the owner\'s own schedule, exactly as before', () => {
    expect(autonomyWaiverApplies({ fullAutonomy: true })).toBe(true);
    expect(autonomyWaiverApplies({ fullAutonomy: false })).toBe(false);
    expect(autonomyWaiverApplies({})).toBe(false);
    expect(autonomyWaiverApplies({ fullAutonomy: true, provenance: [] })).toBe(true);
    expect(autonomyWaiverApplies(null)).toBe(false);
  });

  it('does NOT carry over to a schedule a share-link visitor wrote into (it was given for a prompt the owner wrote)', () => {
    expect(autonomyWaiverApplies({ fullAutonomy: true, provenance: ['startingMessage'] })).toBe(false);
    expect(autonomyWaiverApplies({ fullAutonomy: true, provenance: realSet(['keywords']) })).toBe(false);
    expect(autonomyWaiverApplies({ fullAutonomy: true, provenance: 17 })).toBe(false);
  });
});
