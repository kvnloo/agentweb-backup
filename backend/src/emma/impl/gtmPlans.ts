/**
 * ENG-2103 (F2) — GTM plans tool cluster, extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * listGTMPlans, readGTMPlan, createGTMPlan, updateGTMPlan, addGTMPhase,
 * addGTMWorkItems, updateGTMWorkItem, updateGTMPhase, deleteGTMItems,
 * getGTMCommonItems, addGTMCommonItems, sendGTMStatusReport. 12 of the 134
 * `agentModeService.<method>()` names `emma/tools.ts` calls into (ENG-1816 F1's
 * design draft, §2) — the second domain cluster after books/whitepapers (F2's
 * pilot). Picked next because it has ZERO `this.`/instance-state dependencies
 * anywhere in the cluster (cleaner than the books pilot's two) — the only real
 * coupling is two lazily-loaded module-level singletons, both handled below.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions rather
 * than duplicating them — `__tests__/agentModeService.gtmPlan.test.ts` calls
 * `(agentModeService as any).<method>(...)` directly on a real instance (a real
 * second caller beyond `emma/tools.ts`, same discipline that found
 * `routes/emmaApi.ts`'s `/books*` endpoints for the books cluster), so the class
 * methods could not simply be deleted. No `routes/*.ts` file calls any of these
 * 12 methods directly (grepped the whole backend) — `routes/gtmPlan.ts` only
 * calls the unrelated `agentModeService.getDefaultModel()`.
 *
 * No metering/LLM calls anywhere in this cluster (grepped for llmService,
 * generateJSONContent, callLLM, meterUserUsage, currentRunFunding, usageContext —
 * zero matches), so the RunFunding/billingUserId audit (F1 rounds 3-5's bug
 * class) has nothing to check here: nothing in this cluster reaches
 * meterWithResolvedBilling or any other metering sink.
 *
 * Two lazy-load points, both matching the existing idiom elsewhere in this repo
 * (ENG-1816 F1's `lesson-lazy-require-aws-sdk-modules`):
 *  - `settingsService` (getGTMCommonItems) constructs a real
 *    AWS.DynamoDB.DocumentClient at module load — lazy-`require`'d.
 *  - `chatbotDb` (createGTMPlan) — chatbotService.ts constructs a real
 *    AWS.DynamoDB.DocumentClient at module load AND top-level-imports
 *    agentModeService.ts back in (circular). The ORIGINAL code imported this at
 *    the top of agentModeService.ts (safe there, since that file already pulls
 *    in everything); a static import here would reintroduce exactly the
 *    transitive-import trap the extraction exists to avoid, so it is
 *    lazy-`require`'d instead — a second real instance of the same trap F1's
 *    postmortem describes, found by tracing this cluster's imports rather than
 *    assumed absent.
 *  - `userDb` (createGTMPlan) and `sendGTMPlanUpdateNotifications`/
 *    `sendPhaseStatusReport`/`sendPlanStatusReport` (updateGTMWorkItem,
 *    sendGTMStatusReport) were ALREADY lazily `await import(...)`-ed in the
 *    original code; preserved as-is, only the relative path changed.
 */

function getDynamoDbTableName(): string {
  const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
  return `${TABLE_PREFIX}AW-GTMPlan`;
}

async function getDynamoDbClient() {
  const { DynamoDB } = await import('aws-sdk');
  return new DynamoDB.DocumentClient({
    region: process.env.AWS_REGION || "us-west-2",
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    }),
  });
}

export async function listGTMPlans(userId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

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
    console.error('AgentMode: Error listing GTM plans:', error);
    return {
      success: false,
      message: 'Failed to list GTM plans',
      error: error instanceof Error ? error.message : 'Unknown error',
      plans: [],
      totalPlans: 0
    };
  }
}

