// ENG-2816: the share-visitor restriction profile, the one source of truth for what a share-link visitor may not run.
import { restrictionRefusal, SHARE_VISITOR_BLOCKED_TOOLS } from '../services/toolRestrictionProfiles';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

const ADMIN = ['get_user_by_id', 'list_all_clients', 'freeze_user_account'];

describe('restrictionRefusal', () => {
  it('no profile means no restriction, whatever the tool', () => {
    for (const profile of [undefined, null, false, '']) {
      expect(restrictionRefusal(profile, 'save_memory', ADMIN)).toBeNull();
      expect(restrictionRefusal(profile, 'get_user_by_id', ADMIN)).toBeNull();
      expect(restrictionRefusal(profile, 'connect_account', ADMIN)).toBeNull();
    }
  });

  it('share_visitor refuses every tool on the owner-only block list, in the wording the refusal eval keys on', () => {
    expect(SHARE_VISITOR_BLOCKED_TOOLS.size).toBeGreaterThan(20);
    for (const tool of SHARE_VISITOR_BLOCKED_TOOLS) {
      const refusal = restrictionRefusal('share_visitor', tool, ADMIN);
      expect(refusal).toContain(`Tool "${tool}" acts on the owner's organization settings or memory and is not available in shared sessions.`);
    }
  });

  it('share_visitor refuses admin tools and connect_account with their own wording', () => {
    expect(restrictionRefusal('share_visitor', 'get_user_by_id', ADMIN))
      .toBe('Tool "get_user_by_id" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.');
    expect(restrictionRefusal('share_visitor', 'connect_account', ADMIN))
      .toBe('Account connections are not available in shared sessions. Tell the user they need to open Agent Mode in their own account to connect this account, then come back here.');
  });

  it('share_visitor leaves every other tool alone', () => {
    for (const tool of ['search_web', 'read_brand_guidelines', 'manage_scheduled_chat', 'list_scheduled_chats', 'create_work_plan']) {
      expect(restrictionRefusal('share_visitor', tool, ADMIN)).toBeNull();
    }
  });

  it('keeps the owner-only block list the typed-chat preflight has always used (same set, one source)', () => {
    expect(SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS).toBe(SHARE_VISITOR_BLOCKED_TOOLS);
    for (const tool of ['save_memory', 'delete_memory', 'save_org_memory', 'start_smartlead_push', 'luma_get_guests', 'update_lead_notification_settings']) {
      expect(SHARE_VISITOR_BLOCKED_TOOLS.has(tool)).toBe(true);
    }
  });

  it('an unrecognised profile id is treated as the strictest known profile, never as no restriction', () => {
    expect(restrictionRefusal('share-visitor', 'save_memory', ADMIN)).not.toBeNull();
    expect(restrictionRefusal(true, 'save_memory', ADMIN)).not.toBeNull();
    expect(restrictionRefusal({}, 'get_user_by_id', ADMIN)).not.toBeNull();
  });

  it('an id that names something on Object.prototype does not resolve to it', () => {
    expect(restrictionRefusal('constructor', 'save_memory', ADMIN)).not.toBeNull();
    expect(restrictionRefusal('__proto__', 'save_memory', ADMIN)).not.toBeNull();
    expect(restrictionRefusal('toString', 'connect_account', ADMIN)).not.toBeNull();
  });
});
