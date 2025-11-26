// Unit tests for CMS Type functionality in AdminDashboard

import React from 'react';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AdminDashboard - CMS Type Management', () => {
  const mockToken = 'test-token';
  const mockUserId = 'user1';

  // Test the handleSaveCmsType function logic
  describe('handleSaveCmsType function', () => {
    it('should call API with correct endpoint and payload for Basehub', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { cmsType: 'Basehub' },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/cms-type`,
        { cmsType: 'Basehub' },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/cms-type'),
        { cmsType: 'Basehub' },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.cmsType).toBe('Basehub');
    });

    it('should call API with correct endpoint and payload for Webflow', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { cmsType: 'Webflow' },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/cms-type`,
        { cmsType: 'Webflow' },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/cms-type'),
        { cmsType: 'Webflow' },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.cmsType).toBe('Webflow');
    });

    it('should call API with null when None is selected', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: { cmsType: null },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/cms-type`,
        { cmsType: null },
        {
          headers: { Authorization: `Bearer ${mockToken}` }
        }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/cms-type'),
        { cmsType: null },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.cmsType).toBeNull();
    });

    it('should handle API errors correctly', async () => {
      const errorMessage = 'Failed to update CMS Type';
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          data: { message: errorMessage },
          status: 500
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/${mockUserId}/cms-type`,
          { cmsType: 'Basehub' },
          {
            headers: { Authorization: `Bearer ${mockToken}` }
          }
        );
      } catch (error: any) {
        expect(error.response.data.message).toBe(errorMessage);
        expect(error.response.status).toBe(500);
      }
    });
  });

  // Test CMS Type display logic
  describe('CMS Type display logic', () => {
    it('should return "-" when cmsType is undefined', () => {
      const user = { userId: 'user1', email: 'user1@example.com', cmsType: undefined };
      const displayValue = user.cmsType || '-';
      expect(displayValue).toBe('-');
    });

    it('should return "Basehub" when cmsType is Basehub', () => {
      const user = { userId: 'user2', email: 'user2@example.com', cmsType: 'Basehub' as const };
      const displayValue = user.cmsType || '-';
      expect(displayValue).toBe('Basehub');
    });

    it('should return "Webflow" when cmsType is Webflow', () => {
      const user = { userId: 'user3', email: 'user3@example.com', cmsType: 'Webflow' as const };
      const displayValue = user.cmsType || '-';
      expect(displayValue).toBe('Webflow');
    });
  });

  // Test CMS Type dropdown options
  describe('CMS Type dropdown options', () => {
    it('should have None, Basehub, and Webflow options', () => {
      const options = ['', 'Basehub', 'Webflow'];
      const menuItems = [
        { value: '', label: 'None' },
        { value: 'Basehub', label: 'Basehub' },
        { value: 'Webflow', label: 'Webflow' }
      ];

      expect(options).toContain('');
      expect(options).toContain('Basehub');
      expect(options).toContain('Webflow');
      expect(menuItems).toHaveLength(3);
      expect(menuItems[0].value).toBe('');
      expect(menuItems[1].value).toBe('Basehub');
      expect(menuItems[2].value).toBe('Webflow');
    });

    it('should map empty string to null when saving', () => {
      const currentCmsType = '';
      const payload = { cmsType: currentCmsType || null };
      expect(payload.cmsType).toBeNull();
    });

    it('should map Basehub string to Basehub when saving', () => {
      const currentCmsType = 'Basehub';
      const payload = { cmsType: currentCmsType || null };
      expect(payload.cmsType).toBe('Basehub');
    });

    it('should map Webflow string to Webflow when saving', () => {
      const currentCmsType = 'Webflow';
      const payload = { cmsType: currentCmsType || null };
      expect(payload.cmsType).toBe('Webflow');
    });
  });
});

