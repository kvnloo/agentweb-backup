import { Request, Response } from 'express';
import { taskDb, orgDb } from '../services/db';
import { userDb } from '../services/db';
import { scheduleDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import AWS from 'aws-sdk';
import { taskTemplateDb } from '../services/db';
import crypto from 'crypto';
import { S3 } from 'aws-sdk';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { getAssetTypeFromFilename } from '../services/approvalDb';
import { canViewItem, canEditItem } from '../services/orgShareService';
import { getPlacidPrivateToken } from '../utils/secretsManager';
import { parseAgentModeImageIds } from '../utils/agentModeAssetIds';
import { retryTransientWrite } from '../services/usageWriteFailureMonitor';
import { renderPlacidImage, describePlacidError } from '../services/placidRenderService';
import { uploadFileToS3 } from '../utils/s3Utils';
import { getInteractiveShareExpiresAt } from '../utils/interactiveShare';
import { v4 as uuidv4 } from 'uuid';

const s3 = new S3();

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: 'pending' | 'answered';
  timestamp: number;
}

export const createTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { 
      name, 
      prompt, 
      isInteractive, 
      isDeepResearch, 
      emailNotification, 
      templateId, 
      parameterValues, 
      isComplexTask, 
      extractPageContent, 
      category,
      description,
      outputAsJson,
      outputAsHtml,
      emailFriendlyHtml,
      selectedLLMs,
      useSharedBrowser,
      turnOffHeadless,
      useKnowledgeBase,
      updateKnowledgeBase,
      updateLeadList,
      createVideo,
      videoModel,
      imageModel,
      requireApproval,
      slackChannel
    } = req.body;
    
    // If templateId is provided, fetch the template and use its values
    if (templateId) {
      try {
        const template = await taskTemplateDb.getTemplateById(templateId);
        
        // Check if template exists
        if (!template) {
          return res.status(404).json({ message: 'Template not found' });
        }
        
        // Check if user has access to the template (either owns it or it's published)
        if (template.userId !== userId && !template.published) {
          return res.status(403).json({ message: 'Access denied to this template' });
        }
        
        // Frontend already processes name and prompt with parameters.
        // Values from req.body (name, prompt, isInteractive, etc.) are used directly or as overrides.

        // For deep research tasks, email notification is automatically enabled or taken from request.
        const finalEmailNotification = emailNotification !== undefined
          ? emailNotification
          : isDeepResearch !== undefined
            ? isDeepResearch
            : template.isDeepResearch;

        const requestedDeepResearch = isDeepResearch !== undefined ? isDeepResearch : template.isDeepResearch;
        if (requestedDeepResearch) {
          console.warn('[ENG-805] isDeepResearch requested but forced false', { userId, templateId, source: 'createTask(fromTemplate)' });
        }

        // Create task using template values, allowing overrides from request body for most fields.
        // name and prompt from req.body are already fully processed by the frontend.
        const task = {
          taskId: Date.now().toString(),
          userId,
          name: name, // Use name from req.body (already processed by frontend)
          prompt: prompt, // Use prompt from req.body (already processed by frontend)
          status: 'active',
          emailNotification: finalEmailNotification,
          isInteractive: isInteractive !== undefined ? Boolean(isInteractive) : template.isInteractive,
          // Deep research was deprecated in agent-engine 2026-01-01 (e94a8e4a) -
          // never persist true, even if an older template still has it set.
          isDeepResearch: false,
          isComplexTask: isComplexTask !== undefined ? Boolean(isComplexTask) : template.isComplexTask,
          extractPageContent: extractPageContent !== undefined ? Boolean(extractPageContent) : template.extractPageContent, // Uses template.extractPageContent if extractPageContent is undefined in req.body
          outputAsJson: outputAsJson !== undefined ? Boolean(outputAsJson) : template.outputAsJson,
          outputAsHtml: outputAsHtml !== undefined ? Boolean(outputAsHtml) : template.outputAsHtml,
          emailFriendlyHtml: emailFriendlyHtml !== undefined ? Boolean(emailFriendlyHtml) : template.emailFriendlyHtml,
          useSharedBrowser: useSharedBrowser !== undefined ? Boolean(useSharedBrowser) : template.useSharedBrowser,
          turnOffHeadless: turnOffHeadless !== undefined ? Boolean(turnOffHeadless) : (template.turnOffHeadless !== undefined ? template.turnOffHeadless : true),
          isAgenticDevMode: req.body.isAgenticDevMode !== undefined ? Boolean(req.body.isAgenticDevMode) : template.isAgenticDevMode || false,
          useKnowledgeBase: useKnowledgeBase !== undefined ? Boolean(useKnowledgeBase) : template.useKnowledgeBase,
          updateKnowledgeBase: req.body.updateKnowledgeBase !== undefined ? Boolean(req.body.updateKnowledgeBase) : template.updateKnowledgeBase,
          updateLeadList: req.body.updateLeadList !== undefined ? Boolean(req.body.updateLeadList) : template.updateLeadList,
          createVideo: req.body.createVideo !== undefined ? Boolean(req.body.createVideo) : template.createVideo,
          videoModel: videoModel || null,
          imageModel: imageModel || null,
          knowledgeBaseType: 'private' as const,
          requireApproval: req.body.requireApproval !== undefined ? Boolean(req.body.requireApproval) : template.requireApproval || false,
          slackChannel: req.body.slackChannel || template.slackChannel || null,
          createdAt: new Date().toISOString(),
          llmName: req.body.llmName || null,
          category: category || template.category,
          description: description || template.description,
          templateId: templateId,
          selectedLLMs: selectedLLMs || template.selectedLLMs || null
        };

        const createdTask = await taskDb.createTask(task);
        return res.status(201).json(createdTask);
      } catch (error) {
        console.error('Error fetching template:', error);
        return res.status(500).json({ message: 'Error fetching template' });
      }
    }
    
    // Regular task creation without template
    if (!name || !prompt) {
      return res.status(400).json({ message: 'Name and prompt are required' });
    }

    if (isDeepResearch) {
      console.warn('[ENG-805] isDeepResearch requested but forced false', { userId, source: 'createTask' });
    }

    const task = {
      taskId: Date.now().toString(),
      userId,
      name,
      prompt,
      status: 'active',
      emailNotification: emailNotification ?? isDeepResearch,  // Use provided value or default to isDeepResearch
      isInteractive: Boolean(isInteractive),  // Convert to boolean
      // Deep research was deprecated in agent-engine 2026-01-01 (e94a8e4a) -
      // never persist true.
      isDeepResearch: false,
      isComplexTask: Boolean(isComplexTask),  // Convert to boolean
      extractPageContent: extractPageContent ?? isDeepResearch,  // Convert to boolean
      outputAsJson: Boolean(outputAsJson),
      outputAsHtml: Boolean(outputAsHtml),
      emailFriendlyHtml: Boolean(emailFriendlyHtml),
      useSharedBrowser: Boolean(useSharedBrowser),
      turnOffHeadless: Boolean(turnOffHeadless),
      useKnowledgeBase: Boolean(useKnowledgeBase),
      updateKnowledgeBase: Boolean(req.body.updateKnowledgeBase),
      updateLeadList: Boolean(req.body.updateLeadList),
      createVideo: Boolean(req.body.createVideo),
      videoModel: videoModel || null,
      imageModel: imageModel || null,
      knowledgeBaseType: 'private' as const, // Default to private for new tasks
      createdAt: new Date().toISOString(),
      llmName: req.body.llmName || null,
      category: category,
      description: description,
      selectedLLMs: selectedLLMs || null,
      requireApproval: Boolean(requireApproval),
      slackChannel: slackChannel || null
    };

    const createdTask = await taskDb.createTask(task);
    res.status(201).json(createdTask);
  } catch (error) {
    console.error('Error in createTask:', error);
    res.status(500).json({ message: 'Error creating task' });
  }
};

