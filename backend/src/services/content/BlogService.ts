
import { userDb } from '../db';
import { ToolService } from '../../tools/ServiceRegistry';
import axios from 'axios';

/**
 * Blog Service
 * 
 * Handles blog article creation with optional deep research.
 */

/**
 * Blog article options
 */
export interface BlogArticleOptions {
  topic: string;
  keywords?: string;
  tone?: 'professional' | 'casual' | 'friendly' | 'authoritative' | 'conversational';
  length?: 'short' | 'medium' | 'long';
  researchContext?: string;
  requirements?: string;
  userId: string;
  sessionId: string;
  style?: 'default' | 'substack';
  deepResearch?: boolean;
}

/**
 * Blog article result
 */
export interface BlogArticleResult {
  success: boolean;
  message: string;
  title?: string;
  description?: string;
  htmlUrl?: string;
  heroImageUrl?: string;
  wordCount?: number;
  inlineImagesCount?: number;
  error?: string;
}

/**
 * Parse image placeholders from content
 */
function parseImagePlaceholders(content: string): Array<{
  fullMatch: string;
  prompt: string;
  caption: string;
}> {
  const regex = /\{\{IMAGE:\s*prompt="([^"]+)"(?:,\s*caption="([^"]*)")?\}\}/g;
  const placeholders: Array<{ fullMatch: string; prompt: string; caption: string }> = [];
  
  let match;
  while ((match = regex.exec(content)) !== null) {
    placeholders.push({
      fullMatch: match[0],
      prompt: match[1],
      caption: match[2] || ''
    });
  }
  
  return placeholders;
}

/**
 * Replace image placeholders with actual HTML
 */
function replaceImagePlaceholders(
  content: string,
  placeholders: Array<{ fullMatch: string; prompt: string; caption: string }>,
  imageUrls: string[]
): string {
  let result = content;
  
  placeholders.forEach((placeholder, index) => {
    const imageUrl = imageUrls[index] || '';
    if (imageUrl) {
      const figureHtml = `<figure class="blog-inline-image">
        <img src="${imageUrl}" alt="${placeholder.caption || placeholder.prompt}" />
        ${placeholder.caption ? `<figcaption>${placeholder.caption}</figcaption>` : ''}
      </figure>`;
      result = result.replace(placeholder.fullMatch, figureHtml);
    } else {
      // Remove placeholder if image generation failed
      result = result.replace(placeholder.fullMatch, '');
    }
  });
  
  return result;
}

/**
 * Blog Service - handles blog article creation and publishing
 */
export class BlogService implements ToolService {
  readonly serviceName = 'blog';

