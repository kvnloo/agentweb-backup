
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
        .use(remarkGfm) // GitHub Flavored Markdown support
        .use(remarkBreaks) // Convert line breaks to <br> tags
        .use(remarkHtml, { sanitize: false }); // Convert to HTML

      // Generate HTML for each post
      const postsHtml = posts.map((post, index) => {
        const postNumber = index + 1;
        // Map post types to display labels
        const typeLabelMap: Record<string, string> = {
          'linkedin': 'LinkedIn',
          'x/twitter': 'X (Twitter)',
          'instagram': 'Instagram',
          'facebook': 'Facebook',
          'custom': 'Custom'
        };
        const typeLabel = typeLabelMap[post.type] || post.type.charAt(0).toUpperCase() + post.type.slice(1);

        // Convert markdown content to HTML
        const htmlContent = processor.processSync(post.content || '').toString();

        // Build post HTML
        let postHtml = `
      <div class="post" data-type="${post.type}">
        <div class="post-header">
          <span class="post-number">Post ${postNumber}</span>
          <span class="post-type">${typeLabel}</span>
        </div>
        <div class="post-content">
          ${htmlContent}
        </div>`;

        // Add image if provided
        if (post.image_url) {
          postHtml += `
        <div class="post-image">
          <img src="${post.image_url}" alt="Post image" />
        </div>`;
        }

        // Add copy button
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
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            padding: 30px;
        }
        h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #1a1a1a;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .post {
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
            background-color: #fafafa;
        }
        .post-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e0e0e0;
        }
        .post-number {
            font-weight: 600;
            color: #666;
            font-size: 14px;
        }
        .post-type {
            background-color: #0077b5;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .post[data-type="x/twitter"] .post-type {
            background-color: #1da1f2;
        }
        .post[data-type="instagram"] .post-type {
            background: linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%);
        }
        .post[data-type="facebook"] .post-type {
            background-color: #1877f2;
        }
        .post[data-type="custom"] .post-type {
            background-color: #666;
        }
        .post-content {
            margin: 15px 0;
            font-size: 16px;
            line-height: 1.6;
            color: #333;
        }
        .post-content p {
            margin-bottom: 12px;
        }
        .post-content h1, .post-content h2, .post-content h3 {
            margin-top: 20px;
            margin-bottom: 12px;
        }
        .post-content ul, .post-content ol {
            margin-left: 20px;
            margin-bottom: 12px;
        }
        .post-content a {
            color: #0077b5;
            text-decoration: none;
        }
        .post-content a:hover {
            text-decoration: underline;
        }
        .post-content img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            margin: 15px 0;
            display: block;
        }
        .post-image {
            margin: 15px 0;
        }
        .post-image img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .post-actions {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #e0e0e0;
        }
        .copy-button {
            background-color: #0077b5;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background-color 0.2s;
        }
        .copy-button:hover {
            background-color: #005885;
        }
        .copy-button:active {
            transform: scale(0.98);
        }
        .post-raw-content {
            display: none;
        }
        @media (max-width: 600px) {
            .container {
                padding: 15px;
            }
            .post {
                padding: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Social Media Posts</h1>
        <p class="subtitle">${posts.length} post${posts.length !== 1 ? 's' : ''} created</p>
        ${postsHtml}
    </div>
    <script>
        function copyPostContent(index) {
            const rawContentElement = document.getElementById('post-' + index + '-raw');
            if (!rawContentElement) return;
            
            const content = rawContentElement.textContent || rawContentElement.innerText;
            
            // Create a temporary textarea to copy text
            const textarea = document.createElement('textarea');
            textarea.value = content;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            
            try {
                document.execCommand('copy');
                const button = event.target;
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.style.backgroundColor = '#28a745';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.backgroundColor = '#0077b5';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
                alert('Failed to copy content. Please select and copy manually.');
            }
            
            document.body.removeChild(textarea);
        }
    </script>
</body>
</html>`;

      // Upload HTML file to S3
      console.log('SocialMediaService: Uploading social media posts HTML file to S3...');
      const htmlFilename = `social-media-posts-${Date.now()}.html`;

      const uploadResult = await uploadFileToS3(
        htmlContent,
        htmlFilename,
        userId,
        'text/html'
      );

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      }

      const htmlUrl = uploadResult.url;

      console.log('SocialMediaService: Social media posts HTML file uploaded successfully to:', htmlUrl);

      return {
        success: true,
        message: `Successfully created ${posts.length} social media post${posts.length !== 1 ? 's' : ''}`,
        htmlUrl: htmlUrl,
        postsCount: posts.length
      };

    } catch (error: any) {
      console.error('SocialMediaService: Error creating social media posts:', error);
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
      const { getAccountById, isTokenValid } = await import('../connectedAccountsDb');
      const { socialPlatformService } = await import('../socialPlatformService');

      try {
        const account = await getAccountById(accountId, userId);

        if (!account) {
          return {
            success: false,
            message: 'Account not found or access denied'
          };
        }

        if (!(await isTokenValid(account))) {
          return {
            success: false,
            message: 'Account token expired. Please reconnect the account in Settings.'
          };
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
        // Handle specific error messages
        let message = error.message;
        if (message.includes('access token expired')) {
          message = 'Account token expired. Please reconnect the account in Settings.';
        }
        
        return {
          success: false,
          message: `Failed to post: ${message}`
        };
      }

    } catch (error) {
      console.error('SocialMediaService: Error posting on account:', error);
      return {
        success: false,
        message: 'Failed to create post',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Singleton instance
export const socialMediaService = new SocialMediaService();