export const getTasks = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const orgId = user.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const enabled = org?.shareSettings?.knowledgeBase?.enabled === true;

    const ownTasks: any[] = (await taskDb.getTasksByUserId(userId)) || [];
    let orgTasks: any[] = [];

    if (orgId && enabled) {
      const members = await orgDb.getOrgMembers(orgId);
      const others = members
        .map((m: any) => m.userId as string)
        .filter((uid: string) => uid !== userId);
      const perMember = await Promise.all(
        others.map((uid: string) => taskDb.getTasksByUserId(uid).then((t: any) => t || []))
      );
      orgTasks = perMember.flat();
    }

    const seen = new Set<string>();
    const all = [...ownTasks, ...orgTasks].filter((t: any) => {
      if (seen.has(t.taskId)) return false;
      seen.add(t.taskId);
      return true;
    });

    // Preserve existing array response shape for backward compatibility with callers
    res.json(all);
  } catch (error) {
    console.error('Error in getTasks:', error);
    res.status(500).json({ message: 'Error fetching tasks' });
  }
};

export const getTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is admin or task owner
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Admins can always access any task
    if (user.isAdmin) {
      return res.json(task);
    }

    // Resolve org context for org-share permission check
    const ownerUser = task.userId !== userId ? await userDb.getUserById(task.userId) : null;
    const ownerOrgId = ownerUser?.orgId ?? user.orgId;
    const org = (user.orgId && ownerOrgId === user.orgId)
      ? await orgDb.getOrgById(user.orgId)
      : null;

    if (!canViewItem(
      { userId: task.userId },
      { userId, orgId: user.orgId, orgRole: user.orgRole },
      org,
      ownerOrgId,
      'knowledgeBase',
    )) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(task);
  } catch (error) {
    console.error('Error in getTask:', error);
    res.status(500).json({ message: 'Error fetching task' });
  }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;

    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Resolve org context for org-share permission check
    if (!user.isAdmin) {
      const ownerUser = task.userId !== userId ? await userDb.getUserById(task.userId) : null;
      const ownerOrgId = ownerUser?.orgId ?? user.orgId;
      const org = (user.orgId && ownerOrgId === user.orgId)
        ? await orgDb.getOrgById(user.orgId)
        : null;

      if (!canEditItem(
        { userId: task.userId },
        { userId, orgId: user.orgId, orgRole: user.orgRole },
        org,
        ownerOrgId,
        'knowledgeBase',
      )) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    // Build updates object based on what's provided
    const updates: any = {};
    
    if (req.body.emailNotification !== undefined) {
      updates.emailNotification = Boolean(req.body.emailNotification);
    }
    
    if (req.body.prompt !== undefined) {
      updates.prompt = req.body.prompt;
    }

    if (req.body.name !== undefined) {
      updates.name = req.body.name;
    }

    if (req.body.isInteractive !== undefined) {
      updates.isInteractive = Boolean(req.body.isInteractive);
    }

    if (req.body.isDeepResearch !== undefined) {
      // Deep research was deprecated in agent-engine 2026-01-01 (e94a8e4a) -
      // never allow it to be turned back on, only ever off.
      updates.isDeepResearch = false;
      if (req.body.isDeepResearch) {
        console.warn('[ENG-805] isDeepResearch requested but forced false', { userId, taskId, source: 'updateTask' });
      }
    }

    if (req.body.isComplexTask !== undefined) {
      updates.isComplexTask = Boolean(req.body.isComplexTask);
    }

    if (req.body.extractPageContent !== undefined) {
      updates.extractPageContent = Boolean(req.body.extractPageContent);
    }

    if (req.body.useSharedBrowser !== undefined) {
      updates.useSharedBrowser = Boolean(req.body.useSharedBrowser);
    }

    if (req.body.turnOffHeadless !== undefined) {
      updates.turnOffHeadless = Boolean(req.body.turnOffHeadless);
    }

    if (req.body.useKnowledgeBase !== undefined) {
      updates.useKnowledgeBase = Boolean(req.body.useKnowledgeBase);
    }

    if (req.body.updateKnowledgeBase !== undefined) {
      updates.updateKnowledgeBase = Boolean(req.body.updateKnowledgeBase);
    }

    if (req.body.updateLeadList !== undefined) {
      updates.updateLeadList = Boolean(req.body.updateLeadList);
    }

    if (req.body.createVideo !== undefined) {
      updates.createVideo = Boolean(req.body.createVideo);
      // If disabling createVideo, also clear the videoModel
      if (!updates.createVideo) {
        updates.videoModel = null;
      }
    }

    if (req.body.videoModel !== undefined) {
      updates.videoModel = req.body.videoModel;
    }

    if (req.body.imageModel !== undefined) {
      updates.imageModel = req.body.imageModel;
    }

    if (req.body.leadListIdentifier !== undefined) {
      updates.leadListIdentifier = req.body.leadListIdentifier;
    }

    if (req.body.knowledgeBaseType !== undefined) {
      updates.knowledgeBaseType = req.body.knowledgeBaseType;
    }

    // Handle outputAsJson and outputAsHtml mutual exclusivity
    if (req.body.outputAsJson !== undefined) {
      updates.outputAsJson = Boolean(req.body.outputAsJson);
      if (updates.outputAsJson) {
        updates.outputAsHtml = false; // If JSON is true, HTML must be false
      }
    }
    if (req.body.outputAsHtml !== undefined) {
      updates.outputAsHtml = Boolean(req.body.outputAsHtml);
      if (updates.outputAsHtml) {
        updates.outputAsJson = false; // If HTML is true, JSON must be false
      }
    }

    if (req.body.emailFriendlyHtml !== undefined) {
      updates.emailFriendlyHtml = Boolean(req.body.emailFriendlyHtml);
    }

    if (req.body.repairImageEmbedding !== undefined) {
      updates.repairImageEmbedding = Boolean(req.body.repairImageEmbedding);
    }

    if (req.body.htmlFormatInstructions !== undefined) {
      // allow empty string to clear or keep instruction text
      const val = req.body.htmlFormatInstructions;
      updates.htmlFormatInstructions = val === null ? null : String(val);
    }

    if (req.body.llmName !== undefined) {
      updates.llmName = req.body.llmName || null;  // Convert empty string to null
    }
    if (req.body.validateOutput !== undefined) {
      updates.validateOutput = Boolean(req.body.validateOutput);
    }

    if (req.body.status !== undefined) {
      updates.status = req.body.status;
    }

    if (req.body.isAgenticDevMode !== undefined) {
      updates.isAgenticDevMode = Boolean(req.body.isAgenticDevMode);
    }
    
    if (req.body.requireApproval !== undefined) {
      updates.requireApproval = Boolean(req.body.requireApproval);
    }
    
    if (req.body.slackChannel !== undefined) {
      updates.slackChannel = req.body.slackChannel || null;
    }
    
    if (req.body.sendHtmlReportOnly !== undefined) {
      updates.sendHtmlReportOnly = Boolean(req.body.sendHtmlReportOnly);
    }
    
    // Check if we're unarchiving a task (changing status from 'archived' to 'active')
    const isUnarchiving = task.status === 'archived' && updates.status === 'active';

    await taskDb.updateTask(taskId, updates);
    
    // If unarchiving, reactivate schedules that were disabled when the task was archived
    if (isUnarchiving) {
      console.log('Unarchiving task, reactivating schedules...');
      const schedules = await taskDb.getTaskSchedules(taskId);
      console.log('Found schedules:', schedules);
      
      if (schedules && schedules.length > 0) {
        for (const schedule of schedules) {
          console.log('Reactivating schedule:', schedule.scheduleId);
          try {
            await scheduleDb.updateSchedule(schedule.scheduleId, { status: 'active' });
            console.log('Schedule reactivated successfully');
          } catch (scheduleError) {
            console.error('Error reactivating schedule:', scheduleError);
          }
        }
      } else {
        console.log('No schedules found for this task');
      }
    }
    
    // Get and return the updated task
    const updatedTask = await taskDb.getTaskById(taskId);

    res.json(updatedTask);
  } catch (error) {
    console.error('Error in updateTask:', error);
    res.status(500).json({ message: 'Error updating task' });
  }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Owner can always delete their own task; others need org-level permission
    if (task.userId !== userId) {
      const user = await userDb.getUserById(userId);
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }

      // Admins can delete any task
      if (user.isAdmin) {
        // fall through to deletion
      } else if (user.orgRole === 'owner' && user.orgId) {
        // Org owners can delete same-org member tasks when knowledgeBase sharing is enabled
        const ownerUser = await userDb.getUserById(task.userId);
        if (ownerUser?.orgId !== user.orgId) {
          return res.status(403).json({ message: 'Access denied' });
        }
        const org = await orgDb.getOrgById(user.orgId);
        if (org?.shareSettings?.knowledgeBase?.enabled !== true) {
          return res.status(403).json({ message: 'Access denied' });
        }
        // fall through to deletion
      } else {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    // Update task status to archived instead of deleting
    await taskDb.updateTask(taskId, { status: 'archived' });
    console.log('Task archived:', taskId);
    
    // Disable all schedules for this task
    const schedules = await taskDb.getTaskSchedules(taskId);
    console.log('Found schedules to disable:', schedules);
    
    if (schedules && schedules.length > 0) {
      for (const schedule of schedules) {
        console.log('Disabling schedule:', schedule.scheduleId);
        try {
          await scheduleDb.updateSchedule(schedule.scheduleId, { status: 'inactive' });
          console.log('Schedule disabled successfully');
        } catch (scheduleError) {
          console.error('Error disabling schedule:', scheduleError);
        }
      }
    } else {
      console.log('No schedules found for this task');
    }

    res.status(200).json({ message: 'Task archived successfully' });
  } catch (error) {
    console.error('Error in archiveTask:', error);
    res.status(500).json({ message: 'Error archiving task' });
  }
};

