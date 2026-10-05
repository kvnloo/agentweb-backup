/**
 * ENG-2103 (F2) — blog tool cluster, extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * createBlogArticle, publishBlogArticle, repairBlogArticle — the twelfth
 * domain-cluster extraction in this series. Four private helpers used
 * exclusively by these three (getBlogSuccessMessage, parseImagePlaceholders,
 * replaceImagePlaceholders, checkAndResizeImage) had zero other callers or
 * test spies anywhere in the backend (confirmed by whole-backend grep) and
 * move alongside them as module-local (non-exported) functions.
 *
 * All three public methods keep a one-line delegating wrapper on
 * `AgentModeService.prototype.*` rather than being deleted — each has a real
 * second caller beyond `emma/tools.ts`, found by grepping the whole backend:
 * `createBlogArticle` is also called by `mcp/server/apiTools.ts`'s
 * `create_blog_article` MCP tool; `publishBlogArticle` is also called by
 * `mcp/server/apiTools.ts`'s `publish_blog_article` MCP tool AND
 * `controllers/blog.ts`'s `publishBlogDirect` REST handler; `repairBlogArticle`
 * is also called by `routes/emmaApi.ts`'s `POST /repair-blog` route.
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` calls anywhere in this cluster (verified by
 * grepping the full original method bodies) — no design-decision exclusion
 * needed here, unlike `createHtmlFromTemplate`/`updateEmailDraftForLead`/
 * `importLeadsFromSearch`/`generateImage`. The actual content generation
 * (`generateBlogContent`, `generateBlogHtml`, `generateBlogImage`,
 * `restyleContent`) lives in `controllers/blog.ts`, already a separate file
 * outside this extraction's scope, and is reached here exactly as the
 * original code already did: via a lazy `await import('../../controllers/blog')`
 * inside the function body. Likewise `deepResearchService` (createBlogArticle's
 * deep-research branch) was already lazily imported in the original and stays
 * that way — it matters here because `deepResearchService.ts` itself has a
 * static `import { agentModeService } from './agentModeService'` at its own
 * top, so a static import of it here would drag `agentModeService.ts` back in.
 *
 * No `billingUserId`/`currentRunFunding()` handling anywhere in this cluster
 * (grepped the full original method bodies, zero matches) — none of these
 * three methods meter LLM usage themselves, so the
 * lesson-forwarding-resolved-field-suppresses-downstream-resolver bug class
 * (ENG-1816 F1 rounds 3-5) does not apply here.
 *
 * NEW transitive-import trap found and fixed during this extraction (not a
 * problem in the original file, which could afford a static import because
 * everything already lived in one file): `publishBlogArticle`'s
 * `publishWithResolvedBlogPublisher` came from a STATIC top-level import in
 * agentModeService.ts (`./blogPublishers`). `services/blogPublishers.ts`
 * itself statically imports `controllers/blog.ts` (for
 * `getWebflowConfig`/`getWordPressConfig`), and `controllers/blog.ts` has its
 * own static `import { agentModeService } from '../services/agentModeService'`
 * at its top — so keeping this a static import here would transitively load
 * `agentModeService.ts` on every import of this module, defeating the point of
 * the extraction (ENG-1816 F2 design §5.3: "the bridge can serve tools without
 * importing agentModeService"). Made lazy here; verified by
 * `blog.moduleIsolation.test.ts` and `npm run typecheck`, not assumed.
 *
 * `isPublishConsentWithdrawn` (from `utils/publishConsentWithdrawn.ts`, a leaf
 * module with no imports of its own) and `axios` stay static top-level
 * imports — neither has any transitive-import risk.
 */
import axios from 'axios';
import { isPublishConsentWithdrawn } from '../../utils/publishConsentWithdrawn';

