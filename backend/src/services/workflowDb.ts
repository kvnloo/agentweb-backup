import { DynamoDB } from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { TABLE_PREFIX } from '../config/constants';

export interface Workflow {
  workflowId: string;
  userId: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  yaml: string;
  taskCount: number;
  chatHistory: {
    role: 'user' | 'assistant';
    content: string;
  }[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  userId: string;
  status: 'success' | 'failed' | 'running' | 'pending';
  startTime: string;
  endTime?: string;
  duration?: string;
  error?: string;
  tasks: {
    nodeId: string;
    taskId: string;
    status: 'success' | 'failed' | 'running' | 'pending';
    startTime: string;
    endTime?: string;
    error?: string;
  }[];
}

export class WorkflowService {
  private dynamodb: DynamoDB.DocumentClient;

  constructor() {
    this.dynamodb = new DynamoDB.DocumentClient();
  }

  // Workflow CRUD operations
  async createWorkflow(workflow: Omit<Workflow, 'workflowId' | 'createdAt' | 'updatedAt'>): Promise<Workflow> {
    const now = new Date().toISOString();
    const workflowId = uuidv4();
    const newWorkflow: Workflow = {
      ...workflow,
      workflowId,
      createdAt: now,
      updatedAt: now,
      yaml: workflow.yaml || '',
      chatHistory: workflow.chatHistory || []
    };

    await this.dynamodb.put({
      TableName: `${TABLE_PREFIX}AW-Workflows`,
      Item: newWorkflow
    }).promise();

    return newWorkflow;
  }

  async getWorkflow(workflowId: string): Promise<Workflow | null> {
    const result = await this.dynamodb.get({
      TableName: `${TABLE_PREFIX}AW-Workflows`,
      Key: { workflowId }
    }).promise();

    return result.Item as Workflow || null;
  }

  async updateWorkflow(
    workflowId: string, 
    updates: Partial<Omit<Workflow, 'workflowId' | 'createdAt'>>
  ): Promise<Workflow> {
    const now = new Date().toISOString();
    const updateExpr = Object.keys(updates)
      .map(key => `#${key} = :${key}`)
      .concat(['#updatedAt = :updatedAt'])
      .join(', ');

    const exprAttrNames = Object.keys(updates)
      .reduce((acc, key) => ({ ...acc, [`#${key}`]: key }), {
        '#updatedAt': 'updatedAt'
      });

    const exprAttrValues = Object.entries(updates)
      .reduce((acc, [key, value]) => ({ ...acc, [`:${key}`]: value }), {
        ':updatedAt': now
      });

    const result = await this.dynamodb.update({
      TableName: `${TABLE_PREFIX}AW-Workflows`,
      Key: { workflowId },
      UpdateExpression: `SET ${updateExpr}`,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
      ReturnValues: 'ALL_NEW'
    }).promise();

    return result.Attributes as Workflow;
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.dynamodb.delete({
      TableName: `${TABLE_PREFIX}AW-Workflows`,
      Key: { workflowId }
    }).promise();
  }

  async listUserWorkflows(userId: string): Promise<Workflow[]> {
    const result = await this.dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Workflows`,
      IndexName: 'UserWorkflowsIndex',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }).promise();

    return result.Items as Workflow[];
  }

  // Workflow Executions operations
  async createWorkflowExecution(execution: Omit<WorkflowExecution, 'executionId'>): Promise<WorkflowExecution> {
    const executionId = uuidv4();
    const newExecution: WorkflowExecution = {
      ...execution,
      executionId
    };

    await this.dynamodb.put({
      TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
      Item: newExecution
    }).promise();

    return newExecution;
  }

  async updateWorkflowExecution(executionId: string, updates: Partial<WorkflowExecution>): Promise<WorkflowExecution> {
    const updateExpr = Object.keys(updates).map(key => `#${key} = :${key}`).join(', ');
    const exprAttrNames = Object.keys(updates).reduce((acc, key) => ({ ...acc, [`#${key}`]: key }), {});
    const exprAttrValues = Object.entries(updates).reduce((acc, [key, value]) => ({ ...acc, [`:${key}`]: value }), {});

    const result = await this.dynamodb.update({
      TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
      Key: { executionId },
      UpdateExpression: `SET ${updateExpr}`,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
      ReturnValues: 'ALL_NEW'
    }).promise();

    return result.Attributes as WorkflowExecution;
  }

  async getWorkflowExecutions(workflowId: string): Promise<WorkflowExecution[]> {
    const result = await this.dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-WorkflowExecutions`,
      IndexName: 'WorkflowExecutionsIndex',
      KeyConditionExpression: 'workflowId = :workflowId',
      ExpressionAttributeValues: {
        ':workflowId': workflowId
      },
      ScanIndexForward: false // Get latest executions first
    }).promise();

    return result.Items as WorkflowExecution[];
  }
} 