export const executeTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const { feedback } = req.body;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Verify task belongs to user or user is admin
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Create a new task execution record
    const execution = {
      executionId: Date.now().toString(),
      taskId,
      userId: task.userId, // Use the task owner's ID for execution
      run_user_id: userId !== task.userId ? userId : undefined, // Record who actually ran the task if different from owner
      status: 'pending',
      startTime: new Date().toISOString(),
      feedback: feedback || undefined // Store feedback if provided
    };

    await taskDb.createTaskExecution(execution);
    res.status(201).json(execution);
  } catch (error) {
    console.error('Error in executeTask:', error);
    res.status(500).json({ message: 'Error executing task' });
  }
};

export const getTaskExecutions = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is admin or task owner
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const executions = await taskDb.getTaskExecutions(taskId);
    res.json(executions);
  } catch (error) {
    console.error('Error in getTaskExecutions:', error);
    res.status(500).json({ message: 'Error fetching task executions' });
  }
};

export const updateTaskExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const { feedback } = req.body;

    // Verify task exists
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    
    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    // Check if user is the task owner or an admin
    if (task.userId !== userId && !user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update execution feedback
    const updatedExecution = await taskDb.updateTaskExecution(executionId, { feedback });
    res.json(updatedExecution);
  } catch (error) {
    console.error('Error in updateTaskExecution:', error);
    res.status(500).json({ message: 'Error updating task execution' });
  }
};