  /**
   * Create a blog article
   */
  async createBlogArticle(
    topic: string,
    keywords: string = '',
    tone: 'professional' | 'casual' | 'friendly' | 'authoritative' | 'conversational' = 'professional',
    length: 'short' | 'medium' | 'long' = 'medium',
    researchContext: string = '',
    requirements: string = '',
    userId: string,
    sessionId: string,
    style: 'default' | 'substack' = 'default',
    deepResearch: boolean = false
  ): Promise<BlogArticleResult> {
    
    // Normalize string boolean if needed
    if (typeof deepResearch === 'string') {
        deepResearch = (deepResearch === 'true');
    }

    try {
      console.log('BlogService: Creating article for topic:', topic, 'deepResearch:', deepResearch);

      // Import required services
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { generateBlogImage, generateBlogHtml, generateBlogContent, restyleContent } = 
        await import('../../controllers/blog');

      let blogData: { title: string; description: string; content: string; imagePrompt: string };
      let finalContent: string;
      let inlineImagesCount = 0;

      if (deepResearch) {
        // Deep research flow
        console.log('BlogService: Performing deep research...');
        const { deepResearchService } = await import('../deepResearchService');

        const researchResult = await deepResearchService.performDeepResearch({
          topic,
          prompt: requirements || undefined,
          tone,
          style
        });

        if (!researchResult.success || !researchResult.markdownContent) {
          throw new Error(researchResult.error || 'Deep research failed');
        }

        // Restyle with inline image placeholders
        blogData = await restyleContent(
          researchResult.markdownContent,
          topic,
          tone,
          style,
          true // includeInlineImages
        );

        if (!blogData.title || !blogData.content) {
          throw new Error('Blog content generation failed');
        }

        // Parse and generate inline images
        const placeholders = parseImagePlaceholders(blogData.content);
        
        if (placeholders.length > 0) {
          console.log(`BlogService: Generating ${placeholders.length} inline images...`);
          const inlineImageResults = await Promise.all(
            placeholders.map(p => generateBlogImage(p.prompt, userId))
          );

          const inlineImageUrls = inlineImageResults.map(r => r.imageUrl || '');
          inlineImagesCount = inlineImageUrls.filter(u => u).length;

          finalContent = replaceImagePlaceholders(blogData.content, placeholders, inlineImageUrls);
        } else {
          finalContent = blogData.content;
        }

      } else {
        // Standard flow
        blogData = await generateBlogContent(
          topic, keywords, tone, length,
          researchContext, requirements, style
        );

        if (!blogData.title || !blogData.content) {
          throw new Error('Blog content generation failed');
        }

        finalContent = blogData.content;
      }

      // Generate hero image
      console.log('BlogService: Generating hero image...');
      const heroResult = await generateBlogImage(blogData.imagePrompt, userId);
      if (!heroResult.imageUrl) {
        throw new Error('Hero image generation failed');
      }

      // Build HTML and upload
      console.log('BlogService: Generating HTML...');
      const htmlContent = await generateBlogHtml(
        blogData.title,
        blogData.description,
        finalContent,
        heroResult.imageUrl,
        style
      );

      const htmlFilename = `blog-${Date.now()}.html`;
      const uploadResult = await uploadFileToS3(
        htmlContent,
        htmlFilename,
        userId,
        'text/html'
      );

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML to S3');
      }

      // Calculate word count
      const wordCount = finalContent.split(/\s+/).filter(w => w.length > 0).length;

      return {
        success: true,
        message: this.getSuccessMessage(deepResearch, inlineImagesCount),
        title: blogData.title,
        description: blogData.description,
        htmlUrl: uploadResult.url,
        heroImageUrl: heroResult.imageUrl,
        wordCount,
        inlineImagesCount
      };

    } catch (error: any) {
      console.error('BlogService: Error creating article:', error);
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

      // Extract content from <div class="content">
      const contentDivStart = htmlContent.search(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>/i);
      if (contentDivStart === -1) {
        throw new Error('Could not extract content from HTML. Expected <div class="content"> element.');
      }

      const afterOpenTag = htmlContent.indexOf('>', contentDivStart) + 1;
      const bodyEnd = htmlContent.lastIndexOf('</body>');
      if (bodyEnd === -1) {
        throw new Error('Could not find </body> tag in HTML');
      }

      const lastDivClose = htmlContent.lastIndexOf('</div>', bodyEnd);
      if (lastDivClose === -1) {
        throw new Error('Could not find closing </div> tag for content');
      }

      let bodyHtml = htmlContent.substring(afterOpenTag, lastDivClose).trim();
      if (!bodyHtml) {
        throw new Error('Content is empty after cleaning');
      }

      // Step 2: Get user's CMS type
      const user = await userDb.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const cmsType = user.cmsType;
      if (!cmsType) {
        return {
          success: false,
          message: 'CMS Type is not configured for this user.',
          error: 'CMS Type not configured'
        };
      }

      console.log('BlogService: User CMS Type:', cmsType);

      // Step 3: Publish to CMS (Webflow only for now)
      if (cmsType === 'Webflow') {
        const { getWebflowConfig } = await import('../../controllers/blog');
        const { apiToken, siteId, collectionId, fieldMappings } = await getWebflowConfig(userId);

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        const cmsItemData: any = {
          fieldData: {
            name: title,
            slug: slug,
            _archived: false,
            _draft: false,
          }
        };

        const cleanBodyHtml = bodyHtml.replace(/\n/g, '').replace(/\r/g, '');

        if (fieldMappings?.summary) cmsItemData.fieldData[fieldMappings.summary] = description;
        if (fieldMappings?.body) cmsItemData.fieldData[fieldMappings.body] = cleanBodyHtml;
        if (heroImageUrl && fieldMappings?.image) cmsItemData.fieldData[fieldMappings.image] = heroImageUrl;

        const headers = {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'accept-version': '2.0.0'
        };

        const response = await axios.post(
          `https://api.webflow.com/v2/sites/${siteId}/collections/${collectionId}/items`,
          cmsItemData,
          { headers }
        );

        console.log('BlogService: Blog article published successfully to Webflow');
        
        // Remove large fields for response
        const responseData = { ...(response.data as any) };
        if (responseData.fieldData) {
            delete responseData.fieldData['post-body'];
            delete responseData.fieldData['body'];
        }

        return {
          success: true,
          message: 'Blog article published successfully to Webflow',
          data: {
              title,
              slug,
              webflowResponse: responseData
          }
        };
      } else {
          return {
              success: false,
              message: `CMS Type '${cmsType}' is not currently supported for automated publishing.`,
              error: 'Unsupported CMS Type'
          }
      }

    } catch (error: any) {
      console.error('BlogService: Error publishing blog article:', error);
      return {
        success: false,
        message: 'Failed to publish blog article',
        error: error.message
      };
    }
  }

  private getSuccessMessage(deepResearch: boolean, inlineCount: number): string {
    if (deepResearch && inlineCount > 0) {
      return `✅ Blog article created with deep research and ${inlineCount} inline images!`;
    } else if (deepResearch) {
      return '✅ Blog article created with deep research!';
    }
    return '✅ Blog article created successfully!';
  }
}

// Singleton instance
export const blogService = new BlogService();
