/**
 * ENG-2103 (F2) — task management tool cluster, extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * listTaskTemplates, waitForTaskCompletion, createTaskFromTemplate,
 * createTaskFromPrompt — the 14th domain cluster in this series — plus
 * createRevision, non-contiguous (it sits ~7,000 lines away from the rest,
 * amid the Meta/LinkedIn ads tool methods). All five power the legacy
 * agent-engine "web automation task" tool surface. `emma/tools.ts` marks
 * every one of these four tool definitions (list_task_templates,
 * create_task_from_template, create_task_from_prompt, create_revision)
 * `[DEPRECATED]` in its own description string — this is a fully
 * deprecated tool surface, not just the one tool (create_revision) the
 * extraction brief called out.
 *
 * Two helpers used ONLY by methods in this cluster moved alongside them as
 * plain (non-exported) module-scope functions, verified by whole-file grep
 * (zero other callers anywhere in the backend for either):
 *   - `getAvailableTemplates` (used only by listTaskTemplates). The class
 *     method was `public` but had zero callers beyond this one internal use
 *     — DELETED from the class rather than kept as a wrapper.
 *   - `convertUrlsToAttachments` (used only by createTaskFromTemplate and
 *     createTaskFromPrompt). Was already `private` on the class — DELETED,
 *     same reasoning.
 *
 * CROSS-DEPENDENCY with the excluded createImageTaskFromPrompt: unlike the
 * two helpers above, `getPreviousTaskResults` is called by THREE methods —
 * createTaskFromTemplate and createTaskFromPrompt (both moving here) AND
 * createImageTaskFromPrompt (excluded, stays on the class) — confirmed by
 * whole-backend grep, exactly 3 call sites, no others. It is a pure function
 * (only reads `chatbotDb`/`taskDb`, no other instance state), so this is
 * handled with a plain one-line delegating wrapper kept on the class
 * (`AgentModeService.prototype.getPreviousTaskResults`) rather than a
 * structural-interface parameter (cluster 13's WorkPlanModelRegistry shape
 * was needed there because of real instance state; no such state exists
 * here). The two moved methods in this module call the exported
 * `getPreviousTaskResults` function directly; createImageTaskFromPrompt
 * keeps calling `this.getPreviousTaskResults(...)`, unaffected.
 *
 * EXCLUSION RE-VERIFIED, WITH A CORRECTION TO THE BRIEF: the brief for this
 * cluster excluded `createImageTaskFromPrompt` on the theory that it makes a
 * direct `this.callLLM` call around line 12699 of the pre-extraction file.
 * Independently re-checked line by line: `createImageTaskFromPrompt` runs
 * from its `public async` declaration to its own closing brace with ZERO
 * `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` calls anywhere in its body. The
 * `this.callLLM` call actually at that line number belongs to a completely
 * different, unrelated method, `generateSessionTitle`, which merely starts
 * two lines after createImageTaskFromPrompt's closing brace — adjacent in
 * the file, not nested inside it. createImageTaskFromPrompt's only
 * dependencies are `this.getPreviousTaskResults` (handled above, a plain
 * delegating wrapper) and `taskDb.createTask`/`taskDb.createTaskExecution`
 * (pure DB calls) — by the same criteria used everywhere else in this
 * series, it appears independently safe to move. It was NOT moved and NOT
 * modified here regardless of this finding, per an explicit instruction to
 * leave it untouched for this round; this note records the finding for
 * whoever picks up the next cluster or revisits this one.
 *
 * No other hidden `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling was found anywhere in the 5 moved
 * methods (grepped every method body individually before moving it).
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions
 * rather than duplicating them for listTaskTemplates, createTaskFromTemplate,
 * createTaskFromPrompt and createRevision — ALL FOUR keep a one-line
 * delegating wrapper (none deleted), because each has a real caller beyond
 * `emma/tools.ts`, found by grepping the whole backend:
 *   - `listTaskTemplates`: `routes/emmaApi.ts`'s `GET /task-templates`
 *     handler, and `agentModeService.listTaskTemplates.test.ts` (calls the
 *     real method directly on a real instance, 5 call sites).
 *   - `createTaskFromTemplate`: `routes/emmaApi.ts`'s
 *     `POST /task-from-template` handler, and several test files calling the
 *     real method directly on a real instance (`templates.turnOffHeadless
 *     .test.ts`, `agentModeService.asyncDefault.test.ts`,
 *     `agentModeService.async.test.ts`).
 *   - `createTaskFromPrompt`: `routes/emmaApi.ts`'s `POST /task-from-prompt`
 *     handler, and the same two test files' direct real-instance calls.
 *   - `createRevision`: `routes/emmaApi.ts`'s `POST /revision` handler. No
 *     dedicated direct-call test exists for this one (the file named for it,
 *     `agentModeService.createRevision.test.ts`, actually tests the
 *     unrelated `extractMinimalToolResult`/task-id-extraction logic, not
 *     `createRevision` itself).
 * `waitForTaskCompletion`, by contrast, was DELETED from the class rather
 * than kept as a wrapper: it was `public`, but grepping the whole backend
 * found zero callers beyond the two methods above (both moving here) — the
 * hits in `agentModeService.async.test.ts` are on a self-contained
 * `MockAgentModeService` test double that never imports the real class, not
 * on `AgentModeService.prototype.waitForTaskCompletion`.
 *
 * No `jest.spyOn` on any of the 5 in-scope methods (or the 3 helpers) exists
 * anywhere in the backend, confirmed by grep — no stale-mock spy regressions
 * to fix for this cluster.
 *
 * Transitive-import traps: `chatbotDb` (`getPreviousTaskResults` only) and
 * `taskDb`/`taskTemplateDb` (every method here) are both lazily imported.
 * `chatbotService.ts` is one of this series' four explicitly-named traps
 * (circularly imports `agentModeService.ts` back) — lazy-`require`'d here,
 * the same idiom `emma/impl/workPlans.ts` established for it. `services/db.ts`
 * is NOT one of the four explicitly named in this cluster's brief, but it
 * constructs a real `AWS.DynamoDB.DocumentClient()` at module load (its own
 * line 56) — the exact same risk shape — and every DB-touching cluster
 * before this one (`emma/impl/leads.ts`, `gtmPlans.ts`, `knowledgeBase.ts`,
 * `brandMarketStrategy.ts`, `htmlCreation.ts`) already treats it as a trap,
 * lazily `await import('../../services/db')`-ing it rather than importing it
 * statically. Followed the same established idiom here for consistency.
 *
 * No `billingUserId`/`currentRunFunding()` handling anywhere in this cluster
 * (grepped all 5 method bodies, zero matches) — none of these methods meter
 * LLM usage themselves.
 */