export const respondToInteraction = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const interactionId = req.params.interactionId;
    const { response } = req.body;

    if (!response) {
      return res.status(400).json({ message: 'Response is required' });
    }

    // Verify task exists
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    
    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    // Check if user is the task owner or an admin
    if (task.userId !== userId && !user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Find and update the interaction
    const interactions: UserInteraction[] = execution.userInteractions || [];
    const interactionIndex = interactions.findIndex(i => i.id === interactionId);
    
    if (interactionIndex === -1) {
      return res.status(404).json({ message: 'Interaction not found' });
    }

    if (interactions[interactionIndex].status !== 'pending') {
      return res.status(400).json({ message: 'This interaction has already been answered' });
    }

    // Update the interaction
    interactions[interactionIndex] = {
      ...interactions[interactionIndex],
      response,
      status: 'answered'
    };

    // Update the execution with the modified interactions
    const updatedExecution = await taskDb.updateTaskExecution(executionId, {
      userInteractions: interactions
    });

    res.json(updatedExecution);
  } catch (error) {
    console.error('Error in respondToInteraction:', error);
    res.status(500).json({ message: 'Error responding to interaction' });
  }
};

export const getTaskExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    
    // Skip task existence check for temporary task IDs
    if (!taskId.startsWith('task-')) {
      // Get the task to check permissions
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        return res.status(404).json({ message: 'Task not found' });
      }

      // Check if user is admin or task owner
      const user = await userDb.getUserById(userId);
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }

      if (!user.isAdmin && task.userId !== userId) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    res.json(execution);
  } catch (error) {
    console.error('Error in getTaskExecution:', error);
    res.status(500).json({ message: 'Error fetching task execution' });
  }
};

export const getTaskExecutionPublic = async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      return res.status(400).json({ message: 'Session ID is required' });
    }

    // Get the session to verify the task execution belongs to it
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }

    // Check if the session is shared (either view-only or interactive)
    const hasViewOnlyShare = session.shareMetadata?.isShared;
    // Metadata without a token was never an openable share (nothing to compare), so it counts as no share.
    const interactiveShare = session.interactiveShareMetadata?.token ? session.interactiveShareMetadata : undefined;

    if (!hasViewOnlyShare && !interactiveShare) {
      return res.status(404).json({ message: 'Session is not shared' });
    }

    const viewOnlyExpired = !!(hasViewOnlyShare && session.shareMetadata?.expiresAt
      && new Date() > new Date(session.shareMetadata.expiresAt));

    // A live read-only share is public by design (portal ShareConversation page, no credential).
    if (!hasViewOnlyShare || viewOnlyExpired) {
      if (!interactiveShare) {
        return res.status(410).json({ message: 'Share link has expired' });
      }
      // ENG-2644: an interactive share is opened with its conversable token, never by the session id alone.
      // Token first, so a retry on an expired or switched-off share answers the same 401/410 every time.
      // Intentionally NO write on expiry: this read-only route must not deactivate from a stale read (it
      // could overwrite a share the owner just re-created); the /ishare routes do the switching off.
      const conversable = req.query.conversable;
      if (interactiveShare.token !== conversable) {
        return res.status(401).json({ message: 'Invalid or expired conversable token' });
      }
      if (!interactiveShare.isActive || new Date() > getInteractiveShareExpiresAt(interactiveShare)) {
        return res.status(410).json({ message: 'Interactive share link has expired' });
      }
    }

    // Verify that the task execution exists in this session's messages
    let taskExecutionFound = false;
    for (const message of session.messages || []) {
      if (message.metadata?.toolCalls) {
        for (const toolCall of message.metadata.toolCalls) {
          if (toolCall.result && 
              toolCall.result.taskId === taskId && 
              toolCall.result.executionId === executionId) {
            taskExecutionFound = true;
            break;
          }
        }
      }
      if (taskExecutionFound) break;
    }

    if (!taskExecutionFound) {
      return res.status(404).json({ message: 'Task execution not found in this session' });
    }

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    // Only return basic execution data for public access
    res.json({
      executionId: execution.executionId,
      taskId: execution.taskId,
      status: execution.status,
      message: execution.message,
      result_files: execution.result_files || [],
      startTime: execution.startTime,
      endTime: execution.endTime
    });
  } catch (error) {
    console.error('Error in getTaskExecutionPublic:', error);
    res.status(500).json({ message: 'Error fetching task execution' });
  }
};

