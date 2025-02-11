import { DynamoDB } from 'aws-sdk';
import { handleDynamoError } from '../utils/errorHandler';
import { TABLE_PREFIX } from '../config/constants';
import { taskDb } from './db';

const dynamodb = new DynamoDB.DocumentClient();

export interface WorkflowTask {
  taskId: string;
  status: string;
  order: number;
  dependsOn?: string[];
  error?: string;
  completedAt?: string;
}

export interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  userId: string;
  status: string;
  startTime: string;
  tasks: WorkflowTask[];
  error?: string;
  completedAt?: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  data: {
    taskId: string;
    label: string;
    order?: number;
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  yaml: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export const workflowDb = {
  async getWorkflow(id: string): Promise<Workflow | undefined> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-Workflows`,
        Key: { workflowId: id }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item as Workflow;
    } catch (error) {
      console.error('Error in getWorkflow:', error);
      throw error;
    }
  },

  async createWorkflowExecution(execution: WorkflowExecution) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
        Item: execution
      };

      await dynamodb.put(params).promise();
      return execution;
    } catch (error) {
      console.error('Error in createWorkflowExecution:', error);
      throw error;
    }
  },

  async getWorkflowExecution(executionId: string): Promise<WorkflowExecution | undefined> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
        Key: { executionId }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item as WorkflowExecution;
    } catch (error) {
      console.error('Error in getWorkflowExecution:', error);
      throw error;
    }
  },

  async updateWorkflowExecutionStatus(executionId: string, status: string, error?: string) {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
        Key: { executionId },
        UpdateExpression: 'SET #status = :status, completedAt = :completedAt' + (error ? ', #error = :error' : ''),
        ExpressionAttributeNames: {
          '#status': 'status',
          ...(error && { '#error': 'error' })
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':completedAt': new Date().toISOString(),
          ...(error && { ':error': error })
        }
      };

      await dynamodb.update(params).promise();
    } catch (error) {
      console.error('Error in updateWorkflowExecutionStatus:', error);
      throw error;
    }
  },

  async updateWorkflowTaskStatus(executionId: string, taskId: string, status: string, error?: string) {
    try {
      const execution = await this.getWorkflowExecution(executionId);
      if (!execution) throw new Error('Workflow execution not found');

      const updatedTasks = execution.tasks.map((task: WorkflowTask) => {
        if (task.taskId === taskId) {
          return {
            ...task,
            status,
            ...(error && { error }),
            completedAt: status === 'completed' || status === 'failed' ? new Date().toISOString() : undefined
          };
        }
        return task;
      });

      const params = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
        Key: { executionId },
        UpdateExpression: 'SET tasks = :tasks',
        ExpressionAttributeValues: {
          ':tasks': updatedTasks
        }
      };

      await dynamodb.update(params).promise();

      // Check if all tasks are completed or failed
      const allTasksFinished = updatedTasks.every((task: WorkflowTask) => 
        task.status === 'completed' || task.status === 'failed'
      );

      if (allTasksFinished) {
        const anyTaskFailed = updatedTasks.some((task: WorkflowTask) => task.status === 'failed');
        await this.updateWorkflowExecutionStatus(
          executionId,
          anyTaskFailed ? 'failed' : 'completed',
          anyTaskFailed ? 'One or more tasks failed' : undefined
        );
      }

      return updatedTasks;
    } catch (error) {
      console.error('Error in updateWorkflowTaskStatus:', error);
      throw error;
    }
  },

  async getWorkflowExecutions(workflowId: string): Promise<WorkflowExecution[]> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
        IndexName: 'WorkflowExecutionsIndex',
        KeyConditionExpression: 'workflowId = :workflowId',
        ExpressionAttributeValues: {
          ':workflowId': workflowId
        },
        ScanIndexForward: false
      };

      const result = await dynamodb.query(params).promise();
      return (result.Items || []) as WorkflowExecution[];
    } catch (error) {
      console.error('Error in getWorkflowExecutions:', error);
      throw error;
    }
  },

  async getPendingWorkflowExecutions(): Promise<WorkflowExecution[]> {
    try {
      const params = {
        TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
        IndexName: 'StatusStartTimeIndex',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': 'pending'
        }
      };

      const result = await dynamodb.query(params).promise();
      return (result.Items || []) as WorkflowExecution[];
    } catch (error) {
      console.error('Error in getPendingWorkflowExecutions:', error);
      throw error;
    }
  }
}; 