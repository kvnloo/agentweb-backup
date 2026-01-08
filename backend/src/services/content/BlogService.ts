
import { ToolService } from '../../tools/ServiceRegistry';
import axios from 'axios';

/**
 * Blog Service
 * 
 * Handles blog article creation with optional deep research.
 */

/**
 * Blog article options - matches agentModeService.ts pattern
 */
export interface BlogArticleOptions {
  titleDraft: string;
  contentDraft: string;
  length?: 'short' | 'medium' | 'long';
  researchContext?: string;
  requirements?: string;
  userId: string;
  sessionId: string;
  style?: 'default' | 'substack';
  deepResearch?: boolean;
}

/**
 * Blog article result - matches agentModeService.ts pattern
 */
export interface BlogArticleResult {
  success: boolean;
  message: string;
  data?: {
    title: string;
    description: string;
    heroImageUrl: string;
    imageUrl: string;
    htmlUrl: string;
    deepResearchUsed: boolean;
    inlineImagesCount: number;
    wordCount: number;
  };
  error?: string;
}

/**
 * Parse image placeholders from content
 * Matches {{IMAGE: prompt="...", caption="..."}} pattern
 */
function parseImagePlaceholders(content: string): Array<{
  fullMatch: string;
  prompt: string;
  caption: string;
}> {
  const placeholders: Array<{ fullMatch: string; prompt: string; caption: string }> = [];

  // Match {{IMAGE: prompt="...", caption="..."}} pattern
  const regex = /\{\{IMAGE:\s*prompt="([^"]+)",\s*caption="([^"]+)"\}\}/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    placeholders.push({
      fullMatch: match[0],
      prompt: match[1],
      caption: match[2]
    });
  }

  return placeholders;
}

/**
 * Replace {{IMAGE: ...}} placeholders with actual <figure> HTML
 */
function replaceImagePlaceholders(
  content: string,
  placeholders: Array<{ fullMatch: string; prompt: string; caption: string }>,
  imageUrls: string[]
): string {
  let result = content;

  placeholders.forEach((placeholder, index) => {
    const imageUrl = imageUrls[index];
    if (!imageUrl) {
      // Remove placeholder if no image was generated
      result = result.replace(placeholder.fullMatch, '');
      return;
    }

    const figureMarkdown = `
![${placeholder.caption}](${imageUrl})
*${placeholder.caption}*
`;

    result = result.replace(placeholder.fullMatch, figureMarkdown);
  });

  return result;
}

/**
 * Blog Service - handles blog article creation and publishing
 */
export class BlogService implements ToolService {
  readonly serviceName = 'blog';