export const getExecutionLog = async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const logToken = req.query.token as string;
    
    if (!logToken) {
      return res.status(400).json({ message: 'Log token is required' });
    }
    
    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    if (!execution.browser_use_log) {
      return res.status(404).json({ message: 'Log file not found' });
    }

    // Extract the token from the S3 URL to verify
    const urlRegex = new RegExp(`activities_${executionId}_([a-z0-9]{20})\\.log`);
    const match = urlRegex.exec(execution.browser_use_log);
    
    if (!match || match[1] !== logToken) {
      return res.status(403).json({ message: 'Invalid log token' });
    }

    // Fetch the content directly from the URL
    const fetch = require('node-fetch');
    const response = await fetch(execution.browser_use_log);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch log from URL: ${response.status} ${response.statusText}`);
    }
    
    const logContent = await response.text();
    
    // Set CORS headers for public access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Set caching headers
    res.setHeader('Cache-Control', 'no-cache');
    
    // Send as HTML
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(logContent);
  } catch (error) {
    console.error('Error fetching execution log:', error);
    res.status(500).json({ message: 'Error fetching execution log' });
  }
};

export const generateShareToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    
    // Get the task to check permissions
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is admin or task owner
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    // If a share token already exists, use it; otherwise, generate a new one
    let shareToken = execution.shareToken;
    
    if (!shareToken) {
      // Generate a random token (16 characters)
      shareToken = crypto.randomBytes(8).toString('hex');
      
      // Save the token to the execution record
      await taskDb.updateTaskExecution(executionId, { shareToken });
    }
    
    res.json({ shareToken });
  } catch (error) {
    console.error('Error generating share token:', error);
    res.status(500).json({ message: 'Error generating share token' });
  }
};

export const getExecutionWithToken = async (req: Request, res: Response) => {
  try {
    const { executionId, token } = req.params;
    
    if (!executionId || !token) {
      return res.status(400).json({ message: 'Execution ID and token are required' });
    }
    
    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }
    
    // Verify the token matches
    if (execution.shareToken !== token) {
      return res.status(403).json({ message: 'Invalid token' });
    }
    
    // Get the task for additional context
    const task = await taskDb.getTaskById(execution.taskId);
    
    // Return the execution with minimal task info
    res.json({
      execution,
      task: task ? {
        taskId: task.taskId,
        name: task.name,
        prompt: task.prompt
      } : null
    });
  } catch (error) {
    console.error('Error fetching execution with token:', error);
    res.status(500).json({ message: 'Error fetching execution' });
  }
};

export const sendExecutionEmail = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: 'Email address is required' });
    }
    
    // Get the task to check permissions
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is admin or task owner
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }


    

    


    // Import emailService
    const { emailService } = require('../services/emailService');
    
    // Send the email using common function
    await emailService.sendTaskExecutionEmail(
      email,
      executionId
    );
    
    res.json({ message: `Execution details sent to ${email}` });
  } catch (error) {
    console.error('Error sending execution email:', error);
    res.status(500).json({ message: 'Error sending execution email' });
  }
}; 

export const uploadFileToExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const file = (req as any).file;

    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Verify task exists and user has access
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Verify task belongs to user or user is admin
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get the latest execution for this task
    const executions = await taskDb.getTaskExecutions(taskId);
    if (!executions || executions.length === 0) {
      return res.status(404).json({ message: 'No executions found for this task' });
    }

    // Sort by startTime to get the latest execution
    const latestExecution = executions.sort((a, b) => 
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    )[0];

    // Upload file to S3
    const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const key = `tasks/${taskId}/executions/${latestExecution.executionId}/uploads/${Date.now()}-${randomToken}-${file.originalname}`;

    await s3
      .putObject({
        Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    const url = `https://${
      process.env.AWS_S3_BUCKET || "agentweb-user-files"
    }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

    // Create new result file entry
    const newResultFile = {
      url,
      filename: file.originalname,
      token: randomToken,
      is_html: false,
      file_type: getAssetTypeFromFilename(file.originalname)
    };

    // Get current result_files and append the new file
    const currentResultFiles = latestExecution.result_files || [];
    const updatedResultFiles = [...currentResultFiles, newResultFile];

    // Update the execution with the new result file
    await taskDb.updateTaskExecution(latestExecution.executionId, {
      result_files: updatedResultFiles
    });

    res.status(200).json({
      message: 'File uploaded successfully',
      resultFile: newResultFile
    });
  } catch (error) {
    console.error('Error in uploadFileToExecution:', error);
    res.status(500).json({ message: 'Error uploading file' });
  }
}; 


