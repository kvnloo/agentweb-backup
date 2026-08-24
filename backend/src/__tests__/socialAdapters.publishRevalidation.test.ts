import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { YouTubeAdapter } from '../services/adapters/youtubeAdapter';

/**
 * ENG-827 (Greptile, security) — the consent re-check must sit in front of the
 * IRREVERSIBLE REQUEST, not in front of the adapter.
 *
 * The dispatcher re-checks before calling `createPost`, which reads like a last-moment
 * guard but is not: LinkedIn uploads every image and YouTube downloads and then uploads
 * an entire video INSIDE that call. For a video that is minutes of work, all of it
 * running on a decision taken before it began, so an owner who revokes during the
 * upload had the post go out anyway and learned about it only once it was public.
 *
 * These tests pin the ordering. They assert the two things that actually matter — that
 * the publish request is NOT issued, and that the abandonment is reported as a refusal
 * rather than a platform failure the model might retry.
 */

jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    uploadImageFromUrl: jest.fn(),
    createPost: jest.fn(),
  },
}));
jest.mock('../services/connectedAccountsDb', () => ({ updateAccountTokens: jest.fn() }));
jest.mock('../config/integrations', () => ({ getYouTubeConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('axios');

const WITHDRAWN = { success: false as const, error: 'post_on_connected_account was not executed: consent withdrawn.' };

describe('LinkedIn — consent is re-checked after image upload (ENG-827)', () => {
  const account: any = {
    account_id: 'urn:li:person:abc',
    config: { account_type: 'personal', access_token: 't', token_expires_at: Date.now() + 3600_000 },
    userId: 'u1',
  };

  beforeEach(() => jest.clearAllMocks());

  it('does NOT publish when consent is withdrawn while the image uploads', async () => {
    const { linkedInService } = require('../services/linkedInService');
    linkedInService.uploadImageFromUrl.mockResolvedValue('urn:li:image:1');

    const adapter = new LinkedInAdapter();
    const result = await adapter.createPost(
      account, 'hello', ['https://example.com/a.png'], 'u1',
      async () => WITHDRAWN
    );

    // The upload happened — the revocation landed during it — but nothing was posted.
    expect(linkedInService.uploadImageFromUrl).toHaveBeenCalled();
    expect(linkedInService.createPost).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toContain('consent withdrawn');
  });

  it('publishes normally when consent still stands', async () => {
    const { linkedInService } = require('../services/linkedInService');
    linkedInService.uploadImageFromUrl.mockResolvedValue('urn:li:image:1');
    linkedInService.createPost.mockResolvedValue('urn:li:share:99');

    const adapter = new LinkedInAdapter();
    const result = await adapter.createPost(
      account, 'hello', ['https://example.com/a.png'], 'u1',
      async () => null
    );

    expect(linkedInService.createPost).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('publishes when no hook is supplied — interactive and direct calls are unaffected', async () => {
    const { linkedInService } = require('../services/linkedInService');
    linkedInService.createPost.mockResolvedValue('urn:li:share:99');

    const adapter = new LinkedInAdapter();
    const result = await adapter.createPost(account, 'hello', undefined, 'u1');

    expect(linkedInService.createPost).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

describe('YouTube — consent is re-checked after the video is fetched (ENG-827)', () => {
  const account: any = {
    account_id: 'chan-1',
    config: { account_type: 'channel', channel_id: 'chan-1', access_token: 't' },
    userId: 'u1',
  };

  beforeEach(() => jest.clearAllMocks());

  it('does NOT upload the video when consent is withdrawn during the download', async () => {
    const axios = require('axios');
    axios.get.mockResolvedValue({ data: Buffer.from('video-bytes') });
    axios.post.mockResolvedValue({ data: { id: 'vid1' } });
    axios.put.mockResolvedValue({ data: { id: 'vid1' } });

    const adapter = new YouTubeAdapter();
    const result = await adapter.createPost(
      account, 'my video', ['https://example.com/v.mp4'], 'u1',
      async () => WITHDRAWN
    );

    // The download ran; the upload — the irreversible act — did not.
    expect(axios.get).toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.put).not.toHaveBeenCalled();
    // Reported as a refusal, NOT as a YouTube error the model might retry.
    expect(result.success).toBe(false);
    expect(result.message).toContain('consent withdrawn');
  });

  it('uploads normally when consent still stands', async () => {
    const axios = require('axios');
    axios.get.mockResolvedValue({ data: Buffer.from('video-bytes') });
    axios.post.mockResolvedValue({ data: { id: 'vid1' } });
    axios.put.mockResolvedValue({ data: { id: 'vid1' } });

    const adapter = new YouTubeAdapter();
    const result = await adapter.createPost(
      account, 'my video', ['https://example.com/v.mp4'], 'u1',
      async () => null
    );

    expect(axios.post).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
