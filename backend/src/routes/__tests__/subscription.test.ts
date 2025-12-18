import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import subscriptionRoutes from '../subscription';
import { authenticateToken } from '../../middleware/auth';

// Mock the middleware
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    next();
    return undefined;
  }),
}));

// Mock customerPortalPages service
jest.mock('../../services/customerPortalPages', () => ({
  getCustomerPortalPages: jest.fn(() => [
    { path: '/brand-guidelines', label: 'Brand Guidelines', description: 'Manage brand data and assets' },
    { path: '/market-strategy', label: 'Market Strategy', description: 'Manage business overview, competitors, and ICPs' },
    { path: '/paid-social', label: 'Paid Social', description: 'View paid social media campaign performance' },
    { path: '/newsletter', label: 'Newsletter', description: 'View newsletter campaign performance' },
    { path: '/seo', label: 'SEO/GEO', description: 'SEO and analytics management' },
    { path: '/research-reports', label: 'Reports', description: 'View market research reports' },
    { path: '/images', label: 'Ad Images', description: 'Image generation and management' },
    { path: '/videos', label: 'Ad Videos', description: 'Video generation and management' },
  ]),
}));

let app: express.Application;

describe('GET /api/subscription/customer-portal-pages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/subscription', subscriptionRoutes);
  });

  it('should return all customer portal pages including Paid Social and Newsletter', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    expect(res.body).toHaveProperty('pages');
    expect(Array.isArray(res.body.pages)).toBe(true);
    
    const pagePaths = res.body.pages.map((page: any) => page.path);
    
    // Verify new Performance Hub pages are included
    expect(pagePaths).toContain('/paid-social');
    expect(pagePaths).toContain('/newsletter');
    expect(pagePaths).toContain('/seo');
    
    // Verify other pages are included
    expect(pagePaths).toContain('/brand-guidelines');
    expect(pagePaths).toContain('/market-strategy');
    expect(pagePaths).toContain('/research-reports');
    expect(pagePaths).toContain('/images');
    expect(pagePaths).toContain('/videos');
  });

  it('should return Paid Social page with correct structure', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    const paidSocialPage = res.body.pages.find((page: any) => page.path === '/paid-social');
    
    expect(paidSocialPage).toBeDefined();
    expect(paidSocialPage.path).toBe('/paid-social');
    expect(paidSocialPage.label).toBe('Paid Social');
    expect(paidSocialPage.description).toBe('View paid social media campaign performance');
  });

  it('should return Newsletter page with correct structure', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    const newsletterPage = res.body.pages.find((page: any) => page.path === '/newsletter');
    
    expect(newsletterPage).toBeDefined();
    expect(newsletterPage.path).toBe('/newsletter');
    expect(newsletterPage.label).toBe('Newsletter');
    expect(newsletterPage.description).toBe('View newsletter campaign performance');
  });

  it('should return Reports page (renamed from Research Reports)', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    const reportsPage = res.body.pages.find((page: any) => page.path === '/research-reports');
    
    expect(reportsPage).toBeDefined();
    expect(reportsPage.path).toBe('/research-reports');
    expect(reportsPage.label).toBe('Reports');
    expect(reportsPage.description).toBe('View market research reports');
  });
});
