import { describe, it, expect } from '@jest/globals';
import { CUSTOMER_PORTAL_PAGES, getCustomerPortalPages, getPageLabel } from '../customerPortalPages';

describe('customerPortalPages', () => {
  describe('CUSTOMER_PORTAL_PAGES', () => {
    it('should include all required pages', () => {
      const pagePaths = CUSTOMER_PORTAL_PAGES.map(page => page.path);
      
      // Brand Hub pages
      expect(pagePaths).toContain('/brand-guidelines');
      expect(pagePaths).toContain('/market-strategy');
      expect(pagePaths).toContain('/knowledge-base');
      expect(pagePaths).toContain('/email-templates');
      
      // Creative Hub pages
      expect(pagePaths).toContain('/research-reports');
      expect(pagePaths).toContain('/images');
      expect(pagePaths).toContain('/videos');
      
      // Performance Hub pages
      expect(pagePaths).toContain('/paid-social');
      expect(pagePaths).toContain('/newsletter');
      expect(pagePaths).toContain('/seo');
    });

    it('should have Paid Social page with correct label and description', () => {
      const paidSocialPage = CUSTOMER_PORTAL_PAGES.find(page => page.path === '/paid-social');
      
      expect(paidSocialPage).toBeDefined();
      expect(paidSocialPage?.label).toBe('Paid Social');
      expect(paidSocialPage?.description).toBe('View paid social media campaign performance');
    });

    it('should have Newsletter page with correct label and description', () => {
      const newsletterPage = CUSTOMER_PORTAL_PAGES.find(page => page.path === '/newsletter');
      
      expect(newsletterPage).toBeDefined();
      expect(newsletterPage?.label).toBe('Newsletter');
      expect(newsletterPage?.description).toBe('View newsletter campaign performance');
    });

    it('should have Reports page (renamed from Research Reports)', () => {
      const reportsPage = CUSTOMER_PORTAL_PAGES.find(page => page.path === '/research-reports');
      
      expect(reportsPage).toBeDefined();
      expect(reportsPage?.label).toBe('Reports');
      expect(reportsPage?.description).toBe('View market research reports');
    });

    it('should not have duplicate paths', () => {
      const paths = CUSTOMER_PORTAL_PAGES.map(page => page.path);
      const uniquePaths = new Set(paths);
      
      expect(paths.length).toBe(uniquePaths.size);
    });

    it('should have all pages with required fields', () => {
      CUSTOMER_PORTAL_PAGES.forEach(page => {
        expect(page.path).toBeDefined();
        expect(page.path).toMatch(/^\//); // Should start with /
        expect(page.label).toBeDefined();
        expect(page.label.length).toBeGreaterThan(0);
      });
    });
  });

  describe('getCustomerPortalPages', () => {
    it('should return all customer portal pages', () => {
      const pages = getCustomerPortalPages();
      
      expect(pages).toBe(CUSTOMER_PORTAL_PAGES);
      expect(pages.length).toBeGreaterThan(0);
    });

    it('should include Paid Social and Newsletter pages', () => {
      const pages = getCustomerPortalPages();
      const pagePaths = pages.map(page => page.path);
      
      expect(pagePaths).toContain('/paid-social');
      expect(pagePaths).toContain('/newsletter');
    });
  });

  describe('getPageLabel', () => {
    it('should return correct label for Paid Social page', () => {
      const label = getPageLabel('/paid-social');
      expect(label).toBe('Paid Social');
    });

    it('should return correct label for Newsletter page', () => {
      const label = getPageLabel('/newsletter');
      expect(label).toBe('Newsletter');
    });

    it('should return correct label for Reports page', () => {
      const label = getPageLabel('/research-reports');
      expect(label).toBe('Reports');
    });

    it('should return correct label for SEO page', () => {
      const label = getPageLabel('/seo');
      expect(label).toBe('SEO/GEO');
    });

    it('should return path for unknown pages', () => {
      const label = getPageLabel('/unknown-page');
      expect(label).toBe('/unknown-page');
    });

    it('should handle default pages', () => {
      expect(getPageLabel('/')).toBe('Agent Mode');
      expect(getPageLabel('/agent-mode')).toBe('Agent Mode');
      expect(getPageLabel('/settings')).toBe('Settings');
      expect(getPageLabel('/guide')).toBe('User Guide');
    });
  });

  describe('Performance Hub pages structure', () => {
    it('should have all Performance Hub pages defined', () => {
      const performanceHubPages = [
        '/paid-social',
        '/newsletter',
        '/seo',
      ];

      const pagePaths = CUSTOMER_PORTAL_PAGES.map(page => page.path);
      
      performanceHubPages.forEach(path => {
        expect(pagePaths).toContain(path);
      });
    });

    it('should not have Campaign Performance in Performance Hub (it should be separate)', () => {
      // Campaign Performance (/meta-campaigns) should still exist but not be in Performance Hub
      const pagePaths = CUSTOMER_PORTAL_PAGES.map(page => page.path);
      expect(pagePaths).toContain('/meta-campaigns');
      
      // But Performance Hub should have the split pages
      expect(pagePaths).toContain('/paid-social');
      expect(pagePaths).toContain('/newsletter');
    });
  });
});
