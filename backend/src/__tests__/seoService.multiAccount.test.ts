import { getGoogleAnalyticsProperties, getClarityProjects } from '../services/seoService';

describe('SEO Service - Multiple Account Support', () => {
  describe('getGoogleAnalyticsProperties', () => {
    it('should return new array format when googleAnalyticsProperties exists', () => {
      const user = {
        googleAnalyticsProperties: [
          { propertyId: '123456789', label: 'Main Site' },
          { propertyId: '987654321', label: 'Product Site' }
        ]
      };

      const result = getGoogleAnalyticsProperties(user);

      expect(result).toEqual([
        { propertyId: '123456789', label: 'Main Site' },
        { propertyId: '987654321', label: 'Product Site' }
      ]);
    });

    it('should migrate from legacy single googleAnalyticsPropertyId', () => {
      const user = {
        googleAnalyticsPropertyId: '123456789'
      };

      const result = getGoogleAnalyticsProperties(user);

      expect(result).toEqual([
        { propertyId: '123456789', label: 'Main Property' }
      ]);
    });

    it('should return empty array when no properties configured', () => {
      const user = {};

      const result = getGoogleAnalyticsProperties(user);

      expect(result).toEqual([]);
    });

    it('should prefer new format over legacy when both exist', () => {
      const user = {
        googleAnalyticsPropertyId: '111111111',
        googleAnalyticsProperties: [
          { propertyId: '123456789', label: 'Main Site' }
        ]
      };

      const result = getGoogleAnalyticsProperties(user);

      expect(result).toEqual([
        { propertyId: '123456789', label: 'Main Site' }
      ]);
    });

    it('should return empty array when googleAnalyticsProperties is empty', () => {
      const user = {
        googleAnalyticsPropertyId: '123456789',
        googleAnalyticsProperties: []
      };

      const result = getGoogleAnalyticsProperties(user);

      // Should fallback to legacy
      expect(result).toEqual([
        { propertyId: '123456789', label: 'Main Property' }
      ]);
    });
  });

  describe('getClarityProjects', () => {
    it('should return new array format when clarityProjects exists', () => {
      const user = {
        clarityProjects: [
          { projectId: 'ul13e4f7fe', label: 'Main Site' },
          { projectId: 'xk9f2d8a1b', label: 'Product Site' }
        ]
      };

      const result = getClarityProjects(user);

      expect(result).toEqual([
        { projectId: 'ul13e4f7fe', label: 'Main Site' },
        { projectId: 'xk9f2d8a1b', label: 'Product Site' }
      ]);
    });

    it('should migrate from legacy single clarityProjectId', () => {
      const user = {
        clarityProjectId: 'ul13e4f7fe'
      };

      const result = getClarityProjects(user);

      expect(result).toEqual([
        { projectId: 'ul13e4f7fe', label: 'Main Project' }
      ]);
    });

    it('should return empty array when no projects configured', () => {
      const user = {};

      const result = getClarityProjects(user);

      expect(result).toEqual([]);
    });

    it('should prefer new format over legacy when both exist', () => {
      const user = {
        clarityProjectId: 'oldproject',
        clarityProjects: [
          { projectId: 'ul13e4f7fe', label: 'Main Site' }
        ]
      };

      const result = getClarityProjects(user);

      expect(result).toEqual([
        { projectId: 'ul13e4f7fe', label: 'Main Site' }
      ]);
    });

    it('should return empty array when clarityProjects is empty', () => {
      const user = {
        clarityProjectId: 'ul13e4f7fe',
        clarityProjects: []
      };

      const result = getClarityProjects(user);

      // Should fallback to legacy
      expect(result).toEqual([
        { projectId: 'ul13e4f7fe', label: 'Main Project' }
      ]);
    });
  });

  describe('Migration scenarios', () => {
    it('should handle user with both old and new formats correctly', () => {
      const user = {
        // Legacy single values
        googleAnalyticsPropertyId: '111111111',
        clarityProjectId: 'oldproject',
        // New array formats
        googleAnalyticsProperties: [
          { propertyId: '123456789', label: 'Main Site' },
          { propertyId: '987654321', label: 'Product Site' }
        ],
        clarityProjects: [
          { projectId: 'ul13e4f7fe', label: 'Main Site' }
        ]
      };

      const gaResult = getGoogleAnalyticsProperties(user);
      const clarityResult = getClarityProjects(user);

      // Should use new format
      expect(gaResult).toHaveLength(2);
      expect(gaResult[0].propertyId).toBe('123456789');
      expect(clarityResult).toHaveLength(1);
      expect(clarityResult[0].projectId).toBe('ul13e4f7fe');
    });

    it('should handle user with only legacy formats', () => {
      const user = {
        googleAnalyticsPropertyId: '111111111',
        clarityProjectId: 'oldproject'
      };

      const gaResult = getGoogleAnalyticsProperties(user);
      const clarityResult = getClarityProjects(user);

      // Should migrate from legacy
      expect(gaResult).toEqual([
        { propertyId: '111111111', label: 'Main Property' }
      ]);
      expect(clarityResult).toEqual([
        { projectId: 'oldproject', label: 'Main Project' }
      ]);
    });
  });
});
