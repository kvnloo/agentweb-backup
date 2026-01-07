
import { ToolService } from '../../tools/ServiceRegistry';
import { dynamodb } from '../db';
import { v4 as uuidv4 } from 'uuid';

/**
 * GTM Service
 * Manages Go-to-Market plans
 */
export class GTMService implements ToolService {
  readonly serviceName = 'gtm';
  
  private getTableName() {
    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    return `${TABLE_PREFIX}AW-GTMPlan`;
  }

  /**
   * List all GTM plans for a user
   */
  async listGTMPlans(userId: string): Promise<any> {
    try {
      const TABLE_NAME = this.getTableName();

      const result = await dynamodb
        .query({
          TableName: TABLE_NAME,
          IndexName: "UserIdIndex",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: {
            ":userId": userId,
          },
          ScanIndexForward: false, // Sort by createdAt descending (newest first)
        })
        .promise();

      const plans = result.Items || [];

      return {
        success: true,
        message: `Found ${plans.length} GTM plan(s)`,
        plans: plans.map((plan: any) => ({
          planId: plan.planId,
          title: plan.title,
          description: plan.description || '',
          phaseCount: plan.phases?.length || 0,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        })),
        totalPlans: plans.length
      };
    } catch (error) {
      console.error('GTMService: Error listing GTM plans:', error);
      return {
        success: false,
        message: 'Failed to list GTM plans',
        error: error instanceof Error ? error.message : 'Unknown error',
        plans: [],
        totalPlans: 0
      };
    }
  }

  /**
   * Read a specific GTM plan
   */
  async readGTMPlan(planId: string, userId: string): Promise<any> {
    try {
      const TABLE_NAME = this.getTableName();

      const result = await dynamodb
        .get({
          TableName: TABLE_NAME,
          Key: {
            planId: planId,
          },
        })
        .promise();

      if (!result.Item) {
        return {
          success: false,
          message: 'GTM plan not found',
          exists: false,
          error: 'GTM plan not found'
        };
      }

      // Verify the plan belongs to the user
      if (result.Item.userId !== userId) {
        return {
          success: false,
          message: 'Access denied',
          exists: false,
          error: 'Access denied'
        };
      }

      const plan = result.Item;

      // Calculate plan status based on phases
      const hasPhases = plan.phases && plan.phases.length > 0;
      const allPhasesCompleted = hasPhases && plan.phases.every(
        (phase: any) => phase.status === "completed"
      );
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      // Format the plan for LLM consumption
      let formattedContent = `GTM Plan: ${plan.title}\n`;
      if (plan.description) {
        formattedContent += `Description: ${plan.description}\n`;
      }
      if (plan.dri) {
        formattedContent += `DRI (Plan Level): ${plan.dri}\n`;
      }
      formattedContent += `Status: ${planStatus}\n`;
      formattedContent += `Created: ${plan.createdAt}\n`;
      formattedContent += `Updated: ${plan.updatedAt}\n`;
      if (planStatus === "completed" && plan.completedAt) {
        formattedContent += `Completed: ${plan.completedAt}\n`;
      }
      formattedContent += `\n`;
      formattedContent += `Phases (${plan.phases?.length || 0}):\n\n`;

      if (plan.phases && plan.phases.length > 0) {
        plan.phases.forEach((phase: any, index: number) => {
          formattedContent += `Phase ${index + 1}: ${phase.title}\n`;
          if (phase.description) {
            formattedContent += `  Description: ${phase.description}\n`;
          }
          if (phase.dri) {
            formattedContent += `  DRI: ${phase.dri}\n`;
          }
          formattedContent += `  Duration: ${phase.duration} day(s)\n`;
          formattedContent += `  Status: ${phase.status}\n`;
          formattedContent += `  Work Items (${phase.workItems?.length || 0}):\n`;

          if (phase.workItems && phase.workItems.length > 0) {
            phase.workItems.forEach((item: any, itemIndex: number) => {
              formattedContent += `    ${itemIndex + 1}. ${item.title} [${item.status}]`;
              if (item.duration !== undefined) {
                formattedContent += ` - ${item.duration} day(s)`;
              }
              if (item.dri) {
                formattedContent += ` - DRI: ${item.dri}`;
              }
              if (item.completedAt) {
                formattedContent += ` - Completed: ${item.completedAt}`;
              }
              formattedContent += `\n`;
              if (item.description) {
                formattedContent += `       ${item.description}\n`;
              }
              if (item.note) {
                formattedContent += `       Note: ${item.note}\n`;
              }
            });
          }
          formattedContent += `\n`;
        });
      } else {
        formattedContent += `No phases yet.\n`;
      }

      return {
        success: true,
        message: `GTM plan "${plan.title}" retrieved successfully`,
        exists: true,
        plan: plan,
        formattedContent
      };
    } catch (error) {
      console.error('GTMService: Error reading GTM plan:', error);
      return {
        success: false,
        message: 'Failed to read GTM plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create a new GTM plan
   */
  async createGTMPlan(title: string, description: string, dri: string | undefined, phases: any[], userId: string): Promise<any> {
    try {
      const TABLE_NAME = this.getTableName();

      const planId = `plan-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const now = new Date().toISOString();

      // Process phases and work items
      const processedPhases = (phases || []).map((phase: any, phaseIndex: number) => {
        const phaseId = `phase-${Date.now()}-${phaseIndex}-${Math.random().toString(36).substring(2, 11)}`;

        // Process work items for this phase
        const processedWorkItems = (phase.workItems || []).map((item: any, itemIndex: number) => ({
          id: `workitem-${Date.now()}-${phaseIndex}-${itemIndex}-${Math.random().toString(36).substring(2, 11)}`,
          title: item.title,
          description: item.description || "",
          duration: item.duration !== undefined ? item.duration : undefined,
          dri: item.dri || undefined, // DRI at work item level
          status: "pending" as const,
        }));

        // Determine phase status based on work items
        const hasWorkItems = processedWorkItems.length > 0;
        const allItemsDone = hasWorkItems && processedWorkItems.every(
          (item: any) => item.status === "completed" || item.status === "skipped"
        );

        return {
          id: phaseId,
          title: phase.title,
          description: phase.description || "",
          duration: phase.duration || 1,
          dri: phase.dri || undefined, // DRI at phase level
          status: allItemsDone ? "completed" : "in_progress" as const,
          workItems: processedWorkItems,
        };
      });

      // Calculate plan status based on phases
      const hasPhases = processedPhases && processedPhases.length > 0;
      const allPhasesCompleted = hasPhases && processedPhases.every(
        (phase: any) => phase.status === "completed"
      );
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      const newPlan = {
        planId,
        userId,
        title,
        description: description || "",
        dri: dri || undefined, // DRI at plan level
        status: planStatus,
        phases: processedPhases,
        createdAt: now,
        updatedAt: now,
      };

      const params = {
        TableName: TABLE_NAME,
        Item: newPlan,
      };

      await dynamodb.put(params).promise();

      return {
        success: true,
        message: `GTM plan "${title}" created successfully with ${processedPhases.length} phases`,
        planId: planId,
        plan: newPlan
      };

    } catch (error) {
      console.error('GTMService: Error creating GTM plan:', error);
      return {
        success: false,
        message: 'Failed to create GTM plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Singleton instance
export const gtmService = new GTMService();
