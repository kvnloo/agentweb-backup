import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

export interface InputField {
  name: string;
  label: string;
  type: 'text' | 'url' | 'email' | 'textarea';
  required: boolean;
}

export interface LeadMagnetConfig {
  configId: string;
  name: string;
  inputSchema: {
    fields: InputField[];
  };
  taskTemplateId: string;
  resultGate: 'blur' | 'truncate' | 'preview';
  ctaText: string;
  landingPageSlug: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const VALID_RESULT_GATES = ['blur', 'truncate', 'preview'];

export class LeadMagnetConfigDb {
  private tableName: string;
  private docClient: AWS.DynamoDB.DocumentClient;

  constructor(tableName?: string) {
    const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    this.tableName = tableName || `${TABLE_PREFIX}AW-LeadMagnetConfigs`;
    this.docClient = new AWS.DynamoDB.DocumentClient();
  }

  private validate(config: Partial<LeadMagnetConfig>): void {
    if (!config.name) {
      throw new Error('name is required');
    }
    if (!config.taskTemplateId) {
      throw new Error('taskTemplateId is required');
    }
    if (config.resultGate && !VALID_RESULT_GATES.includes(config.resultGate)) {
      throw new Error(`resultGate must be one of: ${VALID_RESULT_GATES.join(', ')}`);
    }
  }

  async create(
    input: Omit<LeadMagnetConfig, 'configId' | 'createdAt' | 'updatedAt'>,
  ): Promise<LeadMagnetConfig> {
    this.validate(input);

    const now = new Date().toISOString();
    const config: LeadMagnetConfig = {
      ...input,
      configId: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    await this.docClient
      .put({
        TableName: this.tableName,
        Item: config,
      })
      .promise();

    return config;
  }

  async getById(configId: string): Promise<LeadMagnetConfig | null> {
    const result = await this.docClient
      .get({
        TableName: this.tableName,
        Key: { configId },
      })
      .promise();

    return (result.Item as LeadMagnetConfig) || null;
  }

  async getBySlug(slug: string): Promise<LeadMagnetConfig | null> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression: 'landingPageSlug = :slug',
        ExpressionAttributeValues: { ':slug': slug },
      })
      .promise();

    const items = result.Items as LeadMagnetConfig[];
    return items && items.length > 0 ? items[0] : null;
  }

  async listAll(): Promise<LeadMagnetConfig[]> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
      })
      .promise();

    return (result.Items as LeadMagnetConfig[]) || [];
  }

  async listEnabled(): Promise<LeadMagnetConfig[]> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression: 'enabled = :enabled',
        ExpressionAttributeValues: { ':enabled': true },
      })
      .promise();

    return (result.Items as LeadMagnetConfig[]) || [];
  }

  async update(
    configId: string,
    updates: Partial<Omit<LeadMagnetConfig, 'configId' | 'createdAt'>>,
  ): Promise<LeadMagnetConfig> {
    const existing = await this.getById(configId);
    if (!existing) {
      throw new Error(`Config not found: ${configId}`);
    }

    const merged = {
      ...existing,
      ...updates,
      configId: existing.configId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.validate(merged);

    await this.docClient
      .put({
        TableName: this.tableName,
        Item: merged,
      })
      .promise();

    return merged;
  }

  async deleteById(configId: string): Promise<void> {
    await this.docClient
      .delete({
        TableName: this.tableName,
        Key: { configId },
      })
      .promise();
  }
}

// Lazy singleton — avoids DynamoDB client creation at import time (breaks test mocks)
let _instance: LeadMagnetConfigDb | null = null;
export function getLeadMagnetConfigDb(): LeadMagnetConfigDb {
  if (!_instance) _instance = new LeadMagnetConfigDb();
  return _instance;
}
