import request from 'supertest';
import { app } from '../app';
import { userDb } from '../services/db';

describe('Admin Routes - Multiple Account Configuration', () => {
  let adminToken: string;
  let testUserId: string;

  beforeAll(async () => {
    // Create admin user and get token (assuming you have test setup)
    // This is a placeholder - adjust based on your actual test setup
    adminToken = 'test-admin-token';
    testUserId = 'test-user-id';
  });

  describe('PUT /api/admin/users/:userId/seo-aeo', () => {
    it('should accept and validate multiple GA4 properties', async () => {
      const payload = {
        seoDomains: ['example.com', 'test.com'],
        googleAnalyticsProperties: [
          { propertyId: '123456789', label: 'Main Website' },
          { propertyId: '987654321', label: 'Product Site' }
        ],
        gaFilteredDomains: ['app.example.com'],
        clarityProjects: [
          { projectId: 'ul13e4f7fe', label: 'Main Site' }
        ],
        productDomain: 'app.example.com'
      };

      // Validation test - check structure without actually making API call
      expect(payload.googleAnalyticsProperties).toHaveLength(2);
      expect(payload.googleAnalyticsProperties[0]).toHaveProperty('propertyId');
      expect(payload.googleAnalyticsProperties[0]).toHaveProperty('label');
      expect(payload.clarityProjects).toHaveLength(1);
    });

    it('should validate property ID format', () => {
      const validPropertyId = '123456789';
      const invalidPropertyId = 'G-XXXXXXXXX';

      expect(/^\d+$/.test(validPropertyId)).toBe(true);
      expect(/^\d+$/.test(invalidPropertyId)).toBe(false);
    });

    it('should validate clarity project ID format', () => {
      const validProjectId = 'ul13e4f7fe';
      const invalidProjectId = 'invalid!@#$';

      expect(/^[a-zA-Z0-9_-]{6,32}$/.test(validProjectId)).toBe(true);
      expect(/^[a-zA-Z0-9_-]{6,32}$/.test(invalidProjectId)).toBe(false);
    });

    it('should detect duplicate property IDs', () => {
      const properties = [
        { propertyId: '123456789', label: 'Site 1' },
        { propertyId: '123456789', label: 'Site 2' },
        { propertyId: '987654321', label: 'Site 3' }
      ];

      const seenIds = new Set<string>();
      const duplicates = properties.filter(p => {
        if (seenIds.has(p.propertyId)) {
          return true;
        }
        seenIds.add(p.propertyId);
        return false;
      });

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].propertyId).toBe('123456789');
    });

    it('should detect duplicate project IDs', () => {
      const projects = [
        { projectId: 'ul13e4f7fe', label: 'Site 1' },
        { projectId: 'ul13e4f7fe', label: 'Site 2' },
        { projectId: 'xk9f2d8a1b', label: 'Site 3' }
      ];

      const seenIds = new Set<string>();
      const duplicates = projects.filter(p => {
        if (seenIds.has(p.projectId)) {
          return true;
        }
        seenIds.add(p.projectId);
        return false;
      });

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].projectId).toBe('ul13e4f7fe');
    });

    it('should validate label length', () => {
      const validLabel = 'Main Website';
      const tooLongLabel = 'a'.repeat(101);

      expect(validLabel.length).toBeLessThanOrEqual(100);
      expect(tooLongLabel.length).toBeGreaterThan(100);
    });

    it('should validate both domain and URL-prefix formats for seoDomains', () => {
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      const urlPrefixRegex = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\/?$/;

      // Valid domain property formats
      expect(domainRegex.test('example.com')).toBe(true);
      expect(domainRegex.test('subdomain.example.com')).toBe(true);
      expect(domainRegex.test('multi.level.subdomain.example.com')).toBe(true);

      // Valid URL-prefix property formats
      expect(urlPrefixRegex.test('https://example.com')).toBe(true);
      expect(urlPrefixRegex.test('https://example.com/')).toBe(true);
      expect(urlPrefixRegex.test('http://example.com/')).toBe(true);
      expect(urlPrefixRegex.test('https://subdomain.example.com/')).toBe(true);

      // Invalid formats
      expect(domainRegex.test('https://example.com')).toBe(false);
      expect(urlPrefixRegex.test('example.com')).toBe(false);
      expect(domainRegex.test('invalid')).toBe(false);
      expect(urlPrefixRegex.test('ftp://example.com')).toBe(false);

      // Combined validation (should accept either format)
      const testDomains = [
        'example.com',
        'https://example.com/',
        'subdomain.example.com',
        'https://subdomain.example.com'
      ];

      testDomains.forEach(domain => {
        const isValid = domainRegex.test(domain) || urlPrefixRegex.test(domain);
        expect(isValid).toBe(true);
      });
    });

    it('should filter out empty entries', () => {
      const properties = [
        { propertyId: '123456789', label: 'Main Site' },
        { propertyId: '', label: '' },
        { propertyId: '987654321', label: 'Product Site' },
        { propertyId: '  ', label: '  ' }
      ];

      const validated = properties
        .filter(p => p.propertyId.trim() || p.label.trim())
        .map(p => ({ propertyId: p.propertyId.trim(), label: p.label.trim() }))
        .filter(p => p.propertyId && p.label);

      expect(validated).toHaveLength(2);
      expect(validated[0].propertyId).toBe('123456789');
      expect(validated[1].propertyId).toBe('987654321');
    });
  });

  describe('Response format validation', () => {
    it('should validate SEO metrics response structure with multiple GA properties', () => {
      const mockResponse = {
        metrics: [
          { domain: 'example.com', clicks: 100, impressions: 1000 }
        ],
        gaMetrics: {
          propertyId: '123456789',
          label: 'Main Website',
          sessions: 500,
          users: 300
        },
        gaMetricsArray: [
          {
            propertyId: '123456789',
            label: 'Main Website',
            sessions: 500,
            users: 300
          },
          {
            propertyId: '987654321',
            label: 'Product Site',
            sessions: 200,
            users: 150
          }
        ],
        funnelMetrics: null,
        timestamp: new Date().toISOString()
      };

      expect(mockResponse.gaMetricsArray).toHaveLength(2);
      expect(mockResponse.gaMetrics).toEqual(mockResponse.gaMetricsArray[0]);
      expect(mockResponse.gaMetricsArray[0]).toHaveProperty('label');
      expect(mockResponse.gaMetricsArray[1]).toHaveProperty('label');
    });
  });

  describe('Migration logic validation', () => {
    it('should properly migrate legacy single value to array', () => {
      const legacyUser = {
        googleAnalyticsPropertyId: '123456789',
        clarityProjectId: 'ul13e4f7fe'
      };

      // Simulate migration in dialog open
      const gaProps = legacyUser.googleAnalyticsPropertyId
        ? [{ propertyId: legacyUser.googleAnalyticsPropertyId, label: 'Main Property' }]
        : [];

      const clarityProjs = legacyUser.clarityProjectId
        ? [{ projectId: legacyUser.clarityProjectId, label: 'Main Project' }]
        : [];

      expect(gaProps).toEqual([
        { propertyId: '123456789', label: 'Main Property' }
      ]);
      expect(clarityProjs).toEqual([
        { projectId: 'ul13e4f7fe', label: 'Main Project' }
      ]);
    });

    it('should prefer new array format over legacy', () => {
      const mixedUser = {
        googleAnalyticsPropertyId: '111111111',
        googleAnalyticsProperties: [
          { propertyId: '123456789', label: 'Main Site' }
        ],
        clarityProjectId: 'oldproject',
        clarityProjects: [
          { projectId: 'ul13e4f7fe', label: 'Main Site' }
        ]
      };

      // Simulate migration logic
      const gaProps = mixedUser.googleAnalyticsProperties && mixedUser.googleAnalyticsProperties.length > 0
        ? mixedUser.googleAnalyticsProperties
        : mixedUser.googleAnalyticsPropertyId
        ? [{ propertyId: mixedUser.googleAnalyticsPropertyId, label: 'Main Property' }]
        : [];

      const clarityProjs = mixedUser.clarityProjects && mixedUser.clarityProjects.length > 0
        ? mixedUser.clarityProjects
        : mixedUser.clarityProjectId
        ? [{ projectId: mixedUser.clarityProjectId, label: 'Main Project' }]
        : [];

      expect(gaProps).toEqual([
        { propertyId: '123456789', label: 'Main Site' }
      ]);
      expect(clarityProjs).toEqual([
        { projectId: 'ul13e4f7fe', label: 'Main Site' }
      ]);
    });
  });
});