export async function createBlogArticle(
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

    console.log('AgentMode: Creating blog article for title_draft:', titleDraft, 'length:', length, 'deepResearch:', deepResearch, 'userId:', userId, 'content_draft:', contentPreview);

    // Import restyleContent for processing the draft
    const { restyleContent } = await import('../../controllers/blog');

    let blogData: { title: string; description: string; content: string; imagePrompt: string };
    let finalContent: string;
    let inlineImagesCount = 0;

    if (deepResearch) {
      // ========================================
      // DEEP RESEARCH FLOW: Research + Restyle + Inline Images
      // ========================================
      console.log('AgentMode: Deep research enabled, performing research...');
      const { deepResearchService } = await import('../../services/deepResearchService');

      // Combine title_draft and content_draft as topic for deep research
      const researchTopic = `${titleDraft}\n\n${contentDraft}`;

      const researchResult = await deepResearchService.performDeepResearch({
        topic: researchTopic,
        prompt: requirements || undefined,
        tone: 'professional',
        style,
        userId
      });

      const researchContent = researchResult.markdownContent;
      if (!researchResult.success || !researchContent) {
        throw new Error(researchResult.error || 'Deep research failed');
      }

      console.log('AgentMode: Deep research complete. Length:', researchContent.length);
      console.log('AgentMode: Restyling research content with style:', style);

      // Restyle with inline image placeholders
      blogData = await restyleContent(
        researchContent,
        titleDraft,
        'professional',
        style,
        true, // includeInlineImages = true for deep research
        userId
      );

      if (!blogData.title || !blogData.content) {
        throw new Error("Blog content restyling failed");
      }

      // Use the generated title from blogData (not the draft)

      // Parse and generate inline images
      const placeholders = parseImagePlaceholders(blogData.content);
      console.log(`AgentMode: Found ${placeholders.length} image placeholders in content`);

      if (placeholders.length > 0) {
        console.log('AgentMode: Generating inline images...');
        const inlineImageResults = await Promise.all(
          placeholders.map(p => generateBlogImage(p.prompt, userId))
        );

        const inlineImageUrls = inlineImageResults.map(r => r.imageUrl || '');
        inlineImagesCount = inlineImageUrls.filter(u => u).length;
        console.log(`AgentMode: Generated ${inlineImagesCount} inline images successfully`);

        // Replace placeholders with actual image URLs
        finalContent = replaceImagePlaceholders(blogData.content, placeholders, inlineImageUrls);
        console.log('AgentMode: Replaced image placeholders with actual images');
      } else {
        finalContent = blogData.content;
      }
    } else {
      // ========================================
      // STANDARD FLOW: Generate content from draft
      // ========================================
      console.log('AgentMode: Generating blog content from draft with style:', style);
      blogData = await generateBlogContent(
        titleDraft,
        contentDraft,
        length,
        researchContext,
        requirements,
        style,
        userId
      );

      if (!blogData.title || !blogData.content) {
        throw new Error("Blog content generation failed");
      }

      console.log('AgentMode: Blog content ready. Title:', blogData.title);
      finalContent = blogData.content;
    }

    // ========================================
    // COMMON: Generate Hero Image
    // ========================================
    console.log('AgentMode: Generating hero image...');
    const heroResult = await generateBlogImage(blogData.imagePrompt, userId);
    if (!heroResult.imageUrl) {
      throw new Error('Hero image generation failed');
    }
    const heroImageUrl = heroResult.imageUrl;
    console.log('AgentMode: Hero image generated successfully');

    // ========================================
    // COMMON: Build HTML and Upload to S3
    // ========================================
    console.log('AgentMode: Generating HTML file with style:', style);
    const htmlContent = await generateBlogHtml(
      blogData.title,
      blogData.description,
      finalContent,
      heroImageUrl,
      style
    );
    console.log('AgentMode: Uploading HTML file to S3...');
    const htmlFilename = `blog-${Date.now()}.html`;

    const uploadResult = await uploadFileToS3(
      htmlContent,
      htmlFilename,
      userId,
      'text/html'
    );

    if (!uploadResult.success || !uploadResult.url) {
      const uploadErr: any = new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      uploadErr.status = uploadResult.statusCode;
      throw uploadErr;
    }

    const htmlUrl = uploadResult.url;
    console.log('AgentMode: HTML file uploaded successfully to:', htmlUrl);

    // Calculate word count from the content
    const wordCount = blogData.content.split(/\s+/).filter((word: string) => word.length > 0).length;

    return {
      success: true,
      message: getBlogSuccessMessage(deepResearch, inlineImagesCount),
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
    console.error('AgentMode: Error creating blog article:', error);
    return {
      success: false,
      message: 'Failed to create blog article',
      error: error.message,
      // ENG-1300: real HTTP status from the S3 upload, when the failure came
      // from there (uploadFileToS3 exposes AWS SDK v2's numeric statusCode —
      // never .code, a string error name on that SDK).
      code: error?.status
    };
  }
}

/**
 * Get success message based on options used
 */
