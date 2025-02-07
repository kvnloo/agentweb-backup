import { DynamoDB } from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { TABLE_PREFIX } from '../config/constants';

export interface Workflow {
  workflowId: string;
  userId: string;
  name: string;
  description: string;
  status: 'active' | 'draft' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNode {
  nodeId: string;
  workflowId: string;
  type: 'task' | 'loop' | 'condition';
  position: {
    x: number;
    y: number;
  };
  data: {
    label: string;
    taskId?: string;
    condition?: string;
    loopCount?: number;
  };
}

export interface WorkflowEdge {
  edgeId: string;
  workflowId: string;
  sourceId: string;
  targetId: string;
  data?: {
    condition?: string;
  };
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
      updatedAt: now
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

  async updateWorkflow(workflowId: string, updates: Partial<Workflow>): Promise<Workflow> {
    const updateExpr = Object.keys(updates).map(key => `#${key} = :${key}`).join(', ');
    const exprAttrNames = Object.keys(updates).reduce((acc, key) => ({ ...acc, [`#${key}`]: key }), {});
    const exprAttrValues = Object.entries(updates).reduce((acc, [key, value]) => ({ ...acc, [`:${key}`]: value }), {});

    const result = await this.dynamodb.update({
      TableName: `${TABLE_PREFIX}AW-Workflows`,
      Key: { workflowId },
      UpdateExpression: `SET ${updateExpr}, #updatedAt = :updatedAt`,
      ExpressionAttributeNames: { ...exprAttrNames, '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ...exprAttrValues, ':updatedAt': new Date().toISOString() },
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

  // Workflow Nodes operations
  async saveWorkflowNodes(workflowId: string, nodes: Omit<WorkflowNode, 'nodeId'>[]): Promise<WorkflowNode[]> {
    const savedNodes: WorkflowNode[] = [];

    for (const node of nodes) {
      const nodeId = uuidv4();
      const newNode: WorkflowNode = {
        ...node,
        nodeId,
        workflowId
      };

      await this.dynamodb.put({
        TableName: `${TABLE_PREFIX}AW-WorkflowNodes`,
        Item: newNode
      }).promise();

      savedNodes.push(newNode);
    }

    return savedNodes;
  }

  async getWorkflowNodes(workflowId: string): Promise<WorkflowNode[]> {
    const result = await this.dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-WorkflowNodes`,
      IndexName: 'WorkflowNodesIndex',
      KeyConditionExpression: 'workflowId = :workflowId',
      ExpressionAttributeValues: {
        ':workflowId': workflowId
      }
    }).promise();

    return result.Items as WorkflowNode[];
  }

  // Workflow Edges operations
  async saveWorkflowEdges(workflowId: string, edges: Omit<WorkflowEdge, 'edgeId'>[]): Promise<WorkflowEdge[]> {
    const savedEdges: WorkflowEdge[] = [];

    for (const edge of edges) {
      const edgeId = uuidv4();
      const newEdge: WorkflowEdge = {
        ...edge,
        edgeId,
        workflowId
      };

      await this.dynamodb.put({
        TableName: `${TABLE_PREFIX}AW-WorkflowEdges`,
        Item: newEdge
      }).promise();

      savedEdges.push(newEdge);
    }

    return savedEdges;
  }

  async getWorkflowEdges(workflowId: string): Promise<WorkflowEdge[]> {
    const result = await this.dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-WorkflowEdges`,
      IndexName: 'WorkflowEdgesIndex',
      KeyConditionExpression: 'workflowId = :workflowId',
      ExpressionAttributeValues: {
        ':workflowId': workflowId
      }
    }).promise();

    return result.Items as WorkflowEdge[];
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