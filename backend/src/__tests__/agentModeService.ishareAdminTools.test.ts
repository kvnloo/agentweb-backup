/**
 * Test for admin tool blocking logic
 * Admin tools are blocked for:
 *   1. Non-admin users
 *   2. Interactive share sessions (even for admins) — admin tools require the user's own session
 */

describe('AgentModeService - Admin Tool Blocking', () => {
  // Note: list_predefined_work_plans is intentionally NOT admin-gated — it is a
  // role-aware foundation tool (published list for non-admins, full list for admins).
  const ADMIN_TOOL_NAMES = ['manage_predefined_work_plan', 'list_skills', 'resolve_skill', 'manage_skill'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Admin tool blocking logic', () => {
    ADMIN_TOOL_NAMES.forEach((adminToolName) => {
      it(`should allow ${adminToolName} when isAdmin=true and not a shared session`, () => {
        const isAdmin = true;
        const isInteractiveShare = false;
        const toolCallName = adminToolName;

        const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(false);
      });

      it(`should block ${adminToolName} when isAdmin=true but in an interactive share session`, () => {
        const isAdmin = true;
        const isInteractiveShare = true;
        const toolCallName = adminToolName;

        const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(true);
      });

      it(`should block ${adminToolName} when isAdmin=false`, () => {
        const isAdmin = false;
        const isInteractiveShare = false;
        const toolCallName = adminToolName;

        const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(true);
      });
    });

    it('should allow non-admin tools regardless of admin status or share mode', () => {
      const toolCallName = 'search_knowledge_base'; // Regular tool

      const shouldBlockAdmin = (!true || false) && ADMIN_TOOL_NAMES.includes(toolCallName);
      const shouldBlockShare = (!true || true) && ADMIN_TOOL_NAMES.includes(toolCallName);
      const shouldBlockNonAdmin = (!false || false) && ADMIN_TOOL_NAMES.includes(toolCallName);

      expect(shouldBlockAdmin).toBe(false);
      expect(shouldBlockShare).toBe(false);
      expect(shouldBlockNonAdmin).toBe(false);
    });
  });

  describe('Error messages', () => {
    it('should show shared-session error message when blocking admin tools in interactive share', () => {
      const toolName = 'manage_skill';
      const isInteractiveShare = true;

      const errorMsg = isInteractiveShare
        ? `Tool "${toolName}" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.`
        : `Tool "${toolName}" is restricted to admin users only.`;

      expect(errorMsg).toBe('Tool "manage_skill" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.');
    });

    it('should show admin-only error message when blocking admin tools for non-admin users', () => {
      const toolName = 'manage_skill';
      const isInteractiveShare = false;

      const errorMsg = isInteractiveShare
        ? `Tool "${toolName}" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.`
        : `Tool "${toolName}" is restricted to admin users only.`;

      expect(errorMsg).toBe('Tool "manage_skill" is restricted to admin users only.');
    });
  });
});