function getBlogSuccessMessage(deepResearch: boolean, inlineCount: number): string {
  const parts = ['Blog article created successfully'];
  if (deepResearch) parts.push('with deep research');
  if (inlineCount > 0) {
    parts.push(`and ${inlineCount} inline images`);
  }
  return parts.join(' ');
}

/**
 * Parse {{IMAGE: prompt="...", caption="..."}} placeholders from content
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

export async function publishBlogArticle(
  title: string,
  description: string,
  heroImageUrl: string,
  blogHtmlUrl: string,
  userId: string,
  sessionId: string,
  status: string = 'draft',
  author?: string,
  categories: string[] = [],
  // ENG-827 (Greptile): the dispatcher checks consent before this method is entered,
  // but the very first thing it does is fetch the article HTML over the network with
  // a 30s budget. The check therefore precedes the slow part rather than the
  // irreversible one, exactly like the YouTube upload did. Callers that publish on a
  // schedule pass the hook so the decision is re-made against live consent at the
  // last reachable point instead.
  assertStillAuthorized?: () => Promise<{ error: string } | null>
): Promise<any> {
  try {
    console.log('AgentMode: Publishing blog article - Title:', title, 'Status:', status);

    // Step 1: Fetch HTML and extract body content
    const htmlResponse = await axios.get(blogHtmlUrl, {
      timeout: 30000,
      responseType: 'text',
      headers: {
        'User-Agent': 'AgentWeb-Backend/1.0',
      },
    });

    const htmlContent = htmlResponse.data as string;

    // Extract content from <div class="content"> — required for proper CMS publishing
    const contentDivStart = htmlContent.search(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>/i);
    if (contentDivStart === -1) {
      return {
        success: false,
        message: 'This article\'s HTML is not formatted for CMS publishing (missing <div class="content"> wrapper). Use repair_blog_article first to fix the formatting, then retry publish_blog_article.',
        error: 'HTML not formatted for publishing',
        requiresRepair: true,
        articleUrl: blogHtmlUrl
      };
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

    // Extract <style> blocks from the full HTML and prepend to body content
    const styleBlocks: string[] = [];
    const styleRegex = /<style[\s\S]*?<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleRegex.exec(htmlContent)) !== null) {
      styleBlocks.push(styleMatch[0]);
    }
    if (styleBlocks.length > 0) {
      bodyHtml = styleBlocks.join('\n') + '\n' + bodyHtml;
    }

    // A draft is reversible and invisible, so it is not gated — only going live is.
    if (status === 'published') {
      const withdrawnBeforeCms = await assertStillAuthorized?.();
      if (withdrawnBeforeCms) {
        console.warn('AgentMode: ENG-827 abandoning blog publish — consent was withdrawn while the article HTML was being fetched.');
        return { success: false, message: withdrawnBeforeCms.error };
      }
    }

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    // ENG-2103 F2: lazy on purpose — see the module header comment. A static
    // top-level import here would transitively drag agentModeService.ts back
    // in via services/blogPublishers.ts -> controllers/blog.ts.
    const { publishWithResolvedBlogPublisher } = await import('../../services/blogPublishers');
    return await publishWithResolvedBlogPublisher(
      {
        title,
        slug,
        summary: description,
        bodyHtml,
        heroImageUrl,
        author,
        categories,
        status: status === 'published' ? 'published' : 'draft',
        publishedAt: new Date().toISOString(),
      },
      // ENG-827: the check above guards entry to the publisher; this rides all the
      // way down to the CMS write itself, past the Payload probe, the user lookup
      // and each publisher's secrets fetch.
      { userId, sessionId, assertStillAuthorized: status === 'published' ? assertStillAuthorized : undefined }
    );
  } catch (error: any) {
    // ENG-827: a deliberate stop is not a CMS failure; reporting it as one would
    // send the run down the retry path.
    if (isPublishConsentWithdrawn(error)) {
      return { success: false, message: error.message };
    }
    console.error('AgentMode: Error publishing blog article:', error);

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

    // ENG-1300: carry the real HTTP status through when this catch is reached
    // directly (Payload CMS publish errors and the initial HTML-fetch axios
    // call) — WebflowBlogPublisher/WordPressBlogPublisher catch and return
    // their own failures below this method and never throw here.
    const code = error.response?.status;

    return {
      success: false,
      message: errorMessage,
      error: error.message || 'Unknown error',
      code,
    };
  }
}

/**
 * Repair blog article by creating a new version with optimized images
 * Takes only the article URL, finds and resizes all images, creates a new HTML file
 */