export const getPlacidEditorToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // ENG-698: read from Secrets Manager (prod/AgentWeb/Placid), falling back to
    // the environment only where the secret does not exist. Not metered: minting
    // an editor access token is not a Placid render and carries no rate.
    const privateToken = await getPlacidPrivateToken();
    const templateUuid = (req.query?.template_uuid as string) || (req.body as any)?.template_uuid;
    if (!templateUuid) {
      return res.status(400).json({ message: 'template_uuid is required' });
    }
    if (!privateToken) {
      return res.status(500).json({ message: 'Placid private token is not configured' });
    }

    // Allow optional overrides via query/body if needed later
    const expSeconds = Math.floor(Date.now() / 1000) + 5 * 60; // default 5 minutes
    const defaultScopes: string[] = [];
    // Canvas needs read access to the selected template
    defaultScopes.push(`template:${templateUuid}:read`);
    const payload = {
      exp: expSeconds,
      scopes: (req.body && Array.isArray((req.body as any).scopes)) ? (req.body as any).scopes : defaultScopes,
      editor_options: (req.body && (req.body as any).editor_options) ? (req.body as any).editor_options : {
        enableCanvasResizing: true,
        enableCanvasTransparency: true,
        enableTemplateRenaming: false,
        enableButtonSave: false,
        enableButtonSaveAndClose: false,
        editorMode: 'inline',
      },
    } as any;

    const resp = await axios.post<{ access_token?: string }>(
      'https://api.placid.app/api/editor/accesstokens',
      payload,
      {
        headers: {
          Authorization: `Bearer ${privateToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const accessToken = resp.data && (resp.data as any).access_token;
    if (!accessToken) {
      return res.status(502).json({ message: 'Failed to obtain Placid editor token' });
    }

    return res.json({ token: accessToken });
  } catch (err: any) {
    console.error('Error issuing Placid editor token:', err?.message || err);
    return res.status(500).json({ message: 'Error issuing Placid editor token' });
  }
};

export const generateFromTemplateToExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { id: taskId, executionId } = req.params;
    const { template_uuid, layers, source_image_url, original_filename } = req.body as {
      template_uuid?: string;
      layers?: Record<string, Record<string, string | boolean | number>>;
      source_image_url?: string;
      original_filename?: string;
    };

    // ENG-1957: an image generated inside an Emma chat reaches this endpoint under
    // the synthetic ids the Images page groups it by (agent-mode-<sessionId> /
    // <sessionId>-images). Nothing in AW-Tasks or AW-TaskExecutions matches those,
    // so the task lookups below 404 every such render. Resolve them against the
    // chat session instead — same owner-or-admin rule the other session-mutating
    // endpoints use (favorite-image, uploadImageToSession).
    const agentSessionId = parseAgentModeImageIds(taskId, executionId);

    // Who the render is billed to, and whose page it lands on: the task owner, or
    // the session owner. Never the caller, who may be an admin acting for them.
    let renderOwnerId: string;
    // Only set on the task path; agent-mode renders have no execution row.
    let execution: Awaited<ReturnType<typeof taskDb.getTaskExecutionById>> | undefined;

    if (agentSessionId) {
      const session = await chatbotDb.getChatSession(agentSessionId);
      if (!session) return res.status(404).json({ message: 'Session not found' });
      const user = await userDb.getUserById(userId);
      if (!user) return res.status(401).json({ message: 'User not found' });
      // CodeRabbit, PR #2935. getChatSession hands back whatever DynamoDB holds,
      // and the legacy-shape migration never repairs `userId`. An owner-less row
      // would sail past the comparison below for an admin caller and then become
      // the billing subject and the S3 folder — `users/undefined/...` billed to
      // "undefined". Refuse before either use; a session nobody owns is a data
      // defect, not a render this endpoint can attribute.
      const sessionOwnerId = typeof session.userId === 'string' ? session.userId.trim() : '';
      if (!sessionOwnerId) {
        console.error('[Placid] chat session has no owner; refusing to render:', agentSessionId);
        return res.status(500).json({ message: 'Session owner is unknown' });
      }
      // Plain equality is delegation-safe: middleware/auth.ts already resolves
      // req.user to the target user for a delegated token.
      if (sessionOwnerId !== userId && !user.isAdmin) {
        return res.status(403).json({ message: 'Access denied' });
      }
      renderOwnerId = sessionOwnerId;
    } else {
      const task = await taskDb.getTaskById(taskId);
      if (!task) return res.status(404).json({ message: 'Task not found' });
      const user = await userDb.getUserById(userId);
      if (!user) return res.status(401).json({ message: 'User not found' });
      if (!user.isAdmin && task.userId !== userId) return res.status(403).json({ message: 'Access denied' });

      execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution || execution.taskId !== taskId) return res.status(404).json({ message: 'Execution not found' });
      renderOwnerId = task.userId;
    }

    const tplUuid = template_uuid || process.env.PLACID_TEMPLATE_UUID_AD_IMAGE;
    if (!tplUuid) return res.status(400).json({ message: 'template_uuid is required' });

    // ENG-1972: rendered through the REST API, not the URL API
    // (`api.placid.app/u/<uuid>`), which answers 403 for this project on every
    // render — parameter-free requests included — so no ad image could be created
    // at all. The REST API uses the private token this backend already holds and
    // already uses for the editor token and template listing, so it does not
    // depend on the project's URL-API settings.
    const placidToken = await getPlacidPrivateToken();
    if (!placidToken) {
      console.error('[Placid] private token is not configured; cannot render');
      return res.status(500).json({ message: 'Placid private token is not configured' });
    }

    // The REST body takes the same {layer: {prop: value}} shape the client already
    // sends, so the layers pass straight through; values keep their own types
    // rather than being stringified as the URL API's query notation required.
    // Supported properties are unchanged: text, image, hide, opacity, rotation,
    // position_x_absolute / position_y_absolute, position_x_relative /
    // position_y_relative, width, height.
    const restLayers: Record<string, Record<string, unknown>> = {};
    if (layers && typeof layers === 'object') {
      for (const [layerName, props] of Object.entries(layers)) {
        if (!props || typeof props !== 'object') continue;
        const cleaned: Record<string, unknown> = {};
        for (const [propName, value] of Object.entries(props)) {
          if (value === undefined || value === null) continue;
          cleaned[propName] = value;
        }
        if (Object.keys(cleaned).length > 0) restLayers[layerName] = cleaned;
      }
    }
    // Same convenience mapping the URL API expressed as `image[image]=`.
    if (source_image_url && restLayers.image?.image === undefined) {
      restLayers.image = { ...(restLayers.image || {}), image: source_image_url };
    }

    // ENG-698: a render that produced an image is a billed render, and the
    // recorder call lives with the egress in placidRenderService so the two
    // cannot drift (ENG-701's coverage guard enforces that). Bills the owner --
    // task owner, or session owner for a chat image -- while the acting caller,
    // who may be an admin, is kept in onBehalfOf.
    const placidOwner = renderOwnerId;
    const { imageUrl: placidImageUrl } = await renderPlacidImage({
      token: placidToken,
      templateUuid: tplUuid,
      layers: restLayers,
      billing: {
        userId,
        billingUserId: placidOwner,
        ...(userId && placidOwner && userId !== placidOwner ? { onBehalfOf: userId } : {}),
        ...(agentSessionId ? { sessionId: agentSessionId } : {}),
      },
    });

    // The REST API returns a URL rather than the bytes, so fetch it; everything
    // downstream (S3 layout, result file, session message) is unchanged.
    // Bounded: axios has no default timeout, so a stalled download would hold
    // this request (and its resources) open indefinitely (CodeRabbit, #2943).
    const imgResp = await axios.get<ArrayBuffer>(placidImageUrl, {
      responseType: 'arraybuffer' as const,
      timeout: 30_000,
    });
    const contentType = (imgResp.headers['content-type'] as string) || 'image/png';
    const ext = contentType.includes('jpeg')
      ? 'jpg'
      : contentType.includes('png')
      ? 'png'
      : contentType.includes('webp')
      ? 'webp'
      : 'png';

    const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Create filename based on original name and template ID
    let baseNameWithoutExt = 'placid-generated';
    if (original_filename) {
      // Remove extension from original filename
      const lastDotIndex = original_filename.lastIndexOf('.');
      baseNameWithoutExt = lastDotIndex > 0 ? original_filename.substring(0, lastDotIndex) : original_filename;
    }
    
    // Get short template ID (first 8 characters for readability)
    const shortTemplateId = tplUuid ? tplUuid.substring(0, 8) : 'unknown';
    
    const filenameBase = `${baseNameWithoutExt}-placid-${shortTemplateId}`;
    const filename = `${filenameBase}.${ext}`;
    const imageBuffer = Buffer.from(new Uint8Array(imgResp.data));

    let url: string;
    if (agentSessionId) {
      // Filed under the session owner, not the caller: the image belongs to their
      // chat and shows on their Images page even when an admin rendered it for
      // them. Same S3 layout as every other agent-mode image (uploadImageToSession).
      const uploadResult = await uploadFileToS3(imageBuffer, filename, renderOwnerId, contentType);
      if (!uploadResult.success || !uploadResult.url) {
        console.error('[Placid] S3 upload failed for agent-mode render:', uploadResult.error);
        return res.status(500).json({ message: 'Error generating image' });
      }
      url = uploadResult.url;
    } else {
      const key = `tasks/${taskId}/executions/${executionId}/edits/${randomToken}/${filenameBase}.${ext}`;
      await s3
        .putObject({
          Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
          Key: key,
          Body: imageBuffer,
          ContentType: contentType,
        })
        .promise();

      url = `https://${
        process.env.AWS_S3_BUCKET || 'agentweb-user-files'
      }.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${key}`;
    }

    const newResultFile = {
      url,
      filename,
      // Agent-mode files carry no execution token; the aggregator synthesizes
      // them with an empty one (routes/tasks.ts addCachedAssetsToResult).
      token: agentSessionId ? '' : randomToken,
      is_html: false,
      file_type: 'image',
      ...(agentSessionId ? { source: 'agent-mode', sessionId: agentSessionId } : {}),
      placid_config: {
        template_uuid: tplUuid,
        layers: layers || {},
        source_image_url: source_image_url,
        original_filename: original_filename
      }
    };

    if (agentSessionId) {
      // The Images page derives agent-mode images by scanning session messages
      // (scanMessagesForAssets), so the render is persisted as one, in the shape
      // uploadImageToSession writes. addMessageToSession bumps messageCount, so
      // the next read rescans and the image appears in assetCache.
      const renderedAt = new Date().toISOString();
      const attachMessage = () => chatbotDb.addMessageToSession(agentSessionId, {
        role: 'system' as const,
        content: `Image generated from Placid template: ${filename}`,
        timestamp: renderedAt,
        metadata: {
          portalType: 'agent' as const,
          timestamp: renderedAt,
          toolCalls: [
            {
              id: uuidv4(),
              name: 'upload_image',
              arguments: {},
              result: {
                success: true,
                imageUrl: url,
                filename,
                message: `✅ Image "${filename}" created from template!`,
              },
            },
          ],
        },
      });

      // Greptile, PR #2935. By this point Placid has rendered and the customer
      // has been billed, and the image is in S3 — if this last write is lost the
      // image exists but nothing references it, so it never reaches the Images
      // page. Retry the transient shapes, and when it still fails say so and log
      // the URL, rather than reporting a generic 500 that buries a paid render.
      // (A retry by the user is a genuinely new Placid render and is billed as
      // one; that is real vendor spend, not a double count.)
      //
      // addMessageToSession is not idempotent: it appends at the current count,
      // so retrying a write whose RESPONSE was lost — rather than whose write was
      // rejected — would append the same image a second time. The asset scanner
      // de-dupes by URL only within one pass, and the incremental cache merge
      // concatenates passes, so the second copy would surface as a duplicate
      // image. Before every retry, check whether the previous attempt actually
      // landed; the S3 URL is unique to this render, so it is the stable identity.
      let attachAttempted = false;
      const alreadyAttached = async (): Promise<boolean> => {
        try {
          const existing = await chatbotDb.getMessagesFromMessagesTable(agentSessionId);
          return (existing || []).some((m: any) =>
            (m?.metadata?.toolCalls || []).some((tc: any) => tc?.result?.imageUrl === url),
          );
        } catch {
          // Unreadable: fall through and retry. A duplicate is recoverable by
          // hand; a silently dropped paid render is not.
          return false;
        }
      };

      try {
        await retryTransientWrite(async () => {
          if (attachAttempted && (await alreadyAttached())) return;
          attachAttempted = true;
          await attachMessage();
        });
      } catch (attachErr) {
        console.error(
          `[Placid] billed render not attached to session ${agentSessionId}; image is orphaned at ${url}:`,
          attachErr instanceof Error ? attachErr.message : attachErr,
        );
        return res.status(500).json({
          message: 'Image was generated but could not be saved to this chat',
          resultFile: newResultFile,
        });
      }
    } else {
      const current = execution?.result_files || [];
      const updated = [...current, newResultFile];
      await taskDb.updateTaskExecution(executionId, { result_files: updated });
    }

    return res.status(200).json({ message: 'Generated image from template', resultFile: newResultFile });
  } catch (err: any) {
    // describePlacidError surfaces the vendor's own message (ENG-1972); for any
    // other failure it falls back to the error's message unchanged.
    console.error('Error in generateFromTemplateToExecution:', describePlacidError(err));
    return res.status(500).json({ message: 'Error generating image' });
  }
};

export const listPlacidTemplates = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // ENG-698: Secrets Manager first, environment fallback. Not metered: listing
    // templates is a catalogue read, not a render, and carries no rate.
    const privateToken = await getPlacidPrivateToken();
    if (!privateToken) return res.status(500).json({ message: 'Placid private token is not configured' });

    const { page, per_page, collection_id } = req.query as {
      page?: string;
      per_page?: string;
      collection_id?: string;
    };

    const params: Record<string, string> = {};
    if (page) params.page = page;
    if (per_page) params.per_page = per_page;
    if (collection_id) params.collection_id = collection_id;

    const resp = await axios.get('https://api.placid.app/api/rest/templates', {
      headers: { Authorization: `Bearer ${privateToken}` },
      params,
    });

    return res.json(resp.data);
  } catch (err: any) {
    console.error('Error listing Placid templates:', err?.response?.data || err?.message || err);
    return res.status(500).json({ message: 'Error listing templates' });
  }
};

export const createRevisionExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const { revision_prompt, image_url, report_url, original_execution_id, variations } = req.body;
    
    // Support both image_url (for images) and report_url (for HTML reports)
    const assetUrl = image_url || report_url;
    if (!revision_prompt || !assetUrl || !original_execution_id) {
      return res.status(400).json({ message: 'Missing required fields: revision_prompt, asset_url (image_url or report_url), original_execution_id' });
    }

    // Get the task to verify ownership and get the original prompt
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Verify task belongs to user or user is admin
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Check if this is a report revision (has report_url but no image_url)
    const isReportRevision = report_url && !image_url;

    if (isReportRevision) {
      // Use backend revision for HTML reports - process synchronously
      const revisionExecution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId,
        run_user_id: userId !== task.userId ? userId : undefined,
        status: 'running',
        startTime: new Date().toISOString(),
        prompt: revision_prompt,
        revision_prompt: revision_prompt,
        original_report_url: report_url,
        original_execution_id: original_execution_id,
        revision_type: 'backend_ai',
        requireApproval: task.requireApproval || false,
        slack_channel: task.slackChannel || null
      };

      await taskDb.createTaskExecution(revisionExecution);

      try {
        // Import the report revision service
        const { reportRevisionService } = await import('../services/reportRevisionService');

        // Process the revision synchronously
        const revisionResult = await reportRevisionService.createReportRevision(
          taskId,
          revisionExecution.executionId,
          report_url,
          revision_prompt,
          userId,
          original_execution_id
        );

        if (revisionResult.success) {
          // Update the execution with the completed result
          const completedExecution = {
            ...revisionExecution,
            status: 'completed',
            completedAt: new Date().toISOString(),
            result_files: revisionResult.resultFile ? [revisionResult.resultFile] : []
          };

          res.status(201).json({ 
            success: true, 
            execution: completedExecution,
            message: 'Report revision completed successfully.',
            resultFile: revisionResult.resultFile
          });
        } else {
          // Update the execution with the failed result
          const failedExecution = {
            ...revisionExecution,
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: revisionResult.error || 'Unknown error'
          };

          res.status(500).json({ 
            success: false, 
            execution: failedExecution,
            message: 'Report revision failed.',
            error: revisionResult.error
          });
        }
      } catch (error) {
        console.error('Error in synchronous report revision:', error);
        
        // Update the execution with the error
        const errorExecution = {
          ...revisionExecution,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Unknown error'
        };

        res.status(500).json({ 
          success: false, 
          execution: errorExecution,
          message: 'Report revision failed.',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    } else {
      // Use agent-engine for image revisions (original behavior)
      const execution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId, // Use the task owner's ID for execution
        run_user_id: userId !== task.userId ? userId : undefined, // Record who actually ran the task if different from owner
        status: 'pending',
        startTime: new Date().toISOString(),
        revision_prompt: revision_prompt,
        original_image_url: image_url || undefined,
        original_report_url: report_url || undefined,
        original_execution_id: original_execution_id,
        variations: variations || 1
      };

      await taskDb.createTaskExecution(execution);
      res.status(201).json({ success: true, execution });
    }
  } catch (error) {
    console.error('Error creating revision execution:', error);
    res.status(500).json({ message: 'Error creating revision execution' });
  }
};


// Function that can be called from Slack without Express request/response objects
export const updateReport = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { report_url, execution_id, revision_prompt, task_id } = req.body;
    
    if (!report_url || !execution_id || !revision_prompt) {
      return res.status(400).json({ 
        message: 'Missing required fields: report_url, execution_id, revision_prompt' 
      });
    }

    // Get the execution to verify ownership
    const execution = await taskDb.getTaskExecutionById(execution_id);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Get the task to verify ownership
    const task = await taskDb.getTaskById(execution.taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Verify task belongs to user or user is admin
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Import the report revision service
    const { reportRevisionService } = await import('../services/reportRevisionService');

    // Update the report
    const result = await reportRevisionService.updateReport(
      report_url,
      execution_id,
      revision_prompt,
      task_id || task.taskId
    );

    if (result.success) {
      return res.status(200).json({ 
        message: 'Report updated successfully',
        resultFile: result.resultFile
      });
    } else {
      return res.status(500).json({ 
        message: 'Failed to update report',
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error updating report:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

export const createRevisionExecutionFromSlack = async (
  taskId: string,
  revisionPrompt: string,
  assetUrl: string,
  originalExecutionId: string,
  assetType: string,
  runUserId: string,
  variations: number = 1,
  slackChannel?: string,
  slackChannelName?: string
) => {
  try {
    // Only support revision for image and html assets
    if (assetType !== 'image' && assetType !== 'html') {
      console.log(`⚠️ Skipping revision for unsupported asset type: ${assetType}`);
      return { success: false, message: `Revision not supported for asset type: ${assetType}` };
    }

    // Get the task to verify ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      throw new Error('Task not found');
    }

    // Check if this is a report revision (html asset type)
    const isReportRevision = assetType === 'html';

    if (isReportRevision) {
      // Use backend revision for HTML reports
      const revisionExecution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId,
        run_user_id: runUserId,
        status: 'running',
        startTime: new Date().toISOString(),
        prompt: revisionPrompt,
        revision_prompt: revisionPrompt,
        original_report_url: assetUrl,
        original_execution_id: originalExecutionId,
        revision_type: 'backend_ai',
        slack_channel: slackChannel,
        slack_channel_name: slackChannelName,
        requireApproval: true,
        approvalAssetType: assetType
      };

      await taskDb.createTaskExecution(revisionExecution);

      // Import the report revision service
      const { reportRevisionService } = await import('../services/reportRevisionService');

      // Start the revision process asynchronously
      reportRevisionService.createReportRevision(
        taskId,
        revisionExecution.executionId,
        assetUrl,
        revisionPrompt,
        runUserId,
        originalExecutionId
      ).catch(error => {
        console.error('Error in background report revision from Slack:', error);
      });

      // Update the approval status to 'revision_submitted' to indicate revision is in progress
      try {
        const { approvalDb } = await import('../services/approvalDb');
        // Get the original execution to find the asset URL
        const originalExecution = await taskDb.getTaskExecutionById(originalExecutionId);
        if (originalExecution && originalExecution.result_files && originalExecution.result_files.length > 0) {
          const originalAssetUrl = originalExecution.result_files[0].url;
          await approvalDb.updateApprovalStatus(
            originalAssetUrl,
            'revision_submitted',
            runUserId,
            `Revision execution ${revisionExecution.executionId} started based on feedback: ${revisionPrompt}`
          );
        }
      } catch (error) {
        console.error('Error updating original approval status:', error);
        // Don't fail the revision if approval update fails
      }

      return { 
        success: true, 
        execution: revisionExecution,
        message: 'Report revision started. The revision will be processed in the background.'
      };
    } else {
      // Use agent-engine for image revisions (original behavior)
      const execution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId, // Use the task owner's ID for execution
        run_user_id: runUserId, // Record who provided the feedback
        status: 'pending',
        startTime: new Date().toISOString(),
        revision_prompt: revisionPrompt,
        original_image_url: assetUrl,
        original_report_url: undefined,
        original_execution_id: originalExecutionId,
        variations: variations,
        // Add Slack channel info for agent-engine to use
        slack_channel: slackChannel,
        slack_channel_name: slackChannelName,
        requireApproval: true,  // Revision executions always require approval
        approvalAssetType: assetType  // Record the asset type that was approved/rejected
      };

      await taskDb.createTaskExecution(execution);

      // Update the approval status to 'revision_submitted' to indicate revision is in progress
      try {
        const { approvalDb } = await import('../services/approvalDb');
        // Get the original execution to find the asset URL
        const originalExecution = await taskDb.getTaskExecutionById(originalExecutionId);
        if (originalExecution && originalExecution.result_files && originalExecution.result_files.length > 0) {
          const originalAssetUrl = originalExecution.result_files[0].url;
          await approvalDb.updateApprovalStatus(
            originalAssetUrl,
            'revision_submitted',
            runUserId,
            `Revision execution ${execution.executionId} started based on feedback: ${revisionPrompt}`
          );
        }
      } catch (error) {
        console.error('Error updating original approval status:', error);
        // Don't fail the revision if approval update fails
      }

      return { success: true, execution };
    }
  } catch (error) {
    console.error('Error creating revision execution from Slack:', error);
    throw error;
  }
};