
import { ToolService } from '../../tools/ServiceRegistry';

/**
 * Social Media Service
 * Manages social media post creation and publishing.
 */

export class SocialMediaService implements ToolService {
  readonly serviceName = 'social_media';

  /**
   * Create social media posts from content
   */
  async createSocialMediaPosts(
    posts: Array<{ type: string; content: string; image_url?: string }>,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('SocialMediaService: Creating social media posts, count:', posts?.length || 0);

      if (!posts || !Array.isArray(posts) || posts.length === 0) {
        return {
          success: false,
          message: 'No posts provided. Please provide an array of posts.',
          error: 'invalid_input'
        };
      }

      // Import required utilities
      const { uploadFileToS3 } = await import('../../utils/s3Utils');

      // Dynamically import remark modules (ES modules)
      const { remark } = await import('remark');
      const remarkHtml = (await import('remark-html')).default;
      const remarkGfm = (await import('remark-gfm')).default;
      const remarkBreaks = (await import('remark-breaks')).default;

      // Convert markdown to HTML processor
      const processor = remark()
        .use(remarkGfm)
        .use(remarkBreaks)
        .use(remarkHtml, { sanitize: false });

      // Generate HTML for each post
      const postsHtml = posts.map((post, index) => {
        const postNumber = index + 1;
        const typeLabelMap: Record<string, string> = {
          'linkedin': 'LinkedIn',
          'x/twitter': 'X (Twitter)',
          'instagram': 'Instagram',
          'facebook': 'Facebook',
          'custom': 'Custom'
        };
        const typeLabel = typeLabelMap[post.type] || post.type.charAt(0).toUpperCase() + post.type.slice(1);

        const htmlContent = processor.processSync(post.content || '').toString();

        let postHtml = `
      <div class="post" data-type="${post.type}">
        <div class="post-header">
          <span class="post-number">Post ${postNumber}</span>
          <span class="post-type">${typeLabel}</span>
        </div>
        <div class="post-content">
          ${htmlContent}
        </div>`;

        if (post.image_url) {
          postHtml += `
        <div class="post-image">
          <img src="${post.image_url}" alt="Post image" />
        </div>`;
        }

        postHtml += `
        <div class="post-actions">
          <button class="copy-button" onclick="copyPostContent(${index})">Copy Content</button>
        </div>
        <div class="post-raw-content" id="post-${index}-raw" style="display: none;">${post.content}</div>
      </div>`;

        return postHtml;
      }).join('\n');

      // Generate complete HTML file
      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Social Media Posts</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); padding: 30px; }
        h1 { font-size: 28px; font-weight: 700; margin-bottom: 10px; color: #1a1a1a; }
        .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
        .post { border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 30px; background-color: #fafafa; }
        .post-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #e0e0e0; }
        .post-number { font-weight: 600; color: #666; font-size: 14px; }
        .post-type { background-color: #0077b5; color: white; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
        .post[data-type="x/twitter"] .post-type { background-color: #000000; }
        .post[data-type="instagram"] .post-type { background-color: #E1306C; }
        .post[data-type="facebook"] .post-type { background-color: #1877F2; }
        .post-content { margin-bottom: 20px; }
        .post-content p { margin-bottom: 10px; }
        .post-image { margin-top: 15px; border-radius: 4px; overflow: hidden; }
        .post-image img { max-width: 100%; height: auto; display: block; }
        .post-actions { display: flex; justify-content: flex-end; }
        .copy-button { background-color: #4a90e2; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background-color 0.2s; }
        .copy-button:hover { background-color: #357abd; }
        .copy-button.copied { background-color: #4caf50; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Social Media Posts</h1>
        <div class="subtitle">Generated posts ready for review and publishing</div>
        ${postsHtml}
    </div>
    <script>
        function copyPostContent(index) {
            const rawContent = document.getElementById('post-' + index + '-raw').innerText;
            navigator.clipboard.writeText(rawContent).then(() => {
                const button = document.querySelector(\`button[onclick="copyPostContent(\${index})"]\`);
                const originalText = button.innerText;
                button.innerText = 'Copied!';
                button.classList.add('copied');
                setTimeout(() => {
                    button.innerText = originalText;
                    button.classList.remove('copied');
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
            });
        }
    </script>
</body>
</html>`;

      const fileName = `social-posts-${Date.now()}.html`;
      const uploadResult = await uploadFileToS3(
        htmlContent,
        fileName,
        userId,
        'text/html'
      );

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload social media posts HTML to S3');
      }

      return {
        success: true,
        message: `✅ Created ${posts.length} social media posts successfully!`,
        html_url: uploadResult.url,
        posts_count: posts.length
      };

    } catch (error: any) {
      console.error('SocialMediaService: Error creating posts:', error);
      return {
        success: false,
        message: 'Failed to create social media posts',
        error: error.message
      };
    }
  }

  /**
   * Post content to a connected social media account
   */
  async postOnConnectedAccount(
    userId: string,
    accountId: string,
    content: string,
    mediaUrls: string[] = []
  ): Promise<any> {
    try {
      const { getAccountById, isTokenValid } = await import('../../connectedAccountsDb');
      const { socialPlatformService } = await import('../../socialPlatformService');

      try {
        const account = await getAccountById(accountId, userId);

        if (!account) {
          return { success: false, message: 'Account not found or access denied' };
        }

        if (!(await isTokenValid(account))) {
          return { success: false, message: 'Account token expired. Please reconnect the account in Settings.' };
        }

        const adapter = socialPlatformService.getAdapter(account.platform);
        const result = await adapter.createPost(account, content, mediaUrls);

        return {
          success: true,
          message: result.message,
          post_id: result.postId,
          post_url: result.postUrl
        };
      } catch (error: any) {
        let message = error.message;
        if (message.includes('access token expired')) {
          message = 'Account token expired. Please reconnect the account in Settings.';
        }
        return { success: false, message: `Failed to post: ${message}` };
      }

    } catch (error: any) {
      console.error('SocialMediaService: Error posting on account:', error);
      return {
        success: false,
        message: 'Failed to create post',
        error: error.message
      };
    }
  }
}

// Singleton instance
export const socialMediaService = new SocialMediaService();