export async function repairBlogArticle(
  articleUrl: string,
  userId: string,
  sessionId: string
): Promise<any> {
  try {
    console.log('AgentMode: Repairing blog article...');
    console.log('AgentMode: Article URL:', articleUrl);

    const AWS = (await import('aws-sdk')).default;
    const s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-west-2',
    });

    const repairResults = {
      imagesRepaired: 0,
      totalImagesChecked: 0,
      originalArticleUrl: articleUrl,
      repairedArticleUrl: articleUrl,
    };

    // Step 1: Download and parse HTML
    console.log('AgentMode: Downloading HTML article...');
    const htmlResponse = await axios.get(articleUrl, {
      timeout: 30000,
      responseType: 'text',
      headers: {
        'User-Agent': 'AgentWeb-Backend/1.0',
      },
    });

    let htmlContent = htmlResponse.data as string;

    // Step 1.5: Restructure HTML if missing <div class="content"> wrapper
    // This ensures the article is compatible with publishBlogArticle extraction
    let structureRepaired = false;
    const hasContentDiv = /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>/i.test(htmlContent);
    if (!hasContentDiv) {
      console.log('AgentMode: HTML missing <div class="content"> wrapper, restructuring...');
      const bodyStartMatch = htmlContent.match(/<body[^>]*>/i);
      const bodyEndIndex = htmlContent.lastIndexOf('</body>');
      if (bodyStartMatch && bodyEndIndex !== -1) {
        const bodyStartIndex = bodyStartMatch.index! + bodyStartMatch[0].length;
        let bodyContent = htmlContent.substring(bodyStartIndex, bodyEndIndex).trim();

        // Strip <script> tags
        bodyContent = bodyContent.replace(/<script[\s\S]*?<\/script>/gi, '').trim();

        // Split body into header chrome (h1, meta, hero image) and article content.
        // Strategy: find the hero image — everything up to and including it is header;
        // everything after is content. If no hero image, split at the first <h2> or
        // first content block after the h1.
        let headerChrome = '';
        let articleContent = bodyContent;

        // Try splitting at hero image (img with class="hero-image" or first standalone img)
        const heroImgPattern = /<img[^>]*class=["'][^"']*hero-image[^"']*["'][^>]*\/?>/i;
        let heroMatch = bodyContent.match(heroImgPattern);
        if (!heroMatch) {
          // Fall back to first <img> that appears before any <h2>/<p> content
          const firstH2 = bodyContent.search(/<h2[\s>]/i);
          const firstImg = bodyContent.match(/<img[^>]*\/?>/i);
          if (firstImg && (firstH2 === -1 || firstImg.index! < firstH2)) {
            heroMatch = firstImg;
          }
        }

        if (heroMatch) {
          const splitPoint = heroMatch.index! + heroMatch[0].length;
          headerChrome = bodyContent.substring(0, splitPoint).trim();
          articleContent = bodyContent.substring(splitPoint).trim();
        } else {
          // No hero image — split at first <h2> (everything before is header)
          const firstH2Index = bodyContent.search(/<h2[\s>]/i);
          if (firstH2Index > 0) {
            headerChrome = bodyContent.substring(0, firstH2Index).trim();
            articleContent = bodyContent.substring(firstH2Index).trim();
          }
          // If no h2 either, just wrap everything in content div (headerChrome stays empty)
        }

        // Rebuild body: header chrome outside div.content, article inside
        const newBody = [
          headerChrome,
          `<div class="content">`,
          `    ${articleContent}`,
          `</div>`
        ].filter(Boolean).join('\n    ');

        htmlContent = htmlContent.substring(0, bodyStartIndex) + '\n    ' + newBody + '\n' + htmlContent.substring(bodyEndIndex);
        structureRepaired = true;
        console.log('AgentMode: HTML restructured with <div class="content"> wrapper');
      }
    }

    // Step 2: Find all images in HTML
    console.log('AgentMode: Looking for all images in HTML...');
    const allImages = new Set<string>();

    // Find all images with class="hero-image" - need to handle both src before/after class
    const heroImageRegex1 = /<img[^>]+class="[^"]*hero-image[^"]*"[^>]+src="([^"]+)"[^>]*>/gi;
    const heroImageRegex2 = /<img[^>]+src="([^"]+)"[^>]+class="[^"]*hero-image[^"]*"[^>]*>/gi;

    let match;
    while ((match = heroImageRegex1.exec(htmlContent)) !== null) {
      const imgUrl = match[1];
      if (imgUrl.includes('agentweb-user-files.s3')) {
        allImages.add(imgUrl);
        console.log(`AgentMode: Found hero image with class="hero-image": ${imgUrl}`);
      }
    }

    while ((match = heroImageRegex2.exec(htmlContent)) !== null) {
      const imgUrl = match[1];
      if (imgUrl.includes('agentweb-user-files.s3')) {
        allImages.add(imgUrl);
        console.log(`AgentMode: Found hero image with class="hero-image": ${imgUrl}`);
      }
    }

    // Also check for images in meta tags (og:image, twitter:image)
    const ogImageMatch = htmlContent.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"[^>]*>/i);
    if (ogImageMatch && ogImageMatch[1].includes('agentweb-user-files.s3')) {
      allImages.add(ogImageMatch[1]);
    }

    const twitterImageMatch = htmlContent.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"[^>]*>/i);
    if (twitterImageMatch && twitterImageMatch[1].includes('agentweb-user-files.s3')) {
      allImages.add(twitterImageMatch[1]);
    }

    // Find all other images in <img> tags
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    while ((match = imgRegex.exec(htmlContent)) !== null) {
      const imgUrl = match[1];
      if (imgUrl.includes('agentweb-user-files.s3')) {
        allImages.add(imgUrl);
      }
    }

    const imagesToCheck = Array.from(allImages);
    repairResults.totalImagesChecked = imagesToCheck.length;
    console.log(`AgentMode: Found ${imagesToCheck.length} images to check`);

    // Step 3: Check and resize each image if needed
    for (const imgUrl of imagesToCheck) {
      try {
        console.log(`AgentMode: Checking image: ${imgUrl}`);
        const imgResult = await checkAndResizeImage(imgUrl, userId);
        if (imgResult.resized) {
          // Replace all occurrences of this URL in HTML
          const escapedUrl = imgUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          htmlContent = htmlContent.replace(new RegExp(escapedUrl, 'g'), imgResult.url);
          repairResults.imagesRepaired++;
          console.log(`AgentMode: Image repaired. Size reduced from ${(imgResult.originalSize / 1024 / 1024).toFixed(2)}MB to ${(imgResult.newSize! / 1024 / 1024).toFixed(2)}MB`);
        } else {
          console.log(`AgentMode: Image OK (${(imgResult.originalSize / 1024 / 1024).toFixed(2)}MB)`);
        }
      } catch (imgError) {
        console.warn(`AgentMode: Failed to check/repair image ${imgUrl}:`, imgError);
        // Continue with other images
      }
    }

    // Step 4: Upload repaired HTML as a new file (always create new version, even if no changes)
    console.log('AgentMode: Creating repaired article...');
    const timestamp = Date.now();
    const htmlKey = `users/${userId}/files/${timestamp}/blog-${timestamp}-repaired.html`;

    await s3.putObject({
      Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
      Key: htmlKey,
      Body: htmlContent,
      ContentType: 'text/html',
    }).promise();

    repairResults.repairedArticleUrl = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${htmlKey}`;
    console.log('AgentMode: Repaired article uploaded:', repairResults.repairedArticleUrl);

    // Step 6: Extract hero image URL from repaired HTML for convenience
    let heroImageUrl = '';

    // Try to find hero image with class="hero-image" (both attribute orders)
    const heroMatch1 = htmlContent.match(/<img[^>]+class="[^"]*hero-image[^"]*"[^>]+src="([^"]+)"[^>]*>/i);
    const heroMatch2 = htmlContent.match(/<img[^>]+src="([^"]+)"[^>]+class="[^"]*hero-image[^"]*"[^>]*>/i);

    if (heroMatch1) {
      heroImageUrl = heroMatch1[1];
    } else if (heroMatch2) {
      heroImageUrl = heroMatch2[1];
    } else {
      // Fallback to og:image meta tag
      const ogImageMatchFinal = htmlContent.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"[^>]*>/i);
      if (ogImageMatchFinal) {
        heroImageUrl = ogImageMatchFinal[1];
      }
    }

    // Step 5: Return repair results
    const messageParts: string[] = [];
    if (structureRepaired) {
      messageParts.push('HTML restructured for CMS publishing (added <div class="content"> wrapper)');
    }
    if (repairResults.imagesRepaired > 0) {
      messageParts.push(`Fixed ${repairResults.imagesRepaired} of ${repairResults.totalImagesChecked} image(s) by resizing to meet file size limits`);
    } else {
      messageParts.push(`All ${repairResults.totalImagesChecked} image(s) are within limits`);
    }
    const message = `Blog article repaired successfully. ${messageParts.join('. ')}. Use the repaired article URL to publish.`;

    return {
      success: true,
      message,
      repairedArticleUrl: repairResults.repairedArticleUrl,
      heroImageUrl: heroImageUrl,
      imagesRepaired: repairResults.imagesRepaired,
      totalImagesChecked: repairResults.totalImagesChecked,
      originalArticleUrl: repairResults.originalArticleUrl,
      structureRepaired,
    };
  } catch (error: any) {
    console.error('AgentMode: Error repairing blog article:', error);
    return {
      success: false,
      message: `Failed to repair blog article: ${error.message}`,
      error: error.message || 'Unknown error'
    };
  }
}

/**
 * Check image size and resize if needed for Webflow compatibility
 * Webflow has a 4MB file size limit for images
 */
async function checkAndResizeImage(
  imageUrl: string,
  userId: string
): Promise<{ url: string; resized: boolean; originalSize: number; newSize?: number }> {
  const sharp = (await import('sharp')).default;
  const AWS = (await import('aws-sdk')).default;

  // Configure S3
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-west-2',
  });

  // Webflow's image size limit (4MB)
  const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB in bytes

  try {
    // Download image from S3
    console.log('AgentMode: Downloading image from S3:', imageUrl);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const imageBuffer = Buffer.from(imageResponse.data as ArrayBuffer);
    const originalSize = imageBuffer.length;

    console.log(`AgentMode: Original image size: ${originalSize} bytes (${(originalSize / 1024 / 1024).toFixed(2)} MB)`);

    // If image is within size limit, return original URL
    if (originalSize <= MAX_FILE_SIZE) {
      return { url: imageUrl, resized: false, originalSize };
    }

    // Image is too large, resize it
    console.log('AgentMode: Image exceeds 4MB limit, resizing...');

    // Resize image to reduce file size
    // Start with 80% quality and adjust if needed
    let resizedBuffer: Buffer;
    let quality = 80;
    let width = 1920; // Max width for blog images

    do {
      const sharpInstance = sharp(imageBuffer).resize(width, null, {
        fit: 'inside',
        withoutEnlargement: true,
      });

      // Apply format-specific compression
      const metadata = await sharp(imageBuffer).metadata();
      if (metadata.format === 'png') {
        resizedBuffer = await sharpInstance.png({ quality, compressionLevel: 9 }).toBuffer();
      } else if (metadata.format === 'webp') {
        resizedBuffer = await sharpInstance.webp({ quality }).toBuffer();
      } else {
        // Default to JPEG for other formats
        resizedBuffer = await sharpInstance.jpeg({ quality }).toBuffer();
      }

      console.log(`AgentMode: Resized to ${width}px width, quality ${quality}, size: ${resizedBuffer.length} bytes`);

      // If still too large, reduce quality further
      if (resizedBuffer.length > MAX_FILE_SIZE && quality > 50) {
        quality -= 10;
      } else if (resizedBuffer.length > MAX_FILE_SIZE && width > 1280) {
        width = 1280;
        quality = 80;
      } else {
        break;
      }
    } while (resizedBuffer.length > MAX_FILE_SIZE && (quality >= 50 || width >= 1280));

    // Generate new filename
    const timestamp = Date.now();
    const originalFilename = imageUrl.split('/').pop() || 'resized-image.jpg';
    const extension = originalFilename.split('.').pop();
    const filenameWithoutExt = originalFilename.replace(`.${extension}`, '');
    const newFilename = `${filenameWithoutExt}-resized-${timestamp}.${extension}`;

    // Upload resized image to S3
    const s3Key = `users/${userId}/files/${timestamp}/${newFilename}`;
    console.log('AgentMode: Uploading resized image to S3:', s3Key);

    await s3.putObject({
      Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
      Key: s3Key,
      Body: resizedBuffer,
      ContentType: `image/${extension}`,
    }).promise();

    const newImageUrl = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${s3Key}`;

    console.log(`AgentMode: Resized image uploaded successfully. New size: ${resizedBuffer.length} bytes (${(resizedBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    return {
      url: newImageUrl,
      resized: true,
      originalSize,
      newSize: resizedBuffer.length,
    };
  } catch (error) {
    console.error('AgentMode: Error resizing image:', error);
    throw error;
  }
}
