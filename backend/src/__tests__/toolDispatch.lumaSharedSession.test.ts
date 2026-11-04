// ENG-2737: a Luma API key can be shared with the whole organisation. A share-link visitor runs as the link's owner, so the Luma tools would
// reach every org-shared key (guests' registration answers and phone numbers included). Both are refused in shared sessions, like the
// Smartlead tools.
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

describe('Luma tools in shared (share-link) sessions', () => {
  it('refuses both Luma tools', () => {
    for (const name of ['luma_list_events', 'luma_get_guests']) {
      expect(SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS.has(name)).toBe(true);
    }
  });

  it('names real tools, so the list cannot go stale unnoticed', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(require('path').join(__dirname, '../emma/lumaTools.ts'), 'utf8') as string;
    for (const name of ['luma_list_events', 'luma_get_guests']) {
      expect(source).toContain(`name: '${name}'`);
    }
  });
});
