/**
 * ENG-2816 (step 3): a schedule a share-link visitor wrote content into never publishes unattended.
 *
 * The legacy default reads a schedule that was never asked about consent as AUTHORIZED, scoped to the publish tools its
 * `requiredFunctionCalls` names (ENG-803's opt-out polarity, kept so no existing schedule changes behaviour). A visitor can write
 * `requiredFunctionCalls: ['post_on_connected_account']` onto a schedule through the owner's userId, which that default would read as
 * the owner's consent to post to their connected accounts unattended. A marked schedule therefore resolves to the reversible
 * draft-and-notify outcome, whatever else it says, until the owner adopts it.
 */
import {
  describePublishAuthorizationWithholdReason,
  resolveSchedulePublishAuthorization,
} from '../utils/schedulePublishAuthorization';
import { resolvePublishAuthorized } from '../utils/schedulePublishApproval';

// (The shared aws-sdk mock has no createSet, so build the set with the real SDK.)
const realSet = (members: string[]) => new (jest.requireActual('aws-sdk').DynamoDB.DocumentClient)({ region: 'us-west-2' }).createSet(members);

const publishing = { requiredFunctionCalls: ['post_on_connected_account'] };

describe('publish authorization of a marked schedule (ENG-2816 step 3)', () => {
  it('an UNMARKED legacy schedule that requires a publish tool is still authorized (nothing changes for existing schedules)', () => {
    expect(resolveSchedulePublishAuthorization({ ...publishing })).toEqual({ authorized: true, tools: ['post_on_connected_account'] });
    expect(resolvePublishAuthorized({ ...publishing } as any)).toBe(true);
    // Absent, empty and a never-asked row are all the same unmarked schedule.
    expect(resolveSchedulePublishAuthorization({ ...publishing, provenance: undefined }).authorized).toBe(true);
    expect(resolveSchedulePublishAuthorization({ ...publishing, provenance: [] }).authorized).toBe(true);
  });

  it('a MARKED schedule is unauthorized under the legacy default, however its requiredFunctionCalls read', () => {
    for (const provenance of [['requiredFunctionCalls'], ['startingMessage'], realSet(['keywords'])]) {
      expect(resolveSchedulePublishAuthorization({ ...publishing, provenance })).toEqual({ authorized: false, tools: [] });
      expect(resolvePublishAuthorized({ ...publishing, provenance } as any)).toBe(false);
    }
  });

  it('a MARKED schedule is unauthorized even with an explicit grant (the grant predates, or never saw, the visitor content)', () => {
    const granted = { ...publishing, autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account'] };
    expect(resolveSchedulePublishAuthorization(granted).authorized).toBe(true);
    expect(resolveSchedulePublishAuthorization({ ...granted, provenance: ['startingMessage'] })).toEqual({ authorized: false, tools: [] });
  });

  it('an unreadable provenance value counts as marked (fails closed)', () => {
    expect(resolveSchedulePublishAuthorization({ ...publishing, provenance: 17 }).authorized).toBe(false);
  });

  it('the reason is "visitor_edited": a grant or a toggle would not lift it', () => {
    const marked = { ...publishing, provenance: ['startingMessage'] };
    expect(describePublishAuthorizationWithholdReason(marked)).toBe('visitor_edited');
    // Even a schedule that also holds, or was revoked, reports the one reason that matters first.
    expect(describePublishAuthorizationWithholdReason({ ...marked, requirePublishApproval: true })).toBe('visitor_edited');
    expect(describePublishAuthorizationWithholdReason({ ...marked, autopublishAuthorized: false })).toBe('visitor_edited');
  });

  it('the reasons for an UNMARKED schedule are unchanged', () => {
    expect(describePublishAuthorizationWithholdReason({ requiredFunctionCalls: [] })).toBe('not_granted');
    expect(describePublishAuthorizationWithholdReason({ ...publishing, requirePublishApproval: true })).toBe('require_publish_approval');
    expect(describePublishAuthorizationWithholdReason({ ...publishing, autopublishAuthorized: false })).toBe('revoked');
    expect(describePublishAuthorizationWithholdReason({ ...publishing })).toBeUndefined();
  });

  it('a missing schedule is still unauthorized (unchanged)', () => {
    expect(resolveSchedulePublishAuthorization(null)).toEqual({ authorized: false, tools: [] });
    expect(resolveSchedulePublishAuthorization(undefined)).toEqual({ authorized: false, tools: [] });
  });
});
