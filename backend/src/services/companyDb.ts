/**
 * AW-CRMCompanies — persistent Account/Company objects for ABM workflows.
 *
 * Table schema:
 *   PK:  companyId (string)
 *   GSIs:
 *     - userId-createdAt-index  (PK: userId, SK: createdAt)
 *     - domain-index            (PK: domain) — sparse, set only when domain is known
 *
 * Leads are linked cross-list by storing companyId on the Lead item. A
 * separate GSI on AW-Leads (companyId-index) makes getLeadsByCompanyId
 * a single cheap query.
 *
 * Auth invariant: only the company's ownerUserId may write.
 */

import { dynamodb } from '../config/aws';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-CRMCompanies`;
const LEADS_TABLE = `${TABLE_PREFIX}AW-Leads`;

export const COMPANY_DEAL_STAGES = [
  'Prospect',
  'Qualified',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
] as const;
export type CompanyDealStage = (typeof COMPANY_DEAL_STAGES)[number];

export interface Company {
  companyId: string;
  userId: string;
  name: string;
  domain?: string;
  industry?: string;
  dealStage?: CompanyDealStage;
  dealValue?: number;
  notes?: string;
  website?: string;
  linkedinUrl?: string;
  employeeCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCompanyInput {
  userId: string;
  name: string;
  domain?: string;
  industry?: string;
  dealStage?: CompanyDealStage;
  dealValue?: number;
  notes?: string;
  website?: string;
  linkedinUrl?: string;
  employeeCount?: number;
}

export interface UpdateCompanyInput {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  dealStage?: CompanyDealStage | null;
  dealValue?: number | null;
  notes?: string | null;
  website?: string | null;
  linkedinUrl?: string | null;
  employeeCount?: number | null;
}

export class CompanyNotFoundError extends Error {
  constructor(companyId: string) {
    super(`Company ${companyId} not found`);
    this.name = 'CompanyNotFoundError';
  }
}

export class CompanyAuthError extends Error {
  constructor(message = 'Not authorized to modify this company') {
    super(message);
    this.name = 'CompanyAuthError';
  }
}

export function generateCompanyId(): string {
  return `company_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function assertCanWrite(company: Company, userId: string): void {
  if (company.userId !== userId) throw new CompanyAuthError();
}

export const companyDb = {
  async createCompany(input: CreateCompanyInput): Promise<Company> {
    const now = new Date().toISOString();
    const company: Company = {
      companyId: generateCompanyId(),
      userId: input.userId,
      name: input.name.trim(),
      createdAt: now,
      updatedAt: now,
    };
    if (input.domain) company.domain = input.domain.trim().toLowerCase();
    if (input.industry) company.industry = input.industry;
    if (input.dealStage) company.dealStage = input.dealStage;
    if (input.dealValue != null) company.dealValue = input.dealValue;
    if (input.notes) company.notes = input.notes;
    if (input.website) company.website = input.website;
    if (input.linkedinUrl) company.linkedinUrl = input.linkedinUrl;
    if (input.employeeCount != null) company.employeeCount = input.employeeCount;

    await dynamodb.put({
      TableName: TABLE_NAME,
      Item: company,
      ConditionExpression: 'attribute_not_exists(companyId)',
    }).promise();

    return company;
  },

  async getCompany(companyId: string): Promise<Company | null> {
    const result = await dynamodb.get({
      TableName: TABLE_NAME,
      Key: { companyId },
    }).promise();
    return (result.Item as Company) ?? null;
  },

  async listCompaniesByUser(userId: string): Promise<Company[]> {
    const result = await dynamodb.query({
      TableName: TABLE_NAME,
      IndexName: 'userId-createdAt-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
    }).promise();
    return (result.Items as Company[]) ?? [];
  },

  async updateCompany(companyId: string, userId: string, input: UpdateCompanyInput): Promise<Company> {
    const existing = await this.getCompany(companyId);
    if (!existing) throw new CompanyNotFoundError(companyId);
    assertCanWrite(existing, userId);

    const now = new Date().toISOString();
    const setFragments: string[] = ['#updatedAt = :updatedAt'];
    const removeFragments: string[] = [];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': now };

    // Always use ExpressionAttributeNames (#) to avoid DynamoDB reserved-word conflicts.
    const setOrRemove = (key: keyof UpdateCompanyInput, attr: string) => {
      const val = input[key];
      const nameAlias = `#${attr}`;
      const valAlias = `:${attr}`;
      if (val === null) {
        names[nameAlias] = attr;
        removeFragments.push(nameAlias);
      } else if (val !== undefined) {
        names[nameAlias] = attr;
        setFragments.push(`${nameAlias} = ${valAlias}`);
        values[valAlias] = val;
      }
    };

    if (input.name !== undefined) {
      names['#name'] = 'name';
      setFragments.push('#name = :name');
      values[':name'] = input.name.trim();
    }
    setOrRemove('domain', 'domain');
    setOrRemove('industry', 'industry');
    setOrRemove('dealStage', 'dealStage');
    setOrRemove('dealValue', 'dealValue');
    setOrRemove('notes', 'notes');
    setOrRemove('website', 'website');
    setOrRemove('linkedinUrl', 'linkedinUrl');
    setOrRemove('employeeCount', 'employeeCount');

    let updateExpr = `SET ${setFragments.join(', ')}`;
    if (removeFragments.length > 0) updateExpr += ` REMOVE ${removeFragments.join(', ')}`;

    const result = await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { companyId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }).promise();
    return result.Attributes as Company;
  },

  async deleteCompany(companyId: string, userId: string): Promise<void> {
    const existing = await this.getCompany(companyId);
    if (!existing) throw new CompanyNotFoundError(companyId);
    assertCanWrite(existing, userId);

    await dynamodb.delete({
      TableName: TABLE_NAME,
      Key: { companyId },
    }).promise();
  },

  /**
   * Assign a lead (by listId+leadId) to a company. Sets companyId on the lead
   * so the companyId-index GSI can return all company members in one query.
   */
  async assignLeadToCompany(listId: string, leadId: string, companyId: string): Promise<void> {
    await dynamodb.update({
      TableName: LEADS_TABLE,
      Key: { listId, leadId },
      UpdateExpression: 'SET companyId = :cid, updatedAt = :now',
      ExpressionAttributeValues: {
        ':cid': companyId,
        ':now': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(leadId)',
    }).promise();
  },

  /**
   * Remove a lead's company membership.
   */
  async unassignLeadFromCompany(listId: string, leadId: string): Promise<void> {
    await dynamodb.update({
      TableName: LEADS_TABLE,
      Key: { listId, leadId },
      UpdateExpression: 'REMOVE companyId SET updatedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(leadId)',
    }).promise();
  },

  /**
   * Fetch all leads assigned to this company via the companyId-index GSI.
   */
  async getLeadsByCompanyId(companyId: string): Promise<any[]> {
    const result = await dynamodb.query({
      TableName: LEADS_TABLE,
      IndexName: 'companyId-index',
      KeyConditionExpression: 'companyId = :cid',
      ExpressionAttributeValues: { ':cid': companyId },
    }).promise();
    return result.Items ?? [];
  },
};