// Read a specific GTM plan
export async function readGTMPlan(planId: string, userId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

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
        // ENG-1816 F2 follow-up: expose the phase's real id (what add_gtm_work_items/
        // update_gtm_phase/delete_gtm_items actually key off) alongside its display
        // number. Appended after the title, not between "Phase N:" and the title, so
        // existing formattedContent.toContain('Phase 1: Phase 1')-style assertions
        // (which check that exact prefix) keep matching.
        formattedContent += `Phase ${index + 1}: ${phase.title} (id: ${phase.id})\n`;
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
            // Same reasoning as the phase id above: appended last, after every
            // existing conditional segment, so 'Work Item 1 [pending]'-style
            // assertions (title immediately followed by the status bracket)
            // still match.
            formattedContent += ` (id: ${item.id})`;
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
    console.error('AgentMode: Error reading GTM plan:', error);
    return {
      success: false,
      message: 'Failed to read GTM plan',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Create a new GTM plan
export async function createGTMPlan(title: string, description: string, dri: string | undefined, phases: any[], userId: string, sessionId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    // Determine default DRI based on delegate access
    let defaultDri: string | undefined;

    // Get session to check for delegateInfo
    //
    // Lazy require, not a top-level import: chatbotService.ts top-level-imports
    // agentModeService.ts (circular) and constructs a real
    // AWS.DynamoDB.DocumentClient at module load. A static import here would
    // drag both back into every importer of this standalone module — exactly
    // the transitive-import trap ENG-1816 F1's postmortem
    // (lesson-lazy-require-aws-sdk-modules) describes.
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    const session = await chatbotDb.getChatSession(sessionId);
    if (session?.delegateInfo?.isDelegated && session.delegateInfo.adminEmail) {
      // For delegated access, use admin's email as default DRI
      defaultDri = session.delegateInfo.adminEmail;
    } else {
      // For regular access, look up user email from database
      const { userDb } = await import('../../services/db');
      const user = await userDb.getUserById(userId);
      defaultDri = user?.email;
    }

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
      dri: dri || defaultDri || undefined, // DRI defaults to admin email (if delegated) or user email
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
      message: `GTM plan "${title}" created successfully with ${processedPhases.length} phase(s)`,
      plan: {
        planId: newPlan.planId,
        title: newPlan.title,
        description: newPlan.description,
        phaseCount: processedPhases.length,
        phases: processedPhases,
        createdAt: newPlan.createdAt,
        updatedAt: newPlan.updatedAt,
      }
    };
  } catch (error) {
    console.error('AgentMode: Error creating GTM plan:', error);
    return {
      success: false,
      message: 'Failed to create GTM plan',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Update a GTM plan (title, description, dri, dueDate)
export async function updateGTMPlan(planId: string, updates: { title?: string; description?: string; dri?: string; dueDate?: string }, userId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    if (updates.title !== undefined) {
      updateExpressions.push("#title = :title");
      expressionAttributeNames["#title"] = "title";
      expressionAttributeValues[":title"] = updates.title;
    }

    if (updates.description !== undefined) {
      updateExpressions.push("#description = :description");
      expressionAttributeNames["#description"] = "description";
      expressionAttributeValues[":description"] = updates.description;
    }

    if (updates.dri !== undefined) {
      updateExpressions.push("#dri = :dri");
      expressionAttributeNames["#dri"] = "dri";
      expressionAttributeValues[":dri"] = updates.dri || null;
    }

    if (updates.dueDate !== undefined) {
      updateExpressions.push("#dueDate = :dueDate");
      expressionAttributeNames["#dueDate"] = "dueDate";
      expressionAttributeValues[":dueDate"] = updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null;
    }

    if (updateExpressions.length === 0) {
      return { success: false, message: 'No fields to update', error: 'No fields to update' };
    }

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const updateResult = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    }).promise();

    return {
      success: true,
      message: 'GTM plan updated successfully',
      plan: updateResult.Attributes,
    };
  } catch (error) {
    console.error('AgentMode: Error updating GTM plan:', error);
    return { success: false, message: 'Failed to update GTM plan', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Add a phase to a GTM plan
export async function addGTMPhase(planId: string, phaseData: { title: string; description?: string; dri?: string; dueDate?: string; workItems?: any[] }, userId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;
    const phases = plan.phases || [];

    const phaseId = `phase-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    // Process work items if provided
    const processedWorkItems = (phaseData.workItems || []).map((item: any, itemIndex: number) => ({
      id: `item-${Date.now()}-${itemIndex}-${Math.random().toString(36).substring(2, 11)}`,
      title: item.title,
      description: item.description || null,
      dri: item.dri || null,
      status: "pending",
      notes: null,
      dueDate: item.due_date && item.due_date.trim() !== "" ? item.due_date.trim() : null,
    }));

    const newPhase = {
      id: phaseId,
      title: phaseData.title,
      description: phaseData.description || null,
      dri: phaseData.dri || null,
      status: "in_progress" as const,
      workItems: processedWorkItems,
      dueDate: phaseData.dueDate && phaseData.dueDate.trim() !== "" ? phaseData.dueDate.trim() : null,
    };

    phases.push(newPhase);

    // Recalculate plan status
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
    const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
    const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

    if (plan.status === "completed" && planStatus !== "completed") {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    const updateResult = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    }).promise();

    return {
      success: true,
      message: `Phase "${phaseData.title}" added successfully with ${processedWorkItems.length} work item(s)`,
      plan: updateResult.Attributes,
      phaseId,
    };
  } catch (error) {
    console.error('AgentMode: Error adding GTM phase:', error);
    return { success: false, message: 'Failed to add phase', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Add work items to a phase
export async function addGTMWorkItems(planId: string, phaseId: string, workItems: any[], userId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

    if (phaseIndex === -1) {
      return { success: false, message: 'Phase not found', error: 'Phase not found' };
    }

    const phase = phases[phaseIndex];
    const existingWorkItems = phase.workItems || [];

    const newWorkItems = workItems.map((item: any, itemIndex: number) => ({
      id: `item-${Date.now()}-${itemIndex}-${Math.random().toString(36).substring(2, 11)}`,
      title: item.title,
      description: item.description || null,
      dri: item.dri || null,
      status: "pending",
      notes: null,
      dueDate: item.due_date && item.due_date.trim() !== "" ? item.due_date.trim() : null,
    }));

    existingWorkItems.push(...newWorkItems);

    // Recalculate phase status
    const hasWorkItems = existingWorkItems.length > 0;
    const allItemsDone = hasWorkItems && existingWorkItems.every(
      (item: any) => item.status === "completed" || item.status === "skipped"
    );

    phases[phaseIndex] = {
      ...phase,
      workItems: existingWorkItems,
      status: allItemsDone ? "completed" : "in_progress",
    };

    // Recalculate plan status
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
    const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
    const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

    if (plan.status === "completed" && planStatus !== "completed") {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    const updateResult = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    }).promise();

    return {
      success: true,
      message: `${newWorkItems.length} work item(s) added to phase "${phase.title}"`,
      plan: updateResult.Attributes,
      addedItems: newWorkItems.map((item: any) => ({ id: item.id, title: item.title })),
    };
  } catch (error) {
    console.error('AgentMode: Error adding GTM work items:', error);
    return { success: false, message: 'Failed to add work items', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Update a work item in a GTM plan
export async function updateGTMWorkItem(
  planId: string,
  phaseId: string,
  workItemId: string,
  updates: { status?: string; notes?: string; dri?: string; title?: string; description?: string; dueDate?: string },
  notifications: { notifyUser?: boolean; notifyItemPoc?: boolean; notifyPhasePoc?: boolean; notifyPlanPoc?: boolean; message?: string },
  userId: string
): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

    if (phaseIndex === -1) {
      return { success: false, message: 'Phase not found', error: 'Phase not found' };
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);

    if (workItemIndex === -1) {
      return { success: false, message: 'Work item not found', error: 'Work item not found' };
    }

    const originalItem = workItems[workItemIndex];
    const changes: any = {};

    // Build updated work item
    const updatedWorkItem = {
      ...originalItem,
      ...(updates.status !== undefined && { status: updates.status }),
      ...(updates.notes !== undefined && { notes: updates.notes || null }),
      ...(updates.dri !== undefined && { dri: updates.dri || null }),
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.description !== undefined && { description: updates.description || null }),
      ...(updates.dueDate !== undefined && { dueDate: updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null }),
      ...(updates.status === "completed" && originalItem.status !== "completed" && { completedAt: new Date().toISOString() }),
      ...(updates.status !== undefined && updates.status !== "completed" && originalItem.status === "completed" && { completedAt: null }),
    };

    // Track changes for notifications
    if (updates.status !== undefined && updates.status !== originalItem.status) {
      changes.status = updates.status;
    }
    if (updates.notes !== undefined && updates.notes !== originalItem.notes) {
      changes.notes = updates.notes || null;
    }
    if (updates.dri !== undefined && updates.dri !== originalItem.dri) {
      changes.dri = updates.dri || null;
    }
    if (updates.dueDate !== undefined) {
      const newDueDate = updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null;
      const oldDueDate = originalItem.dueDate || null;
      if (newDueDate !== oldDueDate) {
        changes.dueDate = newDueDate;
      }
    }

    workItems[workItemIndex] = updatedWorkItem;

    // Recalculate phase status
    const hasWorkItems = workItems.length > 0;
    const allItemsDone = hasWorkItems && workItems.every(
      (item: any) => item.status === "completed" || item.status === "skipped"
    );
    phases[phaseIndex] = { ...phase, workItems, status: allItemsDone ? "completed" : "in_progress" };

    // Recalculate plan status
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const wasCompleted = plan.status === "completed";
    const isNowCompleted = planStatus === "completed";
    const justCompleted = !wasCompleted && isNowCompleted;

    const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
    const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
    const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

    if (justCompleted) {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = new Date().toISOString();
    } else if (wasCompleted && !isNowCompleted) {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    const updateResult = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    }).promise();

    // Handle notifications if requested
    if (notifications && (notifications.notifyUser || notifications.notifyItemPoc || notifications.notifyPhasePoc || notifications.notifyPlanPoc)) {
      try {
        const { sendGTMPlanUpdateNotifications } = await import('../../services/gtmPlanNotificationService');
        const updatedPlan = updateResult.Attributes as any;
        if (updatedPlan) {
          await sendGTMPlanUpdateNotifications(updatedPlan, phaseId, workItemId, changes, notifications);
        }
      } catch (notificationError: any) {
        console.error("Error sending GTM work item notifications:", notificationError);
      }
    }

    return {
      success: true,
      message: 'Work item updated successfully',
      plan: updateResult.Attributes,
    };
  } catch (error) {
    console.error('AgentMode: Error updating GTM work item:', error);
    return { success: false, message: 'Failed to update work item', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Update a phase in a GTM plan
export async function updateGTMPhase(planId: string, phaseId: string, updates: { title?: string; description?: string; dri?: string; dueDate?: string }, userId: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

    if (phaseIndex === -1) {
      return { success: false, message: 'Phase not found', error: 'Phase not found' };
    }

    const phase = phases[phaseIndex];

    if (updates.title !== undefined) phase.title = updates.title;
    if (updates.description !== undefined) phase.description = updates.description || null;
    if (updates.dri !== undefined) phase.dri = updates.dri || null;
    if (updates.dueDate !== undefined) phase.dueDate = updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null;

    phases[phaseIndex] = phase;

    const updateResult = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#phases": "phases", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    }).promise();

    return {
      success: true,
      message: `Phase "${phase.title}" updated successfully`,
      plan: updateResult.Attributes,
    };
  } catch (error) {
    console.error('AgentMode: Error updating GTM phase:', error);
    return { success: false, message: 'Failed to update phase', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Delete a GTM plan, phase, or work item
export async function deleteGTMItems(planId: string, phaseId?: string, workItemId?: string, userId?: string): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;

    // Delete entire plan
    if (!phaseId) {
      await dynamodb.delete({ TableName: TABLE_NAME, Key: { planId } }).promise();
      return { success: true, message: `GTM plan "${plan.title}" deleted successfully` };
    }

    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

    if (phaseIndex === -1) {
      return { success: false, message: 'Phase not found', error: 'Phase not found' };
    }

    // Delete work item from phase
    if (workItemId) {
      const phase = phases[phaseIndex];
      const workItems = phase.workItems || [];
      const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);

      if (workItemIndex === -1) {
        return { success: false, message: 'Work item not found', error: 'Work item not found' };
      }

      const deletedItem = workItems[workItemIndex];
      workItems.splice(workItemIndex, 1);
      phases[phaseIndex] = { ...phase, workItems };

      await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: "SET phases = :phases, updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
      }).promise();

      return { success: true, message: `Work item "${deletedItem.title}" deleted successfully` };
    }

    // Delete phase
    const deletedPhase = phases[phaseIndex];
    phases.splice(phaseIndex, 1);

    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: "SET phases = :phases, updatedAt = :updatedAt",
      ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
    }).promise();

    return { success: true, message: `Phase "${deletedPhase.title}" deleted successfully` };
  } catch (error) {
    console.error('AgentMode: Error deleting GTM items:', error);
    return { success: false, message: 'Failed to delete GTM items', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Get GTM common items catalog
export async function getGTMCommonItems(): Promise<any> {
  try {
    // Lazy require, not a top-level import: settingsService.ts constructs a real
    // AWS.DynamoDB.DocumentClient at module load. A static import here would
    // drag that into every importer of this standalone module (ENG-1816 F1's
    // lesson-lazy-require-aws-sdk-modules postmortem) — same treatment as
    // emma/impl/books.ts's generateBookContent.
    const { settingsService } = require('../../services/settingsService') as typeof import('../../services/settingsService');
    const setting = await settingsService.getSetting("gtm_common_items");
    const categories = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
    return { success: true, message: `Found ${categories.length} category(ies)`, categories };
  } catch (error) {
    console.error('AgentMode: Error fetching GTM common items:', error);
    return { success: false, message: 'Failed to fetch GTM common items', error: error instanceof Error ? error.message : 'Unknown error', categories: [] };
  }
}

// Add common items to a GTM plan phase
export async function addGTMCommonItems(planId: string, items: { title: string; description?: string }[], targetPhaseId?: string, newPhaseName?: string, userId?: string): Promise<any> {
  try {
    if (!items || items.length === 0) {
      return { success: false, message: 'Items array must be non-empty', error: 'Items array must be non-empty' };
    }

    if (!targetPhaseId && !newPhaseName) {
      return { success: false, message: 'Either target_phase_id or new_phase_name is required', error: 'Either target_phase_id or new_phase_name is required' };
    }

    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;
    const phases = plan.phases || [];

    const newWorkItems = items.map((item: { title: string; description?: string }) => ({
      id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      title: item.title.trim(),
      description: item.description?.trim() || null,
      dri: null,
      status: "pending",
      notes: null,
      dueDate: null,
    }));

    if (targetPhaseId) {
      const phaseIndex = phases.findIndex((p: any) => p.id === targetPhaseId);
      if (phaseIndex === -1) {
        return { success: false, message: 'Target phase not found', error: 'Target phase not found' };
      }

      const targetPhase = phases[phaseIndex];
      const workItems = targetPhase.workItems || [];
      workItems.push(...newWorkItems);

      const hasWorkItems = workItems.length > 0;
      const allItemsDone = hasWorkItems && workItems.every(
        (item: any) => item.status === "completed" || item.status === "skipped"
      );

      phases[phaseIndex] = { ...targetPhase, workItems, status: allItemsDone ? "completed" : "in_progress" };
    } else if (newPhaseName) {
      const phaseId = `phase-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      phases.push({
        id: phaseId,
        title: newPhaseName.trim(),
        description: null,
        dri: null,
        status: "in_progress",
        workItems: newWorkItems,
        dueDate: null,
      });
    }

    // Recalculate plan status
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
    const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
    const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

    if (plan.status === "completed" && planStatus !== "completed") {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    const updateResult = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    }).promise();

    return {
      success: true,
      message: `${items.length} common item(s) added successfully`,
      plan: updateResult.Attributes,
    };
  } catch (error) {
    console.error('AgentMode: Error adding GTM common items:', error);
    return { success: false, message: 'Failed to add common items', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Send GTM status report
export async function sendGTMStatusReport(
  planId: string,
  phaseId: string | undefined,
  notifications: { notifyUser?: boolean; notifyPlanPoc?: boolean; notifyPhasePoc?: boolean; notifyPhasePocs?: boolean; message?: string },
  userId: string
): Promise<any> {
  try {
    const dynamodb = await getDynamoDbClient();
    const TABLE_NAME = getDynamoDbTableName();

    const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

    if (!result.Item) {
      return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
    }

    if (result.Item.userId !== userId) {
      return { success: false, message: 'Access denied', error: 'Access denied' };
    }

    const plan = result.Item;

    if (phaseId) {
      // Phase-level report
      const phase = plan.phases?.find((p: any) => p.id === phaseId);
      if (!phase) {
        return { success: false, message: 'Phase not found', error: 'Phase not found' };
      }

      const { sendPhaseStatusReport } = await import('../../services/gtmPlanNotificationService');
      const { describeStatusReport } = await import('../../services/gtmStatusReportOutcome');
      const report = await sendPhaseStatusReport(plan as any, phaseId, notifications, process.env.CUSTOMER_FRONTEND_URL);
      const outcome = describeStatusReport(report, `phase status report for "${phase.title}"`);
      if (!outcome.ok) {
        return { success: false, message: outcome.message, error: outcome.message };
      }

      return { success: true, message: outcome.message };
    } else {
      // Plan-level report
      const { sendPlanStatusReport } = await import('../../services/gtmPlanNotificationService');
      const { describeStatusReport } = await import('../../services/gtmStatusReportOutcome');
      const report = await sendPlanStatusReport(plan as any, notifications, process.env.CUSTOMER_FRONTEND_URL);
      const outcome = describeStatusReport(report, `plan status report for "${plan.title}"`);
      if (!outcome.ok) {
        return { success: false, message: outcome.message, error: outcome.message };
      }

      return { success: true, message: outcome.message };
    }
  } catch (error) {
    console.error('AgentMode: Error sending GTM status report:', error);
    return { success: false, message: 'Failed to send status report', error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
