/**
 * ENG-2816 (step 3): the `share_visitor_schedule` profile, for scheduled runs of a schedule a share-link visitor set up or edited.
 * It refuses exactly what `share_visitor` refuses, in its own words. The `share_visitor` wording must not move: the share-session
 * refusal eval keys on "is not available in shared sessions".
 */
import {
  SHARE_VISITOR_BLOCKED_TOOLS,
  SHARE_VISITOR_SCHEDULE_PROFILE,
  isKnownRestrictionProfile,
  restrictionRefusal,
  scheduleProvenanceUnverifiableRefusal,
} from '../services/toolRestrictionProfiles';

const ADMIN = ['read_linear_issues', 'manage_skill'];

describe('share_visitor wording is unchanged (an eval depends on it, byte for byte)', () => {
  it('admin tool', () => {
    expect(restrictionRefusal('share_visitor', 'manage_skill', ADMIN)).toBe(
      'Tool "manage_skill" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.'
    );
  });
  it('owner settings or memory tool', () => {
    expect(restrictionRefusal('share_visitor', 'save_memory', ADMIN)).toBe(
      'Tool "save_memory" acts on the owner\'s organization settings or memory and is not available in shared sessions. The owner can use it in Agent Mode in their own session.'
    );
  });
  it('connect_account', () => {
    expect(restrictionRefusal('share_visitor', 'connect_account', ADMIN)).toBe(
      'Account connections are not available in shared sessions. Tell the user they need to open Agent Mode in their own account to connect this account, then come back here.'
    );
  });
});

describe('share_visitor_schedule', () => {
  it('refuses exactly the same tools as share_visitor: every blocked tool, every admin tool name, connect_account', () => {
    const names = [...SHARE_VISITOR_BLOCKED_TOOLS, ...ADMIN, 'connect_account'];
    for (const name of names) {
      expect(restrictionRefusal('share_visitor', name, ADMIN)).not.toBeNull();
      expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, name, ADMIN)).not.toBeNull();
    }
  });

  it('allows every tool share_visitor allows', () => {
    for (const name of ['notify_session', 'manage_scheduled_chat', 'you_search_web', 'post_on_connected_account']) {
      expect(restrictionRefusal('share_visitor', name, ADMIN)).toBeNull();
      expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, name, ADMIN)).toBeNull();
    }
  });

  it('says the schedule was set up or edited through a share link and that the owner can adopt it, never "shared sessions"', () => {
    for (const name of ['manage_skill', 'save_memory', 'connect_account']) {
      const text = restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, name, ADMIN)!;
      expect(text).toContain('set up or edited through a share link');
      expect(text).toContain('adopt');
      expect(text).not.toContain('shared sessions');
    }
  });

  it('names the tool it refused', () => {
    expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, 'luma_get_guests', ADMIN)).toContain('"luma_get_guests"');
  });

  it('is a known profile id; unknown, empty and prototype names are not', () => {
    expect(isKnownRestrictionProfile('share_visitor')).toBe(true);
    expect(isKnownRestrictionProfile('share_visitor_schedule')).toBe(true);
    for (const value of ['', 'owner', 'constructor', '__proto__', 'toString', undefined, null, 7, {}]) {
      expect(isKnownRestrictionProfile(value)).toBe(false);
    }
  });

  it('an unknown profile id still fails closed to the strictest known profile (unchanged)', () => {
    expect(restrictionRefusal('something-new', 'save_memory', ADMIN)).toContain('shared sessions');
  });

  it('the unverifiable refusal names the tool and says nothing was done', () => {
    const text = scheduleProvenanceUnverifiableRefusal('save_memory');
    expect(text).toContain('"save_memory"');
    expect(text).toContain('could not be verified');
    expect(text).toContain('Nothing was done');
  });
});