import type { ChatMessage } from '../../services/chatbotService';

/**
 * Used only by `listTaskTemplates` — see module header for why this stayed a
 * plain (non-exported) helper instead of a class delegating wrapper (zero
 * other callers anywhere in the backend).
 */
async function getAvailableTemplates(): Promise<any[]> {
  const { taskTemplateDb } = await import('../../services/db');
  try {
    const templates = await taskTemplateDb.getPublishedTemplates();
    return templates
      .filter(template => {
        // Only include templates with valid categories
        const category = template.category;
        return category && category.trim() !== '';
      })
      .map(template => ({
        templateId: template.templateId,
        name: template.name,
        description: template.description,
        category: template.category,
        parameters: template.parameters || [],
        promptTemplate: template.prompt,
        isDeepResearch: template.isDeepResearch,
        isComplexTask: template.isComplexTask,
        outputAsJson: template.outputAsJson,
        outputAsHtml: template.outputAsHtml,
        selectedLLMs: template.selectedLLMs,
        useSharedBrowser: template.useSharedBrowser,
        turnOffHeadless: template.turnOffHeadless
      }));
  } catch (error) {
    console.error('Error fetching templates:', error);
    throw error;
  }
}

// List task templates (used by list_task_templates MCP tool)
export async function listTaskTemplates(): Promise<any> {
  try {
    const templates = await getAvailableTemplates();

    if (templates.length === 0) {
      return {
        success: true,
        message: 'No templates are currently available.',
        templates: [],
        totalTemplates: 0
      };
    }

    // Group by category for organized presentation
    const grouped: Record<string, any[]> = {};
    templates.forEach((t: any) => {
      const cat = t.category || 'General';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({
        template_id: t.templateId,
        name: t.name,
        description: t.description,
        category: cat,
        parameters: (t.parameters || []).map((p: any) => typeof p === 'string' ? p : p.name || p.id)
      });
    });

    return {
      success: true,
      message: `Found ${templates.length} template(s)`,
      templates_by_category: grouped,
      totalTemplates: templates.length
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to list task templates',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Used only by `createTaskFromTemplate` and `createTaskFromPrompt` — see
 * module header for why this stayed a plain (non-exported) helper instead of
 * a class delegating wrapper (was already `private`, zero other callers).
 */
function convertUrlsToAttachments(fileUrls: string[]): any[] {
  return fileUrls.map(url => {
    // Extract filename from URL (last part after the last slash)
    const filename = url.split('/').pop() || 'unknown_file';
    return {
      url: url,
      key: url, // Use URL as key for now
      filename: filename,
      uploadedAt: new Date().toISOString()
    };
  });
}

/**
 * Used by createTaskFromTemplate and createTaskFromPrompt (both moved here)
 * AND by createImageTaskFromPrompt (excluded, stays on
 * `AgentModeService`) — see module header's cross-dependency writeup.
 * `AgentModeService.prototype.getPreviousTaskResults` keeps a one-line
 * delegating wrapper to this function so createImageTaskFromPrompt's
 * existing `this.getPreviousTaskResults(...)` call keeps working unchanged.
 */
export async function getPreviousTaskResults(userId: string, sessionId: string): Promise<string> {
  const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
  try {
    // Get the current conversation to find previous task executions
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session || !session.messages) {
      return '';
    }

    // Extract task IDs from previous tool calls in this conversation
    const taskIds = new Set<string>();
    session.messages.forEach((message: ChatMessage) => {
      if (message.metadata?.toolCalls) {
        message.metadata.toolCalls.forEach((toolCall: any) => {
          if (toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt' || toolCall.name === 'create_revision') {
            if (toolCall.result?.taskId) {
              taskIds.add(toolCall.result.taskId);
            }
          }
        });
      }
    });

    if (taskIds.size === 0) {
      return '';
    }

    // Get executions for each specific task
    const completedExecutions: any[] = [];
    const { taskDb } = await import('../../services/db');

    for (const taskId of taskIds) {
      const taskExecutions = await taskDb.getTaskExecutions(taskId);
      if (taskExecutions && taskExecutions.length > 0) {
        // Find the latest completed execution with HTML results
        const latestCompleted = taskExecutions
          .filter(execution =>
            execution.status === 'completed' &&
            execution.result_files &&
            execution.result_files.length > 0
          )
          .sort((a, b) => new Date(b.createdAt || b.startTime).getTime() - new Date(a.createdAt || a.startTime).getTime())[0];

        if (latestCompleted) {
          // Fetch task details to get the task name
          const task = await taskDb.getTaskById(taskId);
          if (task) {
            latestCompleted.taskName = task.name;
          }
          completedExecutions.push(latestCompleted);
        }
      }
    }

    if (completedExecutions.length === 0) {
      return '';
    }

    // Build context with HTML result URLs
    let context = '\n\n## Previous Task Results\n';
    context += 'The following are results from your previous completed tasks that you can reference:\n\n';

    completedExecutions.forEach(execution => {
      const htmlFiles = execution.result_files.filter((file: any) =>
        file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
      );

      if (htmlFiles.length > 0) {
        context += `**Task ${execution.taskId}** (${execution.taskName || 'Unknown Task'}):\n`;
        htmlFiles.forEach((file: any) => {
          context += `- Result: ${file.url}\n`;
        });
        context += '\n';
      }
    });

    return context;
  } catch (error) {
    console.error('Error fetching previous task results:', error);
    return '';
  }
}

// Helper function to wait for task completion. DELETED from the class (see
// module header) — used only by createTaskFromTemplate/createTaskFromPrompt
// below, both moved here alongside it.
export async function waitForTaskCompletion(taskId: string, executionId: string, userId: string, maxWaitTime: number = 300000, additionalFields: any = {}, pollInterval: number = 2000): Promise<any> {
  const { taskDb } = await import('../../services/db');
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (execution && (execution.status === 'completed' || execution.status === 'failed')) {
        return {
          success: execution.status === 'completed',
          message: execution.status === 'completed'
            ? 'Task completed successfully'
            : `Task failed: ${execution.error || 'Unknown error'}`,
          status: execution.status,
          taskId: taskId,
          executionId: executionId,
          result: execution.result,
          error: execution.error,
          ...additionalFields
        };
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.error('AgentMode: Error polling task execution:', error);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  // Timeout reached - return async format
  return {
    success: true,
    message: `Task "${additionalFields.taskName || 'Unknown'}" has been created successfully. The task is still running and may complete later.`,
    status: 'pending',
    taskId: taskId,
    executionId: executionId,
    ...additionalFields
  };
}

// Create task from template
export async function createTaskFromTemplate(templateId: string, parameters: Record<string, string>, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = [], async: boolean = false): Promise<any> {
  try {
    const { taskDb, taskTemplateDb } = await import('../../services/db');

    // Validate parameters
    if (!parameters || typeof parameters !== 'object') {
      return {
        success: false,
        message: 'Invalid parameters provided. Parameters must be a dictionary with parameter IDs as keys.',
        status: 'invalid_parameters'
      };
    }

    // Load specific template by ID
    const template = await taskTemplateDb.getTemplateById(templateId);
    if (!template) {
      return {
        success: false,
        message: 'Template not found. Please check the template ID and try again.',
        status: 'template_not_found'
      };
    }

    // Check if user has access to the template (either owns it or it's published)
    if (template.userId !== userId && !template.published) {
      return {
        success: false,
        message: 'You do not have access to this template.',
        status: 'access_denied'
      };
    }


    // Map template to the expected format
    const templateData = {
      templateId: template.templateId,
      name: template.name,
      description: template.description,
      category: template.category,
      parameters: template.parameters || [],
      promptTemplate: template.prompt,
      isInteractive: template.isInteractive,
      isDeepResearch: template.isDeepResearch,
      isComplexTask: template.isComplexTask,
      outputAsJson: template.outputAsJson,
      outputAsHtml: template.outputAsHtml,
      selectedLLMs: template.selectedLLMs,
      useSharedBrowser: template.useSharedBrowser,
      turnOffHeadless: template.turnOffHeadless,
      isAgenticDevMode: template.isAgenticDevMode,
      nameParameter: template.nameParameter
    };

    // Check if required parameters are missing
    const missingRequired = (templateData.parameters || [])
      .filter((p: any) => {
        const paramName = typeof p === 'string' ? p : p.name || p.id;
        return !parameters[paramName];
      })
      .map((p: any) => typeof p === 'string' ? p : p.name || p.id);

    if (missingRequired.length > 0) {
      return {
        success: false,
        message: `I need more information to create this task. Please provide the following required details: ${missingRequired.join(', ')}`,
        status: 'missing_parameters',
        missingParameters: missingRequired
      };
    }

    // Generate final prompt by replacing parameters in template
    let finalPrompt = templateData.promptTemplate;
    if (templateData.parameters && templateData.parameters.length > 0) {
      templateData.parameters.forEach((param: any) => {
        // Use the parameter name directly as the key
        const paramName = typeof param === 'string' ? param : param.name || param.id;
        const value = parameters[paramName] || `[${paramName}]`;
        finalPrompt = finalPrompt?.replace(
          new RegExp(`\\[${paramName}\\]`, 'g'),
          value
        );
      });
    }

    // Attach previous task results if requested
    if (attachPreviousTaskResults) {
      const previousResults = await getPreviousTaskResults(userId, sessionId);
      if (previousResults) {
        finalPrompt += previousResults;
      }
    }

    // Generate task name
    let taskName = templateData.name;
    if (templateData.nameParameter && parameters[templateData.nameParameter]) {
      taskName = `${templateData.name} - ${parameters[templateData.nameParameter]}`;
    }

    // Convert file URLs to attachments
    const attachments = convertUrlsToAttachments(attachedFileUrls);

    if (templateData.isDeepResearch) {
      console.warn('[ENG-805] isDeepResearch requested but forced false', { userId, templateId: templateData.templateId, source: 'createTaskFromTemplate' });
    }

    // Create task using template
    const task = {
      taskId: Date.now().toString(),
      userId,
      name: taskName,
      prompt: finalPrompt,
      status: 'active',
      emailNotification: templateData.isDeepResearch || false,
      isInteractive: templateData.isInteractive || false,
      // Deep research was deprecated in agent-engine 2026-01-01 (e94a8e4a) -
      // never persist true, even from an older template that still has it.
      isDeepResearch: false,
      isComplexTask: templateData.isComplexTask || false,
      extractPageContent: false,
      outputAsJson: templateData.outputAsJson || false,
      outputAsHtml: templateData.outputAsHtml || false,
      selectedLLMs: templateData.selectedLLMs || undefined,
      useSharedBrowser: templateData.useSharedBrowser || false,
      turnOffHeadless: templateData.turnOffHeadless !== undefined ? templateData.turnOffHeadless : true,
      isAgenticDevMode: templateData.isAgenticDevMode || false,
      useKnowledgeBase: false,
      updateKnowledgeBase: false,
      updateLeadList: false,
      createVideo: false,
      videoModel: undefined,
      imageModel: undefined,
      category: templateData.category || 'General',
      description: templateData.description,
      templateId: templateData.templateId,
      parameterValues: parameters,
      attachments: attachments,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Save task to database
    await taskDb.createTask(task);

    // Create task execution
    const execution = await taskDb.createTaskExecution({
      executionId: Date.now().toString(),
      taskId: task.taskId,
      userId: userId,
      status: 'pending',
      startTime: new Date().toISOString()
    });

    // If async is false, wait for task completion
    if (!async && execution?.executionId) {
      return await waitForTaskCompletion(task.taskId, execution.executionId, userId, 3600000, {
        templateName: templateData.name,
        taskName: taskName
      });
    }

    return {
      success: true,
      message: `Task "${taskName}" has been created successfully using the ${templateData.name} template. The task will start running shortly.`,
      status: 'pending',
      taskId: task.taskId,
      executionId: execution?.executionId,
      templateName: templateData.name,
      taskName: taskName
    };
  } catch (error) {
    console.error('AgentMode: Error creating task from template:', error);
    return {
      success: false,
      message: 'Failed to create task from template. Please try again.',
      status: 'error'
    };
  }
}

// Create task from raw prompt
export async function createTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = [], async: boolean = false): Promise<any> {
  try {
    const { taskDb } = await import('../../services/db');

    // Attach previous task results if requested
    let finalPrompt = prompt;
    if (attachPreviousTaskResults) {
      const previousResults = await getPreviousTaskResults(userId, sessionId);
      if (previousResults) {
        finalPrompt += previousResults;
      }
    }

    // Convert file URLs to attachments
    const attachments = convertUrlsToAttachments(attachedFileUrls);

    // Create task using raw prompt
    const task = {
      taskId: Date.now().toString(),
      userId,
      name: taskName,
      prompt: finalPrompt,
      status: 'active',
      emailNotification: false,
      isInteractive: false,
      isDeepResearch: false,
      isComplexTask: false,
      extractPageContent: false,
      outputAsJson: false,
      outputAsHtml: true,
      useSharedBrowser: false,
      turnOffHeadless: true,
      useKnowledgeBase: false,
      updateKnowledgeBase: false,
      updateLeadList: false,
      createVideo: false,
      videoModel: undefined,
      imageModel: undefined,
      category: category,
      description: `Custom task created from prompt: ${taskName}`,
      attachments: attachments,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Save task to database
    await taskDb.createTask(task);

    // Create task execution
    const execution = await taskDb.createTaskExecution({
      executionId: Date.now().toString(),
      taskId: task.taskId,
      userId: userId,
      status: 'pending',
      startTime: new Date().toISOString()
    });

    // If async is false, wait for task completion
    if (!async && execution?.executionId) {
      return await waitForTaskCompletion(task.taskId, execution.executionId, userId, 3600000, {
        taskName: taskName
      });
    }

    return {
      success: true,
      message: `Task "${taskName}" has been created successfully using a custom prompt. The task will start running shortly.`,
      status: 'pending',
      taskId: task.taskId,
      executionId: execution?.executionId,
      taskName: taskName
    };
  } catch (error) {
    console.error('AgentMode: Error creating task from prompt:', error);
    return {
      success: false,
      message: 'Failed to create task from prompt. Please try again.',
      status: 'error'
    };
  }
}

// [DEPRECATED] per emma/tools.ts's own tool description ("For image revision,
// use 'generate_image' instead. For HTML report revision, use
// 'update_html_file' instead.") — still moved and handled like any other
// in-scope method per this cluster's instructions.
export async function createRevision(taskId: string, executionId: string, revisionPrompt: string, userId: string, targetResultName?: string): Promise<any> {
  try {
    const { taskDb } = await import('../../services/db');
    console.log('AgentMode: Creating revision for task:', taskId, 'execution:', executionId, 'targetResultName:', targetResultName);

    // Get the task to verify ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return {
        success: false,
        message: 'Task not found',
        status: 'error'
      };
    }

    // Get the execution to verify it exists and is completed
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return {
        success: false,
        message: 'Execution not found',
        status: 'error'
      };
    }

    if (execution.status !== 'completed') {
      return {
        success: false,
        message: 'Can only revise completed executions',
        status: 'error'
      };
    }

    // Analyze result files to find available reports and images
    const resultFiles = execution.result_files || [];
    const htmlFiles = resultFiles.filter((file: any) =>
      file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
    );
    const imageFiles = resultFiles.filter((file: any) => {
      const filename = file.filename.toLowerCase();
      return file.view_type === 'image' ||
        filename.endsWith('.jpg') || filename.endsWith('.jpeg') ||
        filename.endsWith('.png') || filename.endsWith('.gif') ||
        filename.endsWith('.webp') || filename.endsWith('.svg');
    });

    // If no results available, return error
    if (htmlFiles.length === 0 && imageFiles.length === 0) {
      return {
        success: false,
        message: 'No results found for revision. The execution must have completed HTML reports or images to create a revision.',
        status: 'error'
      };
    }

    // If multiple results and no target specified, return list of available results
    const totalResults = htmlFiles.length + imageFiles.length;
    if (totalResults > 1 && !targetResultName) {
      const availableResults = [
        ...htmlFiles.map((f: any) => ({ name: f.filename, type: 'report', url: f.url })),
        ...imageFiles.map((f: any) => ({ name: f.filename, type: 'image', url: f.url }))
      ];

      return {
        success: false,
        message: `Multiple results found. Please specify which result to revise by providing the target_result_name parameter. Available results: ${availableResults.map(r => `${r.name} (${r.type})`).join(', ')}`,
        availableResults,
        status: 'multiple_results'
      };
    }

    // Find the target result file
    let targetFile = null;
    let assetType = '';
    let originalAssetUrl = '';

    if (targetResultName) {
      // Look for the specific file by name
      targetFile = resultFiles.find((file: any) => file.filename === targetResultName);
      if (!targetFile) {
        return {
          success: false,
          message: `Target result file '${targetResultName}' not found. Available files: ${resultFiles.map((f: any) => f.filename).join(', ')}`,
          status: 'error'
        };
      }
    } else {
      // Use the first available result
      targetFile = htmlFiles[0] || imageFiles[0];
    }

    if (!targetFile) {
      return {
        success: false,
        message: 'No target result file found',
        status: 'error'
      };
    }

    // Determine asset type and URL
    if (targetFile.is_html || targetFile.view_type === 'html' || targetFile.filename.toLowerCase().endsWith('.html')) {
      assetType = 'report';
      originalAssetUrl = targetFile.url;
    } else {
      assetType = 'image';
      originalAssetUrl = targetFile.url;
    }

    // Format revision prompt based on asset type (similar to Ad Images page)
    let formattedRevisionPrompt = revisionPrompt;
    if (assetType === 'image') {
      // For images, add specific instructions similar to Ad Images page
      formattedRevisionPrompt = `Please create a revised version of the image based on the following feedback: ${revisionPrompt}. Use the original image as a reference and create a new version that addresses the requested changes.`;
    }

    // Create a new task execution with revision prompt
    const revisionExecution = {
      executionId: Date.now().toString(),
      taskId,
      userId: task.userId,
      run_user_id: userId !== task.userId ? userId : undefined,
      status: 'pending',
      startTime: new Date().toISOString(),
      revision_prompt: formattedRevisionPrompt,
      original_execution_id: executionId,
      original_report_url: assetType === 'report' ? originalAssetUrl : undefined,
      original_image_url: assetType === 'image' ? originalAssetUrl : undefined,
      variations: 1,
      // Include Slack channel info from task so revision gets sent back to Slack
      slack_channel: task.slackChannel,
      slack_channel_name: task.slackChannelName,
      requireApproval: task.requireApproval || false,
      approvalAssetType: assetType === 'report' ? 'html' : assetType
    };

    await taskDb.createTaskExecution(revisionExecution);

    return {
      success: true,
      message: `Revision created successfully for ${assetType} '${targetFile.filename}'. New execution ID: ${revisionExecution.executionId}`,
      taskId: revisionExecution.taskId,
      executionId: revisionExecution.executionId,
      status: 'pending',
      assetType,
      targetFile: targetFile.filename
    };
  } catch (error) {
    console.error('AgentMode: Error creating revision:', error);
    return {
      success: false,
      message: 'Failed to create revision. Please try again.',
      status: 'error'
    };
  }
}
