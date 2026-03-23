import request from 'supertest';
import express from 'express';
import socialPostsRouter from '../routes/socialPosts';
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';
// Mock dependencies
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/socialPlatformService');
jest.mock('../middleware/auth', () => ({
    authenticateToken: (req: any, res: any, next: any) => {
        // Simulate no auth if header missing
        if (!req.headers.authorization) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = { userId: 'test_user_id' };
        next();
    }
}));

const app = express();
app.use(express.json());
app.use('/api', socialPostsRouter);

const mockGetAccountsByUserId = connectedAccountsDb.getAccountsByUserId as jest.Mock;

const createMockAccount = (overrides: Partial<connectedAccountsDb.ConnectedAccount> = {}): connectedAccountsDb.ConnectedAccount => ({
    platform: 'linkedin' as connectedAccountsDb.PlatformType,
    account_id: 'urn:li:person:abc',
    account_name: 'John Doe',
    config: {
        account_type: 'personal',
        access_token: 'token123',
        token_expires_at: Date.now() + 100000,
    } as any,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
});

const createMockAdapter = (posts: any[] = [], metrics: any[] = []) => ({
    listPosts: jest.fn().mockResolvedValue(posts),
    getPostMetrics: jest.fn().mockResolvedValue(metrics),
    createPost: jest.fn(),
    getAccountMetrics: jest.fn(),
    verifyToken: jest.fn(),
    getPostAnalytics: jest.fn(),
});