  /**
   * Create a blog article - refactored to match agentModeService.ts pattern
   */
  async createBlogArticle(
    titleDraft: string,
    contentDraft: string,
    length: string,
    researchContext: string,
    requirements: string,
    userId: string,
    sessionId: string,
    style: string = 'default',
    deepResearch: boolean = false
  ): Promise<any> {
    try {
      // Import required services
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { generateBlogImage, generateBlogHtml, generateBlogContent } = await import('../../controllers/blog');

      if (!titleDraft || !contentDraft) {
        throw new Error("title_draft and content_draft are required");
      }

      // Calculate first and last 100 bytes for logging
      const contentLength = contentDraft.length;
      const first100Bytes = contentDraft.substring(0, Math.min(100, contentLength));
      const last100Bytes = contentLength > 100 ? contentDraft.substring(contentLength - 100) : contentDraft;
      const contentPreview = `${contentLength}: ${first100Bytes}...${last100Bytes}`;

      console.log('BlogService: Creating blog article for title_draft:', titleDraft, 'length:', length, 'deepResearch:', deepResearch, 'userId:', userId, 'content_draft:', contentPreview);

      // Import restyleContent for processing the draft
      const { restyleContent } = await import('../../controllers/blog');

      let blogData: { title: string; description: string; content: string; imagePrompt: string };
      let finalContent: string;
      let inlineImagesCount = 0;

      if (deepResearch) {
        // ========================================
        // DEEP RESEARCH FLOW: Research + Restyle + Inline Images
        // ========================================
        console.log('BlogService: Deep research enabled, performing research...');
        const { deepResearchService } = await import('../deepResearchService');

        // Combine title_draft and content_draft as topic for deep research
        const researchTopic = `${titleDraft}\n\n${contentDraft}`;

        const researchResult = await deepResearchService.performDeepResearch({
          topic: researchTopic,
          prompt: requirements || undefined,
          tone: 'professional',
          style
        });

        if (!researchResult.success || !researchResult.markdownContent) {
          throw new Error(researchResult.error || 'Deep research failed');
        }

        console.log('BlogService: Deep research complete. Length:', researchResult.markdownContent.length);
        console.log('BlogService: Restyling research content with style:', style);

        // Restyle with inline image placeholders
        blogData = await restyleContent(
          researchResult.markdownContent,
          titleDraft,
          'professional',
          style,
          true // includeInlineImages = true for deep research
        );

        if (!blogData.title || !blogData.content) {
          throw new Error("Blog content restyling failed");
        }

        // Use the generated title from blogData (not the draft)

        // Parse and generate inline images
        const placeholders = parseImagePlaceholders(blogData.content);
        console.log(`BlogService: Found ${placeholders.length} image placeholders in content`);

        if (placeholders.length > 0) {
          console.log('BlogService: Generating inline images...');
          const inlineImageResults = await Promise.all(
            placeholders.map(p => generateBlogImage(p.prompt, userId))
          );

          const inlineImageUrls = inlineImageResults.map(r => r.imageUrl || '');
          inlineImagesCount = inlineImageUrls.filter(u => u).length;
          console.log(`BlogService: Generated ${inlineImagesCount} inline images successfully`);

          // Replace placeholders with actual image URLs
          finalContent = replaceImagePlaceholders(blogData.content, placeholders, inlineImageUrls);
          console.log('BlogService: Replaced image placeholders with actual images');
        } else {
          finalContent = blogData.content;
        }
      } else {
        // ========================================
        // STANDARD FLOW: Generate content from draft
        // ========================================
        console.log('BlogService: Generating blog content from draft with style:', style);
        blogData = await generateBlogContent(
          titleDraft,
          contentDraft,
          length,
          researchContext,
          requirements,
          style
        );

        if (!blogData.title || !blogData.content) {
          throw new Error("Blog content generation failed");
        }

        console.log('BlogService: Blog content ready. Title:', blogData.title);
        finalContent = blogData.content;
      }

      // ========================================
      // COMMON: Generate Hero Image
      // ========================================
      console.log('BlogService: Generating hero image...');
      const heroResult = await generateBlogImage(blogData.imagePrompt, userId);
      if (!heroResult.imageUrl) {
        throw new Error('Hero image generation failed');
      }
      const heroImageUrl = heroResult.imageUrl;
      console.log('BlogService: Hero image generated successfully');

      // ========================================
      // COMMON: Build HTML and Upload to S3
      // ========================================
      console.log('BlogService: Generating HTML file with style:', style);
      const htmlContent = await generateBlogHtml(
        blogData.title,
        blogData.description,
        finalContent,
        heroImageUrl,
        style
      );
      console.log('BlogService: Uploading HTML file to S3...');
      const htmlFilename = `blog-${Date.now()}.html`;

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
      console.log('BlogService: HTML file uploaded successfully to:', htmlUrl);

      // Calculate word count from the content
      const wordCount = blogData.content.split(/\s+/).filter((word: string) => word.length > 0).length;

      return {
        success: true,
        message: this.getBlogSuccessMessage(deepResearch, inlineImagesCount),
        data: {
          title: blogData.title,
          description: blogData.description,
          heroImageUrl: heroImageUrl,
          imageUrl: heroImageUrl,
          htmlUrl: htmlUrl,
          deepResearchUsed: deepResearch,
          inlineImagesCount: inlineImagesCount,
          wordCount: wordCount
        }
      };

    } catch (error: any) {
      console.error('BlogService: Error creating blog article:', error);
      return {
        success: false,
        message: 'Failed to create blog article',
        error: error.message
      };
    }
  }

