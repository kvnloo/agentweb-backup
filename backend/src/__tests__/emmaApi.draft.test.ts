import express from 'express';
import request from 'supertest';
const postOnConnectedAccount = jest.fn();
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'yugo-verify-user' }; next(); } }));
jest.mock('../middleware/emmaTokenBudget', () => ({ requireEmmaTokenBudget: (_req: any, _res: any, next: any) => next() }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({ publishRevalidationForForwardedRun: () => undefined }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { postOnConnectedAccount: (...args: any[]) => postOnConnectedAccount(...args) } }));
import router from '../routes/emmaApi';
const app = express(); app.use(express.json()); app.use('/api/emma', router);
beforeEach(() => { postOnConnectedAccount.mockReset().mockResolvedValue({ success: true }); });
test('REST draft intent reaches the service instead of becoming a publish', async () => {
 await request(app).post('/api/emma/post-on-account').send({ account_id: 'fixture', content: 'review', save_as_draft: true }).expect(200);
 expect(postOnConnectedAccount).toHaveBeenCalledWith('yugo-verify-user', 'fixture', 'review', [], undefined, undefined, { saveAsDraft: true });
});
test('ordinary posting preserves the existing default call shape', async () => {
 await request(app).post('/api/emma/post-on-account').send({ account_id: 'fixture', content: 'review' }).expect(200);
 expect(postOnConnectedAccount).toHaveBeenCalledWith('yugo-verify-user', 'fixture', 'review', [], undefined, undefined, undefined);
});
