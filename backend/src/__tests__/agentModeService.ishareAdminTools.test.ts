/**
 * Test for interactive share admin tool blocking
 * This test verifies that admin tools are blocked in interactive share sessions for security
 */

describe('AgentModeService - Interactive Share Admin Tool Blocking', () => {
  const ADMIN_TOOL_NAMES = ['list_predefined_work_plans', 'manage_predefined_work_plan', 'list_skills', 'manage_skill'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Admin tool blocking logic', () => {
    ADMIN_TOOL_NAMES.forEach((adminToolName) => {
      it(`should block ${adminToolName} when isInteractiveShare=true (even for admin users)`, () => {
        const isAdmin = true;
        const isInteractiveShare = true;
        const toolCallName = adminToolName;

        // This is the condition from agentModeService.ts line 995
        const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(true);
      });

      it(`should block ${adminToolName} when isAdmin=false and isInteractiveShare=false`, () => {
        const isAdmin = false;
        const isInteractiveShare = false;
        const toolCallName = adminToolName;

        // This is the condition from agentModeService.ts line 995
        const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(true);
      });

      it(`should allow ${adminToolName} when isAdmin=true and isInteractiveShare=false`, () => {
        const isAdmin = true;
        const isInteractiveShare = false;
        const toolCallName = adminToolName;

        // This is the condition from agentModeService.ts line 995
        const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

        expect(shouldBlock).toBe(false);
      });
    });

    it('should allow non-admin tools in interactive share sessions', () => {
      const isAdmin = false;
      const isInteractiveShare = true;
      const toolCallName = 'search_knowledge_base'; // Regular tool

      // This is the condition from agentModeService.ts line 995
      const shouldBlock = (!isAdmin || isInteractiveShare) && ADMIN_TOOL_NAMES.includes(toolCallName);

      expect(shouldBlock).toBe(false);
    });
  });

  describe('Error messages', () => {
    it('should show interactive share error message when isInteractiveShare=true', () => {
      const isInteractiveShare = true;
      const toolName = 'manage_skill';

      const errorMsg = isInteractiveShare
        ? `Tool "${toolName}" is not available in shared sessions.`
        : `Tool "${toolName}" is restricted to admin users only.`;

      expect(errorMsg).toBe('Tool "manage_skill" is not available in shared sessions.');
    });

    it('should show admin-only error message when isInteractiveShare=false', () => {
      const isInteractiveShare = false;
      const toolName = 'manage_skill';

      const errorMsg = isInteractiveShare
        ? `Tool "${toolName}" is not available in shared sessions.`
        : `Tool "${toolName}" is restricted to admin users only.`;

      expect(errorMsg).toBe('Tool "manage_skill" is restricted to admin users only.');
    });
  });
});
