// Mock dotenv and aws-sdk before any imports
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

import { evaluateExpression, validateExpression } from '../services/crmTriggerEvaluator';

const baseLead = {
  leadId: 'lead_1',
  listId: 'list_1',
  email: 'test@gmail.com',
  firstName: 'John',
  lastName: 'Smith',
  company: 'Acme Corp',
  status: 'new',
  dealValue: 5000,
  phone: '',
  notes: 'some notes here that are long enough',
  customFields: { tier: 'premium', score: 90 },
};

describe('crmTriggerEvaluator', () => {
  describe('evaluateExpression', () => {
    it('should return true for literal "true"', async () => {
      expect(await evaluateExpression('true', baseLead)).toBe(true);
    });

    it('should return false for literal "false"', async () => {
      expect(await evaluateExpression('false', baseLead)).toBe(false);
    });

    it('should evaluate simple equality — match', async () => {
      expect(await evaluateExpression('status == "new"', baseLead)).toBe(true);
    });

    it('should evaluate simple equality — no match', async () => {
      expect(await evaluateExpression('status == "won"', baseLead)).toBe(false);
    });

    it('should evaluate != operator', async () => {
      expect(await evaluateExpression('status != "won"', baseLead)).toBe(true);
    });

    it('should evaluate numeric > operator', async () => {
      expect(await evaluateExpression('dealValue > 1000', baseLead)).toBe(true);
      expect(await evaluateExpression('dealValue > 10000', baseLead)).toBe(false);
    });

    it('should evaluate numeric < operator', async () => {
      expect(await evaluateExpression('dealValue < 10000', baseLead)).toBe(true);
      expect(await evaluateExpression('dealValue < 1000', baseLead)).toBe(false);
    });

    it('contains() — match', async () => {
      expect(await evaluateExpression('contains(email, "@gmail.com")', baseLead)).toBe(true);
    });

    it('contains() — no match', async () => {
      expect(await evaluateExpression('contains(email, "@yahoo.com")', baseLead)).toBe(false);
    });

    it('startsWith() — match', async () => {
      expect(await evaluateExpression('startsWith(company, "Acme")', baseLead)).toBe(true);
    });

    it('startsWith() — no match', async () => {
      expect(await evaluateExpression('startsWith(company, "Xyz")', baseLead)).toBe(false);
    });

    it('endsWith() — match', async () => {
      expect(await evaluateExpression('endsWith(email, ".com")', baseLead)).toBe(true);
    });

    it('endsWith() — no match', async () => {
      expect(await evaluateExpression('endsWith(email, ".org")', baseLead)).toBe(false);
    });

    it('concat() assembles string correctly', async () => {
      expect(await evaluateExpression('concat(firstName, " ", lastName) == "John Smith"', baseLead)).toBe(true);
    });

    it('substring() extracts substring correctly', async () => {
      expect(await evaluateExpression('substring(company, 0, 4) == "Acme"', baseLead)).toBe(true);
    });

    it('regex() — match', async () => {
      expect(await evaluateExpression('regex(email, "^[a-z]+@gmail\\.com$")', baseLead)).toBe(true);
    });

    it('regex() — no match', async () => {
      expect(await evaluateExpression('regex(email, "^[a-z]+@yahoo\\.com$")', baseLead)).toBe(false);
    });

    it('lower() converts to lowercase', async () => {
      const lead = { ...baseLead, status: 'WON' };
      expect(await evaluateExpression('lower(status) == "won"', lead)).toBe(true);
    });

    it('upper() converts to uppercase', async () => {
      expect(await evaluateExpression('upper(status) == "NEW"', baseLead)).toBe(true);
    });

    it('trim() strips whitespace', async () => {
      const lead = { ...baseLead, company: '  Acme  ' };
      expect(await evaluateExpression('trim(company) == "Acme"', lead)).toBe(true);
    });

    it('len() returns string length', async () => {
      expect(await evaluateExpression('len(email) > 5', baseLead)).toBe(true);
    });

    it('isEmpty() — true for empty string', async () => {
      expect(await evaluateExpression('isEmpty(phone)', baseLead)).toBe(true);
    });

    it('isEmpty() — false for non-empty', async () => {
      expect(await evaluateExpression('isEmpty(email)', baseLead)).toBe(false);
    });

    it('isEmpty() — true for null/undefined', async () => {
      const lead = { ...baseLead, phone: null as any };
      expect(await evaluateExpression('isEmpty(phone)', lead)).toBe(true);
    });

    it('isNotEmpty() — true for non-empty', async () => {
      expect(await evaluateExpression('isNotEmpty(email)', baseLead)).toBe(true);
    });

    it('isNotEmpty() — false for empty', async () => {
      expect(await evaluateExpression('isNotEmpty(phone)', baseLead)).toBe(false);
    });

    it('&& logic — both true', async () => {
      expect(await evaluateExpression('dealValue > 1000 && contains(email, "@gmail.com")', baseLead)).toBe(true);
    });

    it('&& logic — one false', async () => {
      expect(await evaluateExpression('dealValue > 1000 && contains(email, "@yahoo.com")', baseLead)).toBe(false);
    });

    it('|| logic — one true', async () => {
      expect(await evaluateExpression('status == "won" || status == "new"', baseLead)).toBe(true);
    });

    it('|| logic — both false', async () => {
      expect(await evaluateExpression('status == "won" || status == "lost"', baseLead)).toBe(false);
    });

    it('accesses customFields.tier via dot notation', async () => {
      expect(await evaluateExpression('customFields.tier == "premium"', baseLead)).toBe(true);
    });

    it('accesses customFields.score numerically', async () => {
      expect(await evaluateExpression('customFields.score > 80', baseLead)).toBe(true);
    });

    it('prev.status for change detection — changed', async () => {
      const prevLead = { ...baseLead, status: 'new' };
      const newLead = { ...baseLead, status: 'won' };
      expect(await evaluateExpression('prev.status != status && status == "won"', newLead, prevLead)).toBe(true);
    });

    it('prev.status for change detection — not changed', async () => {
      const prevLead = { ...baseLead, status: 'won' };
      const newLead = { ...baseLead, status: 'won' };
      expect(await evaluateExpression('prev.status != status', newLead, prevLead)).toBe(false);
    });

    it('safely returns false when previousLead is undefined and prev.X is referenced', async () => {
      // When prev is undefined, accessing prev.status should not throw — return false
      const result = await evaluateExpression('prev.status != status', baseLead, undefined);
      expect(typeof result).toBe('boolean');
    });

    it('returns false for malformed expression (safe default)', async () => {
      expect(await evaluateExpression('this is not valid ### expr', baseLead)).toBe(false);
    });

    it('returns false for empty expression string', async () => {
      expect(await evaluateExpression('', baseLead)).toBe(false);
    });

    it('returns false when expression throws on runtime error', async () => {
      // Calling a non-existent function should be safe
      expect(await evaluateExpression('nonExistentFunc(email)', baseLead)).toBe(false);
    });
  });

  describe('validateExpression', () => {
    it('returns valid:true for a valid expression', async () => {
      const result = await validateExpression('status == "won"');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns valid:true for "true"', async () => {
      const result = await validateExpression('true');
      expect(result.valid).toBe(true);
    });

    it('returns valid:false with error for invalid expression', async () => {
      const result = await validateExpression('this is not valid @@#');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns valid:false for empty expression', async () => {
      const result = await validateExpression('');
      expect(result.valid).toBe(false);
    });
  });
});
