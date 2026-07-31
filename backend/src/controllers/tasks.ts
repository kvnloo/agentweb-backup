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
    const hasInteractiveShare = session.interactiveShareMetadata?.isActive;
    
    if (!hasViewOnlyShare && !hasInteractiveShare) {
      return res.status(404).json({ message: 'Session is not shared' });
    }

    // Check if the session has expired (for view-only shares)
    if (hasViewOnlyShare && session.shareMetadata?.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
      return res.status(410).json({ message: 'Share link has expired' });
    }
    
    // Check if the interactive share has expired (interactive shares don't have expiration for now)
    // if (hasInteractiveShare && session.interactiveShareMetadata?.expiresAt && new Date() > new Date(session.interactiveShareMetadata.expiresAt)) {
    //   return res.status(410).json({ message: 'Interactive share link has expired' });
    // }

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

    const privateToken = process.env.PLACID_PRIVATE_TOKEN;
    const templateUuid = (req.query?.template_uuid as string) || (req.body as any)?.template_uuid;
    if (!templateUuid) {
      return res.status(400).json({ message: 'template_uuid is required' });
    }
    if (!privateToken) {
      return res.status(500).json({ message: 'PLACID_PRIVATE_TOKEN must be set' });
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

    const task = await taskDb.getTaskById(taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(401).json({ message: 'User not found' });
    if (!user.isAdmin && task.userId !== userId) return res.status(403).json({ message: 'Access denied' });

    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution || execution.taskId !== taskId) return res.status(404).json({ message: 'Execution not found' });

    const tplUuid = template_uuid || process.env.PLACID_TEMPLATE_UUID_AD_IMAGE;
    if (!tplUuid) return res.status(400).json({ message: 'template_uuid is required' });

    const base = process.env.PLACID_URL_API_BASE || 'https://api.placid.app/u';
    const params = new URLSearchParams();
    // Map provided layers -> URL API notation
    // Note: The following properties will be sent to Placid API:
    // - 'hide' (boolean): Set true to hide this layer; defaults to false
    // - 'opacity' (number): Adjust layer opacity from 0 to 100
    // - 'rotation' (number): Set layer rotation from 0 to 359 degrees
    // - 'position_x_absolute' (string): Set absolute X position (e.g., "10px")
    // - 'position_y_absolute' (string): Set absolute Y position (e.g., "10px")
    // - 'position_x_relative' (string): Set relative X position (e.g., "+10px", "-10px")
    // - 'position_y_relative' (string): Set relative Y position (e.g., "+10px", "-10px")
    // - 'width' (string): Set width (e.g., "50%", "+10px", "100px")
    // - 'height' (string): Set height (e.g., "50%", "+10px", "100px")
    // Placid will handle all these properties to control layer appearance and positioning
    if (layers && typeof layers === 'object') {
      for (const [layerName, props] of Object.entries(layers)) {
        if (!props || typeof props !== 'object') continue;
        for (const [propName, value] of Object.entries(props)) {
          if (value === undefined || value === null) continue;
          params.set(`${layerName}[${propName}]`, String(value));
        }
      }
    }
    // Optional convenience mapping for source image
    if (source_image_url && !params.has('image[image]')) {
      params.set('image[image]', source_image_url);
    }
    const placidImageUrl = `${base}/${tplUuid}${params.toString() ? `?${params.toString()}` : ''}`;

    const imgResp = await axios.get<ArrayBuffer>(placidImageUrl, { responseType: 'arraybuffer' as const });
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
    const key = `tasks/${taskId}/executions/${executionId}/edits/${randomToken}/${filenameBase}.${ext}`;
    const imageBuffer = Buffer.from(new Uint8Array(imgResp.data));

    await s3
      .putObject({
        Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
        Key: key,
        Body: imageBuffer,
        ContentType: contentType,
      })
      .promise();

    const url = `https://${
      process.env.AWS_S3_BUCKET || 'agentweb-user-files'
    }.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${key}`;

    const newResultFile = {
      url,
      filename: `${filenameBase}.${ext}`,
      token: randomToken,
      is_html: false,
      file_type: 'image',
      placid_config: {
        template_uuid: tplUuid,
        layers: layers || {},
        source_image_url: source_image_url,
        original_filename: original_filename
      }
    };

    const current = execution.result_files || [];
    const updated = [...current, newResultFile];
    await taskDb.updateTaskExecution(executionId, { result_files: updated });

    return res.status(200).json({ message: 'Generated image from template', resultFile: newResultFile });
  } catch (err: any) {
    console.error('Error in generateFromTemplateToExecution:', err?.message || err);
    return res.status(500).json({ message: 'Error generating image' });
  }
};

export const listPlacidTemplates = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const privateToken = process.env.PLACID_PRIVATE_TOKEN;
    if (!privateToken) return res.status(500).json({ message: 'PLACID_PRIVATE_TOKEN must be set' });

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