describe('Social Posts API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // FAIL tests
    describe('FAIL cases', () => {
        it('returns 401 when no auth token provided', async () => {
            const response = await request(app).get('/api/social-posts');
            expect(response.status).toBe(401);
        });

        it('returns empty posts array when user has no connected accounts', async () => {
            mockGetAccountsByUserId.mockResolvedValue([]);

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.posts).toEqual([]);
            expect(response.body.accounts).toEqual([]);
        });

        it('handles adapter errors gracefully (one account fails, others succeed)', async () => {
            const goodAccount = createMockAccount({
                account_id: 'urn:li:person:good',
                account_name: 'Good Account',
            });
            const badAccount = createMockAccount({
                account_id: 'urn:li:person:bad',
                account_name: 'Bad Account',
            });

            mockGetAccountsByUserId.mockResolvedValue([goodAccount, badAccount]);

            const goodPosts = [{ id: 'post1', content: 'Hello world', createdAt: '2026-03-10T12:00:00Z' }];
            const goodMetrics = [{ share: 'post1', likes: 10, comments: 2, shares: 1, impressions: 100, clicks: 5, engagement: 13 }];
            const goodAdapter = createMockAdapter(goodPosts, goodMetrics);
            const badAdapter = createMockAdapter();
            badAdapter.listPosts.mockRejectedValue(new Error('API rate limit'));

            (socialPlatformService.getAdapter as jest.Mock)
                .mockImplementation((platform: string) => {
                    // Both accounts are linkedin, so we need to track call order
                    return goodAdapter;
                });

            // Override to return different adapters per call
            let callCount = 0;
            (socialPlatformService.getAdapter as jest.Mock).mockImplementation(() => {
                callCount++;
                return callCount === 1 ? goodAdapter : badAdapter;
            });

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            // Should still have posts from the good account
            expect(response.body.posts.length).toBe(1);
            // Both accounts should appear in summaries (bad account with 0 posts)
            expect(response.body.accounts).toHaveLength(2);
            const badSummary = response.body.accounts.find((a: any) => a.accountId === 'urn:li:person:bad');
            expect(badSummary).toBeDefined();
            expect(badSummary.postCount).toBe(0);
        });

        it('includes account in summaries even when listPosts throws (account stays visible)', async () => {
            const companyAccount = createMockAccount({
                account_id: 'urn:li:organization:999',
                account_name: 'My Company',
                config: {
                    account_type: 'company_page',
                    access_token: 'expired-token',
                    token_expires_at: Date.now() - 86400000,
                } as any,
            });
            mockGetAccountsByUserId.mockResolvedValue([companyAccount]);

            const failingAdapter = createMockAdapter();
            failingAdapter.listPosts.mockRejectedValue(new Error('LinkedIn access token expired'));
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(failingAdapter);

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.posts).toHaveLength(0);
            // Account should still be in summaries with 0 posts
            expect(response.body.accounts).toHaveLength(1);
            expect(response.body.accounts[0]).toMatchObject({
                accountId: 'urn:li:organization:999',
                accountName: 'My Company',
                platform: 'linkedin',
                accountType: 'company_page',
                postCount: 0,
            });
        });
    });

    // SUCCESS tests
    describe('SUCCESS cases', () => {
        it('returns posts from a single LinkedIn personal account with metrics', async () => {
            const account = createMockAccount();
            mockGetAccountsByUserId.mockResolvedValue([account]);

            const posts = [
                { id: 'post1', content: 'First post', createdAt: '2026-03-10T12:00:00Z' },
                { id: 'post2', content: 'Second post', createdAt: '2026-03-09T12:00:00Z' },
            ];
            const metrics = [
                { share: 'post1', likes: 45, comments: 12, shares: 5, impressions: 1200, clicks: 30, engagement: 62 },
                { share: 'post2', likes: 20, comments: 5, shares: 2, impressions: 800, clicks: 15, engagement: 27 },
            ];
            const adapter = createMockAdapter(posts, metrics);
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.posts).toHaveLength(2);
            expect(response.body.posts[0]).toMatchObject({
                id: 'post1',
                accountId: 'urn:li:person:abc',
                accountName: 'John Doe',
                platform: 'linkedin',
                accountType: 'personal',
                metrics: {
                    likeCount: 45,
                    commentCount: 12,
                    shareCount: 5,
                    impressionCount: 1200,
                    clickCount: 30,
                    engagement: 62,
                },
            });
            expect(response.body.accounts).toHaveLength(1);
            expect(response.body.accounts[0]).toMatchObject({
                accountId: 'urn:li:person:abc',
                accountName: 'John Doe',
                platform: 'linkedin',
                accountType: 'personal',
                postCount: 2,
            });
        });

        it('returns aggregated posts from multiple accounts (LinkedIn + Instagram)', async () => {
            const linkedInAccount = createMockAccount();
            const instagramAccount = createMockAccount({
                platform: 'instagram' as connectedAccountsDb.PlatformType,
                account_id: 'ig:12345',
                account_name: 'My Instagram',
                config: {
                    account_type: 'business',
                    access_token: 'ig_token',
                    token_expires_at: Date.now() + 100000,
                } as any,
            });

            mockGetAccountsByUserId.mockResolvedValue([linkedInAccount, instagramAccount]);

            const liPosts = [{ id: 'li_post1', content: 'LinkedIn post', createdAt: '2026-03-10T12:00:00Z' }];
            const liMetrics = [{ share: 'li_post1', likes: 10, comments: 2, shares: 1, impressions: 500, clicks: 10, engagement: 13 }];
            const igPosts = [{ id: 'ig_post1', content: 'Instagram post', createdAt: '2026-03-09T12:00:00Z' }];
            const igMetrics = [{ share: 'ig_post1', likes: 50, comments: 10, shares: 0, impressions: 2000, clicks: 0, engagement: 60 }];

            const liAdapter = createMockAdapter(liPosts, liMetrics);
            const igAdapter = createMockAdapter(igPosts, igMetrics);

            (socialPlatformService.getAdapter as jest.Mock).mockImplementation((platform: string) => {
                return platform === 'linkedin' ? liAdapter : igAdapter;
            });

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.posts).toHaveLength(2);
            expect(response.body.accounts).toHaveLength(2);

            const platforms = response.body.posts.map((p: any) => p.platform);
            expect(platforms).toContain('linkedin');
            expect(platforms).toContain('instagram');
        });

        it('filters by accountId query parameter', async () => {
            const account1 = createMockAccount({ account_id: 'urn:li:person:abc' });
            const account2 = createMockAccount({
                account_id: 'urn:li:person:xyz',
                account_name: 'Other Account',
            });

            mockGetAccountsByUserId.mockResolvedValue([account1, account2]);

            const posts = [{ id: 'post1', content: 'Filtered post', createdAt: '2026-03-10T12:00:00Z' }];
            const adapter = createMockAdapter(posts, []);
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);

            const response = await request(app)
                .get('/api/social-posts?accountId=urn:li:person:abc')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.posts).toHaveLength(1);
            expect(response.body.accounts).toHaveLength(1);
            expect(response.body.accounts[0].accountId).toBe('urn:li:person:abc');
            // Adapter should only be called once (for the filtered account)
            expect(socialPlatformService.getAdapter).toHaveBeenCalledTimes(1);
        });

        it('handles metrics fetch failure gracefully for an account', async () => {
            const account = createMockAccount();
            mockGetAccountsByUserId.mockResolvedValue([account]);

            const posts = [{ id: 'post1', commentary: 'Test post', created: { time: 1769021158888 } }];
            const adapter = createMockAdapter(posts, []);
            adapter.getPostMetrics.mockRejectedValue(new Error('Metrics API down'));
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.posts).toHaveLength(1);
            expect(response.body.posts[0].metrics).toBeNull();
        });

        it('normalizes date from publishedAt and timestamp fallbacks', async () => {
            const account = createMockAccount();
            mockGetAccountsByUserId.mockResolvedValue([account]);

            const posts = [
                { id: 'post1', commentary: 'Published post', publishedAt: 1770000000000 },
                { id: 'post2', commentary: 'Timestamp post', timestamp: 1771000000000 },
                { id: 'post3', commentary: 'No date post' },
            ];
            const adapter = createMockAdapter(posts, []);
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);

            const response = await request(app)
                .get('/api/social-posts?include_metrics=false')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.posts).toHaveLength(3);

            const post1 = response.body.posts.find((p: any) => p.id === 'post1');
            expect(post1.createdAt).toBe(new Date(1770000000000).toISOString());

            const post2 = response.body.posts.find((p: any) => p.id === 'post2');
            expect(post2.createdAt).toBe(new Date(1771000000000).toISOString());

            const post3 = response.body.posts.find((p: any) => p.id === 'post3');
            // Should have a valid ISO date (current time fallback)
            expect(new Date(post3.createdAt).toISOString()).toBe(post3.createdAt);
        });

        it('returns 500 when service throws unexpected error', async () => {
            mockGetAccountsByUserId.mockRejectedValue(new Error('DynamoDB connection failed'));

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Failed to fetch social posts');
        });

        it('normalizes LinkedIn data shapes (commentary, created.time, object content)', async () => {
            const personalAccount = createMockAccount({
                account_id: 'urn:li:person:abc',
                account_name: 'Personal User',
                config: { account_type: 'personal', access_token: 'tok', token_expires_at: Date.now() + 100000 } as any,
            });
            const companyAccount = createMockAccount({
                account_id: 'urn:li:org:xyz',
                account_name: 'Company Page',
                config: { account_type: 'company_page', access_token: 'tok2', token_expires_at: Date.now() + 100000 } as any,
            });

            mockGetAccountsByUserId.mockResolvedValue([personalAccount, companyAccount]);

            // Personal LinkedIn post: text in 'commentary', date in 'created.time'
            const personalPosts = [{
                id: 'post1',
                commentary: 'Personal post text here',
                created: { time: 1769021158888 },
                lifecycleState: 'PUBLISHED',
            }];
            // Company LinkedIn post: text in 'commentary', date in 'createdAt' (number), 'content' is object
            const companyPosts = [{
                id: 'post2',
                commentary: 'Company post text here',
                createdAt: 1773248591139,
                content: { media: { id: 'urn:li:image:123' } },
                lifecycleState: 'PUBLISHED',
            }];

            const personalAdapter = createMockAdapter(personalPosts, []);
            const companyAdapter = createMockAdapter(companyPosts, []);

            let callCount = 0;
            (socialPlatformService.getAdapter as jest.Mock).mockImplementation(() => {
                callCount++;
                return callCount === 1 ? personalAdapter : companyAdapter;
            });

            const response = await request(app)
                .get('/api/social-posts?include_metrics=false')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.posts).toHaveLength(2);

            // Personal post: content from commentary, createdAt from created.time
            const post1 = response.body.posts.find((p: any) => p.id === 'post1');
            expect(post1.content).toBe('Personal post text here');
            expect(post1.createdAt).toBe(new Date(1769021158888).toISOString());
            // Should not have raw 'created' object leaking through
            expect(post1.created).toBeUndefined();

            // Company post: content from commentary (not the object), createdAt from numeric timestamp
            const post2 = response.body.posts.find((p: any) => p.id === 'post2');
            expect(post2.content).toBe('Company post text here');
            expect(post2.createdAt).toBe(new Date(1773248591139).toISOString());
            // content field should be string, not the original object
            expect(typeof post2.content).toBe('string');
        });

        it('normalizes content from text and caption fields', async () => {
            const account = createMockAccount();
            mockGetAccountsByUserId.mockResolvedValue([account]);

            const posts = [
                { id: 'post1', text: 'Text field post', createdAt: '2026-03-10T12:00:00Z' },
                { id: 'post2', caption: 'Caption field post', createdAt: '2026-03-09T12:00:00Z' },
            ];
            const adapter = createMockAdapter(posts, []);
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);

            const response = await request(app)
                .get('/api/social-posts?include_metrics=false')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            const post1 = response.body.posts.find((p: any) => p.id === 'post1');
            expect(post1.content).toBe('Text field post');
            const post2 = response.body.posts.find((p: any) => p.id === 'post2');
            expect(post2.content).toBe('Caption field post');
        });

        it('skips non-social accounts (unipile, gmail, meta)', async () => {
            const linkedInAccount = createMockAccount();
            const unipileAccount = createMockAccount({
                platform: 'unipile' as connectedAccountsDb.PlatformType,
                account_id: 'unipile_123',
                account_name: 'Unipile Account',
            });
            const gmailAccount = createMockAccount({
                platform: 'gmail' as connectedAccountsDb.PlatformType,
                account_id: 'gmail_123',
                account_name: 'Gmail Account',
            });
            const metaAccount = createMockAccount({
                platform: 'meta' as connectedAccountsDb.PlatformType,
                account_id: 'meta_123',
                account_name: 'Meta Account',
            });

            mockGetAccountsByUserId.mockResolvedValue([linkedInAccount, unipileAccount, gmailAccount, metaAccount]);

            const posts = [{ id: 'post1', content: 'LinkedIn post', createdAt: '2026-03-10T12:00:00Z' }];
            const adapter = createMockAdapter(posts, []);
            (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);

            const response = await request(app)
                .get('/api/social-posts')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.posts).toHaveLength(1);
            expect(response.body.accounts).toHaveLength(1);
            expect(response.body.accounts[0].platform).toBe('linkedin');
            // Only called once for linkedin, skipped unipile/gmail/meta
            expect(socialPlatformService.getAdapter).toHaveBeenCalledTimes(1);
        });
    });
});

