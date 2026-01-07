
import { ToolService } from '../../tools/ServiceRegistry';
import { chatbotDb } from '../chatbotService';

/**
 * Automation Service
 * Manages work plans and automation tasks.
 */
export class AutomationService implements ToolService {
  readonly serviceName = 'automation';

  /**
   * Create a work plan
   */
  async createWorkPlan(
    title: string, 
    steps: Array<{ stepCount: number; title: string; description?: string; requiredFunctionCalls?: string[] }>, 
    sessionId: string
  ): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return {
          success: false,
          message: 'Session not found'
        };
      }

      // Create the work plan with all steps in pending status
      // Ensure stepCount is sequential starting from 1
      const workPlan = {
        title,
        steps: steps.map((step, index) => ({
          stepCount: index + 1, // Must be sequential: index+1
          title: step.title,
          description: step.description,
          status: 'pending' as const,
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: step.requiredFunctionCalls
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Update the session with the work plan
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: `Work plan "${title}" created with ${steps.length} steps`,
        workPlan,
        formattedContent: `Created work plan "${title}" with ${steps.length} steps:\n${workPlan.steps.map(s => `${s.stepCount}. ${s.title}`).join('\n')}`
      };
    } catch (error) {
      console.error('AutomationService: Error creating work plan:', error);
      return {
        success: false,
        message: 'Failed to create work plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Modify a work plan
   */
  async modifyWorkPlan(
    steps: Array<{ stepCount: number; title: string; description?: string; requiredFunctionCalls?: string[] }>, 
    removeStepCounts: number[], 
    sessionId: string
  ): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.workPlan) {
        return {
          success: false,
          message: 'No work plan found in this session. Create one first using create_work_plan.'
        };
      }

      const workPlan = { ...session.workPlan };

      // Remove steps if specified
      if (removeStepCounts && removeStepCounts.length > 0) {
        workPlan.steps = workPlan.steps.filter(s => !removeStepCounts.includes(s.stepCount));
      }

      // Update or add steps
      for (const newStep of steps) {
        const existingIndex = workPlan.steps.findIndex(s => s.stepCount === newStep.stepCount);
        if (existingIndex >= 0) {
          // Update existing step (preserve status and completion info)
          workPlan.steps[existingIndex] = {
            ...workPlan.steps[existingIndex],
            title: newStep.title,
            description: newStep.description,
            requiredFunctionCalls: newStep.requiredFunctionCalls
          };
        } else {
          // Add new step
          workPlan.steps.push({
            stepCount: newStep.stepCount,
            title: newStep.title,
            description: newStep.description,
            status: 'pending' as const,
            completedAt: undefined,
            notes: undefined,
            requiredFunctionCalls: newStep.requiredFunctionCalls
          });
        }
      }

      // Sort steps by stepCount
      workPlan.steps.sort((a, b) => a.stepCount - b.stepCount);
      workPlan.updatedAt = new Date().toISOString();

      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: 'Work plan modified successfully',
        workPlan
      };

    } catch (error) {
      console.error('AutomationService: Error modifying work plan:', error);
      return {
        success: false,
        message: 'Failed to modify work plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Set work plan status
   */
  async setWorkPlanStatus(
    updates: Array<{ stepCount: number; status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'; notes?: string }>, 
    sessionId: string
  ): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.workPlan) {
        return {
          success: false,
          message: 'No work plan found in this session.'
        };
      }

      const workPlan = { ...session.workPlan };
      let updatedCount = 0;

      for (const update of updates) {
        const stepIndex = workPlan.steps.findIndex(s => s.stepCount === update.stepCount);
        if (stepIndex >= 0) {
          workPlan.steps[stepIndex].status = update.status;
          if (update.notes) {
            workPlan.steps[stepIndex].notes = update.notes;
          }
          if (update.status === 'completed' || update.status === 'skipped') {
            workPlan.steps[stepIndex].completedAt = new Date().toISOString();
          }
          updatedCount++;
        }
      }

      if (updatedCount === 0) {
        return {
          success: false,
          message: 'No matching steps found to update'
        };
      }

      workPlan.updatedAt = new Date().toISOString();
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: `Updated status for ${updatedCount} steps`,
        workPlan
      };
    } catch (error) {
      console.error('AutomationService: Error setting work plan status:', error);
      return {
        success: false,
        message: 'Failed to set work plan status',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Singleton instance
export const automationService = new AutomationService();