  /**
   * Publish blog article to CMS
   */
  async publishBlogArticle(
    title: string,
    description: string,
    heroImageUrl: string,
    blogHtmlUrl: string,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('BlogService: Publishing blog article - Title:', title);

      // Step 1: Fetch HTML and extract body content
      const htmlResponse = await axios.get(blogHtmlUrl, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      const htmlContent = htmlResponse.data as string;

      // Extract content from <div class="content"> - find first opening tag and last closing tag before </body>
      const contentDivStart = htmlContent.search(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>/i);
      if (contentDivStart === -1) {
        throw new Error('Could not extract content from HTML. Expected <div class="content"> element.');
      }

      // Find the position after the opening tag
      const afterOpenTag = htmlContent.indexOf('>', contentDivStart) + 1;

      // Find the last </div> before </body>
      const bodyEnd = htmlContent.lastIndexOf('</body>');
      if (bodyEnd === -1) {
        throw new Error('Could not find </body> tag in HTML');
      }

      // Find the last </div> before </body>
      const lastDivClose = htmlContent.lastIndexOf('</div>', bodyEnd);
      if (lastDivClose === -1) {
        throw new Error('Could not find closing </div> tag for content');
      }

      // Extract everything between the opening tag and the last </div>
      let bodyHtml = htmlContent.substring(afterOpenTag, lastDivClose).trim();

      if (!bodyHtml) {
        throw new Error('Content is empty after cleaning');
      }

      // Extract image filename from URL
      let imageFilename: string | undefined;
      if (heroImageUrl) {
        const urlParts = heroImageUrl.split('/');
        imageFilename = urlParts[urlParts.length - 1];
      }

      // Step 3: Get user's CMS type
      const { userDb } = await import('../db');
      const user = await userDb.getUserById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      const cmsType = user.cmsType;

      if (!cmsType) {
        return {
          success: false,
          message: 'CMS Type is not configured for this user. Please contact an administrator to set up CMS publishing.',
          error: 'CMS Type not configured'
        };
      }

      console.log('BlogService: User CMS Type:', cmsType);

      // Step 4: Publish to CMS
      // Only Webflow is supported for publish_blog_article function
      if (cmsType === 'Webflow') {
        const { getWebflowConfig } = await import('../../controllers/blog');
        const { apiToken, siteId, collectionId, fieldMappings } = await getWebflowConfig(userId);

        // Call Webflow publishing
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        const cmsItemData: any = {
          fieldData: {
            name: title,
            slug: slug,
            _archived: false,
            _draft: false,
          }
        };

        // Use body HTML directly for Webflow
        // Webflow API may strip HTML tags if newlines are present, so remove them
        const cleanBodyHtml = bodyHtml.replace(/\n/g, '').replace(/\r/g, '');

        if (fieldMappings?.summary) {
          cmsItemData.fieldData[fieldMappings.summary] = description;
        }

        if (fieldMappings?.body) {
          cmsItemData.fieldData[fieldMappings.body] = cleanBodyHtml;
        }

        if (heroImageUrl && fieldMappings?.image) {
          cmsItemData.fieldData[fieldMappings.image] = heroImageUrl;
        }

        const headers = {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'accept-version': '2.0.0'
        };

        try {
          const response = await axios.post(
            `https://api.webflow.com/v2/sites/${siteId}/collections/${collectionId}/items`,
            cmsItemData,
            { headers }
          );

          console.log('BlogService: Blog article published successfully to Webflow');

          // Sanitize response to remove large content fields before sending to LLM
          const responseData = response.data as any;
          const sanitizedResponse = responseData && typeof responseData === 'object'
            ? { ...responseData }
            : responseData;

          if (sanitizedResponse && sanitizedResponse.fieldData && typeof sanitizedResponse.fieldData === 'object') {
            const sanitizedFieldData = { ...sanitizedResponse.fieldData };
            // Remove large content fields that aren't needed by the LLM
            delete sanitizedFieldData['post-body'];
            delete sanitizedFieldData['body'];
            sanitizedResponse.fieldData = sanitizedFieldData;
          }

          return {
            success: true,
            message: 'Blog article published successfully to Webflow',
            data: {
              title,
              cmsType: 'Webflow',
              cmsResponse: sanitizedResponse
            }
          };
        } catch (webflowError: any) {
          // Extract detailed error information
          const errorInfo: any = {
            status: webflowError.response?.status,
            statusText: webflowError.response?.statusText,
          };

          if (webflowError.response?.data) {
            const errorData = webflowError.response.data;

            if (errorData.message) {
              errorInfo.message = errorData.message;
            }

            // Extract validation error details
            if (errorData.details && Array.isArray(errorData.details)) {
              errorInfo.details = errorData.details;
              const detailMessages = errorData.details
                .map((d: any) => `${d.param}: ${d.description}`)
                .join('; ');
              if (detailMessages) {
                errorInfo.message = `${errorInfo.message || 'Validation Error'}. ${detailMessages}`;
              }
            }
          }

          // Log concise error summary
          if (errorInfo.details && errorInfo.details.length > 0) {
            const errorDetails = errorInfo.details
              .map((d: any) => `${d.param}: ${d.description}`)
              .join(', ');
            console.error(`BlogService: Webflow API error (${errorInfo.status}): ${errorDetails}`);
          } else {
            console.error(`BlogService: Webflow API error (${errorInfo.status}): ${errorInfo.message}`);
          }

          // Create a more user-friendly error message
          const errorMessage = errorInfo.message || `Webflow API error: ${errorInfo.status} ${errorInfo.statusText}`;
          throw new Error(errorMessage);
        }
      } else if (cmsType === 'Basehub') {
        return {
          success: false,
          message: 'Basehub CMS is not supported for publish_blog_article function. Please use the Research Reports page to publish to Basehub.',
          error: 'Basehub not supported'
        };
      } else {
        return {
          success: false,
          message: `Unsupported CMS Type: ${cmsType}. Supported types are 'Basehub' and 'Webflow'.`,
          error: 'Unsupported CMS Type'
        };
      }
    } catch (error: any) {
      console.error('BlogService: Error publishing blog article:', error);

      // Extract detailed error information for better user feedback
      let errorMessage = error.message || 'Failed to publish blog article';

      if (error.response?.data) {
        const errorData = error.response.data;

        // Extract validation error details
        if (errorData.details && Array.isArray(errorData.details)) {
          const detailMessages = errorData.details
            .map((d: any) => {
              if (d.param && d.description) {
                return `${d.param}: ${d.description}`;
              }
              return JSON.stringify(d);
            })
            .join('; ');
          if (detailMessages) {
            errorMessage = `Webflow validation error: ${detailMessages}`;
          }
        } else if (errorData.message) {
          errorMessage = errorData.message;
        }
      }

      return {
        success: false,
        message: errorMessage,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Get success message based on options used
   */
  private getBlogSuccessMessage(deepResearch: boolean, inlineCount: number): string {
    const parts = ['Blog article created successfully'];
    if (deepResearch) parts.push('with deep research');
    if (inlineCount > 0) {
      parts.push(`and ${inlineCount} inline images`);
    }
    return parts.join(' ');
  }
}

// Singleton instance
export const blogService = new BlogService();
