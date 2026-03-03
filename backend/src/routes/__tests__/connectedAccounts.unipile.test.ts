import express from 'express';
import request from 'supertest';
import { authenticateToken } from '../../middleware/auth';
import { deleteAccountById, deleteAccount, getAccountsByUserId } from '../../services/connectedAccountsDb';
import { linkedInOutreachService } from '../../services/linkedInOutreachService';
import connectedAccountsRouter from '../connectedAccounts';

// Mock dependencies
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, res, next) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

jest.mock('../../services/connectedAccountsDb', () => ({
  deleteAccountById: jest.fn(),
  deleteAccount: jest.fn(),
  getAccountsByUserId: jest.fn(),
}));

jest.mock('../../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    deleteAccount: jest.fn(),
  },
}));

// Provide minimal implementations for utils if needed
jest.mock('../../utils/tokenUtils', () => ({
  getTokenStatus: jest.fn().mockReturnValue('valid'),
  formatExpiryMessage: jest.fn().mockReturnValue('Never expires'),
}));

describe('Connected Accounts Router - Unipile Deletion', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/', connectedAccountsRouter);
  });

  describe('DELETE /connected-accounts/:platform/:accountId', () => {
    it('should successfully delete a Unipile account from both Unipile API and our DB', async () => {
      (linkedInOutreachService.deleteAccount as jest.Mock).mockResolvedValue(true);
      (deleteAccountById as jest.Mock).mockResolvedValue(true);

      const response = await request(app).delete('/connected-accounts/unipile/123-abc');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, message: 'unipile account 123-abc disconnected' });
      
      // Should attempt to delete from Unipile first
      expect(linkedInOutreachService.deleteAccount).toHaveBeenCalledWith('123-abc');
      
      // Should delete from DB
      expect(deleteAccountById).toHaveBeenCalledWith('user-123', 'unipile', '123-abc');
    });

    it('should delete from our DB even if Unipile API deletion fails', async () => {
      // Simulate Unipile API throwing an error (e.g. account already deleted there)
      (linkedInOutreachService.deleteAccount as jest.Mock).mockRejectedValue(new Error('Unipile account not found'));
      (deleteAccountById as jest.Mock).mockResolvedValue(true);

      const response = await request(app).delete('/connected-accounts/unipile/123-abc');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, message: 'unipile account 123-abc disconnected' });
      
      // Should have attempted to delete from Unipile
      expect(linkedInOutreachService.deleteAccount).toHaveBeenCalledWith('123-abc');
      
      // Should STILL delete from our DB so user is not stuck
      expect(deleteAccountById).toHaveBeenCalledWith('user-123', 'unipile', '123-abc');
    });

    it('should not call Unipile API delete for other platforms (e.g., meta)', async () => {
      (deleteAccountById as jest.Mock).mockResolvedValue(true);

      const response = await request(app).delete('/connected-accounts/meta/123-abc');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, message: 'meta account 123-abc disconnected' });
      
      // Should NOT attempt to delete from Unipile
      expect(linkedInOutreachService.deleteAccount).not.toHaveBeenCalled();
      
      // Should delete from DB
      expect(deleteAccountById).toHaveBeenCalledWith('user-123', 'meta', '123-abc');
    });
    
    it('should handle database errors when deleting', async () => {
      const errorMessage = 'Database deletion failed';
      (linkedInOutreachService.deleteAccount as jest.Mock).mockResolvedValue(true);
      (deleteAccountById as jest.Mock).mockRejectedValue(new Error(errorMessage));

      const response = await request(app).delete('/connected-accounts/unipile/123-abc');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to delete connected account' });
    });
  });
});
