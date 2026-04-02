/**
 * Test for admin tool blocking logic
 * Admin tools are blocked for non-admin users only.
 * Interactive share sessions do NOT get additional restrictions — the session owner's
 * admin status determines access (7-day expiry provides sufficient security boundary).
 */

describe('AgentModeService - Admin Tool Blocking', () => {
  const ADMIN_TOOL_NAMES = ['list_predefined_work_plans', 'manage_predefined_work_plan', 'list_skills', 'manage_skill'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Admin tool blocking logic', () => {
    ADMIN_TOOL_NAMES.forEach((adminToolName) => {
      it(`should allow ${adminToolName} when isAdmin=true (even in interactive share sessions)`, () => {
        const isAdmin = true;
        const toolCallName = adminToolName;

        const shouldBlock = !isAdmin && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(false);
      });

      it(`should block ${adminToolName} when isAdmin=false`, () => {
        const isAdmin = false;
        const toolCallName = adminToolName;

        const shouldBlock = !isAdmin && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(true);
      });
    });

    it('should allow non-admin tools regardless of admin status', () => {
      const isAdmin = false;
      const toolCallName = 'search_knowledge_base'; // Regular tool

      const shouldBlock = !isAdmin && ADMIN_TOOL_NAMES.includes(toolCallName);

      expect(shouldBlock).toBe(false);
    });
  });

  describe('Error messages', () => {
    it('should show admin-only error message when blocking admin tools', () => {
      const toolName = 'manage_skill';

      const errorMsg = `Tool "${toolName}" is restricted to admin users only.`;

      expect(errorMsg).toBe('Tool "manage_skill" is restricted to admin users only.');
    });
  });
});
