import axios from 'axios';
import { FacebookPageAdapter } from '../services/adapters/facebookPageAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({}));
jest.mock('../config/integrations', () => ({
    INTEGRATION_CONFIG: { meta: { pagesApiBaseUrl: 'https://graph.test/v99' } },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const page: ConnectedAccount = {
    account_id: '168468393014092',
    account_name: 'Anytime AI',
    platform: 'meta',
    config: { account_type: 'page', page_id: '168468393014092', access_token: 'PAGE_TOKEN', token_expires_at: 0 },
} as any;

describe('FacebookPageAdapter (ENG-2940)', () => {
    const adapter = new FacebookPageAdapter();
    beforeEach(() => jest.resetAllMocks());

    it('publishes a text post to /{page}/feed with the page token', async () => {
        mockedAxios.post.mockResolvedValue({ data: { id: '168468393014092_1' } });
        const r = await adapter.createPost(page, 'hello');
        expect(mockedAxios.post).toHaveBeenCalledWith('https://graph.test/v99/168468393014092/feed', null,
            { params: { message: 'hello', access_token: 'PAGE_TOKEN' } });
        expect(r).toEqual(expect.objectContaining({ success: true, postId: '168468393014092_1', postUrl: 'https://www.facebook.com/168468393014092_1' }));
    });

    it('publishes a single image to /{page}/photos and returns the post_id', async () => {
        mockedAxios.post.mockResolvedValue({ data: { id: 'photo1', post_id: '168468393014092_2' } });
        const r = await adapter.createPost(page, 'cap', ['https://x/img.png']);
        expect(mockedAxios.post.mock.calls[0][0]).toBe('https://graph.test/v99/168468393014092/photos');
        expect(r.postId).toBe('168468393014092_2');
    });

    it('surfaces a permission error as a failure, never success', async () => {
        mockedAxios.post.mockRejectedValue({ response: { data: { error: { code: 200, message: 'Requires pages_manage_posts' } } } });
        await expect(adapter.createPost(page, 'hello')).rejects.toThrow(/permission missing \(pages_manage_posts\)/);
    });

    it('does not publish when the last-moment consent check refuses', async () => {
        const r = await adapter.createPost(page, 'hello', undefined, undefined, async () => ({ success: false as const, error: 'revoked' }));
        expect(r).toEqual({ success: false, message: 'revoked' });
        expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('rejects non-page accounts (e.g. ad accounts)', async () => {
        const ad = { ...page, config: { account_type: 'ad_account', access_token: 't', token_expires_at: 0 } } as any;
        await expect(adapter.createPost(ad, 'hello')).rejects.toThrow(/connected Facebook Page/);
        expect(await adapter.verifyToken(ad)).toBe(false);
    });

    it('lists page posts', async () => {
        mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'p1', message: 'm', created_time: '2026-11-01T00:00:00Z' }] } });
        const posts = await adapter.listPosts(page, { limit: 5 });
        expect(posts[0]).toEqual(expect.objectContaining({ id: 'p1', commentary: 'm' }));
    });
});
