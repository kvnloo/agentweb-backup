import { Request, Response } from "express";
import { imageService } from "../services/imageGeneration";
import { getSecret } from '../utils/secretsManager';
import { getGeminiClient } from '../utils/llmClients';
import { CONTENT_RESTYLE_MODEL } from '../config';
import axios from "axios";
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
// remark and its plugins are ES modules, will be imported dynamically

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

// Initialize AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "us-east-1",
});

// Function to get BaseHub configuration from Secrets Manager
export async function getBaseHubConfig(userId?: string): Promise<{
  apiUrl: string;
  token: string;
  postsCollectionId: string;
  imageComponentId: string;
}> {
  // Check AW-Settings for user-configured Basehub credentials first
  if (userId) {
    try {
      const { settingsService } = await import('../services/settingsService');
      const setting = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
      if (setting) {
        const userConfig = JSON.parse(setting.settingValue);
        if (userConfig.token && userConfig.postsCollectionId) {
          return {
            apiUrl: userConfig.apiUrl || 'https://api.basehub.com/graphql',
            token: userConfig.token,
            postsCollectionId: userConfig.postsCollectionId,
            imageComponentId: userConfig.imageComponentId || "AAzuzbz0jSbfwGJYvtMu3",
          };
        }
      }
    } catch (settingsError) {
      console.log(`No AW-Settings Basehub config for user ${userId}, falling back to Secrets Manager`);
    }
  }

  try {
    const secretName = process.env.NODE_ENV === "development"
      ? "dev/AgentWeb/BaseHub"
      : "prod/AgentWeb/BaseHub";

    const { getSecret } = await import("../utils/secretsManager");
    const configJson = await getSecret(secretName);

    const config = JSON.parse(configJson);

    if (!config.apiUrl || !config.token || !config.postsCollectionId) {
      throw new Error("BaseHub configuration missing required fields");
    }

    return {
      apiUrl: config.apiUrl,
      token: config.token,
      postsCollectionId: config.postsCollectionId,
      imageComponentId: config.imageComponentId || "AAzuzbz0jSbfwGJYvtMu3"
    };
  } catch (error) {
    console.error("Error fetching BaseHub configuration from Secrets Manager:", error);
    throw new Error("Failed to fetch BaseHub configuration from Secrets Manager");
  }
}

// Function to get Webflow configuration from Secrets Manager
// Supports per-user secrets when userId is provided:
// - Per-user secret: dev/AgentWeb/Webflow/<userId> or prod/AgentWeb/Webflow/<userId>
// If the per-user secret does not exist, falls back to the global secret:
// - Global secret:   dev/AgentWeb/Webflow or prod/AgentWeb/Webflow
export async function getWebflowConfig(userId?: string): Promise<{
  apiToken: string;
  siteId: string;
  collectionId: string;
  fieldMappings?: {
    summary?: string;
    body?: string;
    image?: string;
    publishDate?: string;
    author?: string;
    category?: string;
  };
  categories?: Record<string, string>;
}> {
  try {
    console.log('getWebflowConfig called with userId:', userId);

    const baseSecretName = process.env.NODE_ENV === "development" 
      ? "dev/AgentWeb/Webflow" 
      : "prod/AgentWeb/Webflow";

    const { getSecret, secretExists } = await import("../utils/secretsManager");
    let configJson: string;

    // When a userId is provided, prefer a per-user secret; if it doesn't exist, fall back to global
    if (userId) {
      const userSecretName = `${baseSecretName}/${userId}`;
      const hasUserSecret = await secretExists(userSecretName);
      if (hasUserSecret) {
        configJson = await getSecret(userSecretName);
        console.log(`Using per-user Webflow config from Secrets Manager: ${userSecretName}`);
      } else {
        // Try AW-Settings before falling back to global Secrets Manager
        try {
          const { settingsService } = await import('../services/settingsService');
          const setting = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
          if (setting) {
            const settingsConfig = JSON.parse(setting.settingValue);
            if (settingsConfig.apiToken && settingsConfig.siteId && settingsConfig.collectionId) {
              console.log(`Using Webflow config from AW-Settings for user ${userId}`);
              configJson = setting.settingValue;
            } else {
              configJson = await getSecret(baseSecretName);
            }
          } else {
            configJson = await getSecret(baseSecretName);
          }
        } catch (settingsError) {
          console.log(`AW-Settings lookup failed for user ${userId}, using global secret`);
          configJson = await getSecret(baseSecretName);
        }
      }
    } else {
      console.log(
        `No user ID provided, using global secret ${baseSecretName}`,
      );
      configJson = await getSecret(baseSecretName);
    }

    const config = JSON.parse(configJson);

    if (!config.apiToken || !config.siteId || !config.collectionId) {
      throw new Error("Webflow configuration missing required fields");
    }
    
    // Handle fieldMappings - it might be a string (JSON) or an object
    let fieldMappings = config.fieldMappings;
    if (typeof fieldMappings === 'string') {
      try {
        fieldMappings = JSON.parse(fieldMappings);
      } catch (parseError) {
        console.warn('Failed to parse fieldMappings as JSON string, using defaults:', parseError);
        fieldMappings = undefined;
      }
    }

    // Handle categories mapping - it might be a string (JSON) or an object
    let categories = config.categories;
    if (typeof categories === 'string') {
      try {
        categories = JSON.parse(categories);
      } catch (parseError) {
        console.warn('Failed to parse categories as JSON string:', parseError);
        categories = undefined;
      }
    }

    return {
      apiToken: config.apiToken,
      siteId: config.siteId,
      collectionId: config.collectionId,
      fieldMappings: fieldMappings || {
        summary: "post-summary",
        body: "post-body",
        image: "main-image",
        publishDate: undefined, // Optional - only include if field exists in collection
      },
      categories: categories || undefined
    };
  } catch (error: any) {
    // IMPORTANT: use console.log so it shows up in the same stream as other logs
    console.log("Error fetching Webflow configuration from Secrets Manager:", error);
    const details =
      (error && (error.code || error.message)) ||
      (typeof error === "string" ? error : JSON.stringify(error));
    throw new Error(
      `Failed to fetch Webflow configuration from Secrets Manager: ${details}`,
    );
  }
}

// Function to get WordPress configuration from Secrets Manager
// Supports per-user secrets when userId is provided:
// - Per-user secret: dev/AgentWeb/WordPress/<userId> or prod/AgentWeb/WordPress/<userId>
// If the per-user secret does not exist, falls back to the global secret:
// - Global secret:   dev/AgentWeb/WordPress or prod/AgentWeb/WordPress
export async function getWordPressConfig(userId?: string): Promise<{
  siteUrl: string;
  username: string;
  applicationPassword: string;
  categories?: Record<string, number>; // category name -> WordPress category ID
}> {
  try {
    const baseSecretName = process.env.NODE_ENV === "development"
      ? "dev/AgentWeb/WordPress"
      : "prod/AgentWeb/WordPress";

    const { getSecret, secretExists } = await import("../utils/secretsManager");
    let configJson: string;

    if (userId) {
      const userSecretName = `${baseSecretName}/${userId}`;
      const hasUserSecret = await secretExists(userSecretName);
      if (hasUserSecret) {
        configJson = await getSecret(userSecretName);
        console.log(`Using per-user WordPress config from Secrets Manager: ${userSecretName}`);
      } else {
        // Try AW-Settings before falling back to global Secrets Manager
        try {
          const { settingsService } = await import('../services/settingsService');
          const setting = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
          if (setting) {
            const settingsConfig = JSON.parse(setting.settingValue);
            if (settingsConfig.siteUrl && settingsConfig.username && settingsConfig.applicationPassword) {
              console.log(`Using WordPress config from AW-Settings for user ${userId}`);
              configJson = setting.settingValue;
            } else {
              configJson = await getSecret(baseSecretName);
            }
          } else {
            configJson = await getSecret(baseSecretName);
          }
        } catch (settingsError) {
          console.log(`AW-Settings lookup failed for user ${userId}, using global secret`);
          configJson = await getSecret(baseSecretName);
        }
      }
    } else {
      console.log(`No user ID provided, using global secret ${baseSecretName}`);
      configJson = await getSecret(baseSecretName);
    }

    const config = JSON.parse(configJson);

    if (!config.siteUrl || !config.username || !config.applicationPassword) {
      throw new Error("WordPress configuration missing required fields (siteUrl, username, applicationPassword)");
    }

    // Handle categories mapping - it might be a string (JSON) or an object
    let categories = config.categories;
    if (typeof categories === 'string') {
      try {
        categories = JSON.parse(categories);
      } catch (parseError) {
        console.warn('Failed to parse WordPress categories as JSON string:', parseError);
        categories = undefined;
      }
    }

    return {
      siteUrl: config.siteUrl.replace(/\/+$/, ''), // strip trailing slashes
      username: config.username,
      applicationPassword: config.applicationPassword,
      categories: categories || undefined,
    };
  } catch (error: any) {
    console.log("Error fetching WordPress configuration from Secrets Manager:", error);
    const details =
      (error && (error.code || error.message)) ||
      (typeof error === "string" ? error : JSON.stringify(error));
    throw new Error(
      `Failed to fetch WordPress configuration from Secrets Manager: ${details}`,
    );
  }
}

// Author IDs from your BaseHub setup
const AUTHORS = {
  HARSH: "B7hR0AMxxh8HyBOLRKfiU",
  RUI: "OVx_pLwKj00xoAf6kXSSf",
  FANGFANG: "Vxo_NPdrUf0Yzob_Im3_d",
  MATTHEW: "UM7cOq3RuKX9OPKqYRt-2",
};

interface BlogPostData {
  title: string;
  description: string;
  content: string;
  imageFilename: string;
  imagePrompt: string;
}

// Utility function to generate blog content (extracted from generateBlogPost)
export async function generateBlogContent(
  titleDraft: string,
  contentDraft: string,
  length: string = "medium",
  researchContext: string = "",
  requirements: string = "",
  style: string = "default"
): Promise<{
  title: string;
  description: string;
  content: string;
  imagePrompt: string;
}> {
  // Map desired length to a concrete target word count
  const targetWordCounts: Record<string, number> = { short: 600, medium: 1000, long: 3000 };
  const targetWords = targetWordCounts[length] ?? 1000;
  const isLongForm = length === 'medium' || length === 'long';
  
  // Check if requirements specify a different word count and adjust
  let finalTargetWords = targetWords;
  if (requirements) {
    const wordCountMatch = requirements.match(/(\d+)\+?\s*words?/i);
    if (wordCountMatch) {
      const specifiedWords = parseInt(wordCountMatch[1], 10);
      if (specifiedWords > targetWords) {
        finalTargetWords = specifiedWords;
        console.log(`Adjusted target word count from ${targetWords} to ${finalTargetWords} based on requirements`);
      }
    }
  }
  
  // Calculate maxTokens based on target word count (1 word ≈ 1.4 tokens, plus buffer for prompt)
  // Add extra buffer to ensure we can generate the full content
  // For long articles, we need significantly more tokens
  const maxTokensMap: Record<string, number> = { 
    short: 2000,   // 600 words * 1.4 ≈ 840 tokens + buffer
    medium: 3500,  // 1000 words * 1.4 ≈ 1400 tokens + buffer
    long: 8000     // 3000 words * 1.4 ≈ 4200 tokens + large buffer for comprehensive content
  };
  // If requirements specify higher word count, increase maxTokens proportionally
  let maxTokens = maxTokensMap[length] ?? 3500;
  if (finalTargetWords > targetWords) {
    maxTokens = Math.ceil((finalTargetWords / targetWords) * maxTokens);
    console.log(`Adjusted maxTokens from ${maxTokensMap[length]} to ${maxTokens} for ${finalTargetWords} words`);
  }

  // Substack-style writing guidelines
  const substackGuidelines = style === 'substack' ? `

Substack-Style Writing Guidelines:
- Write in a personal, newsletter-like tone - as if you're writing directly to your subscribers
- Use first-person perspective ("I", "we", "my experience") to make it personal and relatable
- Start with an engaging hook - a question, story, or surprising insight that draws readers in
- Be conversational and approachable - write like you're talking to a friend, not giving a formal presentation
- Include personal anecdotes, observations, or experiences when relevant
- Address the reader directly ("you", "your") to create connection
- Use rhetorical questions to engage readers and make them think
- Break up content with clear, friendly section headers that feel like natural conversation points
- End with a clear takeaway or call-to-action that feels personal, not salesy
- Avoid overly corporate or formal language - be authentic and genuine
- Use shorter paragraphs and sentences for better readability
- Include transitions that feel natural, like "Here's what I've learned..." or "Let me share..."` : '';

  // Blog prompt for refining/polishing the draft content
  let blogPrompt = `You are an expert marketing strategist and content writer. Refine and polish this draft blog article into a high-quality, engaging blog post.

DRAFT TITLE:
${titleDraft}

DRAFT CONTENT:
${contentDraft}

Requirements:
- Target length: approximately ${finalTargetWords} words (±10%). CRITICAL: The content must be comprehensive and meet this word count. Do not stop early.
- Refine the title to be compelling and SEO-optimized
- Polish the content to be publication-ready while preserving the core message and key points
${substackGuidelines}

Content Guidelines:
1. Write in a natural, human voice - avoid AI-generated patterns
2. Use practical examples and actionable insights
3. Structure with clear H2 and H3 headings (no H4+)
4. If research context is provided, use it to enhance the content but maintain the draft's core message
5. Avoid generic AI language - be specific, use real examples, and sound like a human expert
6. Do NOT include the title as an H1 heading in the content - the title will be added separately
7. Use tables, bullet points, numbered lists, or paragraphs for data presentation${isLongForm ? `
8. For ${length} articles, focus on clear, well-structured content:
    - Create markdown tables for structured data when it adds value
    - Use bullet points, numbered lists, and clear headings for organization
    - Avoid ASCII art, diagrams, or complex visual elements
    - Focus on readable, professional content that provides real value` : ''}

Format the response as JSON with this structure:
{{
  "title": "Compelling, SEO-optimized title (refined from draft)",
  "description": "1-2 sentence meta description for SEO",
  "content": "Full blog content in markdown format (polished from draft)",
  "imagePrompt": "Detailed visual description for hero image (avoid text, be conceptual)"
}}`;

  // Add custom requirements if provided
  if (requirements) {
    blogPrompt += `

Additional Requirements:
${requirements}`;
  }

  // Add research context if provided
  if (researchContext) {
    blogPrompt += `

Research Context (use to enhance the draft content):
${researchContext}`;
  }

  // Get content model from settings, but don't block content generation if settings are unavailable
  let contentModel: string | undefined;
  try {
    const { settingsService } = await import('../services/settingsService');
    try {
      const setting = await settingsService.getSetting('agent_mode_content_model');
      if (setting && setting.settingValue) {
        contentModel = setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting content model setting:', error);
    }
  } catch (error) {
    console.error('Error loading settings service:', error);
  }

  try {

    // Use LangChain LLM service with dynamic maxTokens based on article length
    const { createLLMService } = await import('../utils/llmService');
    const modelName = contentModel || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
    console.log(`[generateBlogContent] Using model: ${modelName}, output format: JSON`);
    const llmService = createLLMService(modelName, 0.8, maxTokens);
    
    const systemPrompt = `You are a seasoned marketing strategist and content writer. Write naturally, avoid AI patterns, and focus on providing real value to startup founders. Never create tables - use bullet points, numbered lists, or paragraphs instead. Always respond with valid JSON. 

CRITICAL REQUIREMENT: The article content must be approximately ${finalTargetWords} words in length. This is a hard requirement. The content field in your JSON response must contain at least ${Math.floor(finalTargetWords * 0.9)} words. Write comprehensive, detailed content with multiple sections, examples, and actionable insights to meet this word count. Do not stop writing until you have reached the target word count.`;
    
    // Generate JSON content using LangChain
    const blogData = await llmService.generateJSONContent<{
      title: string;
      description: string;
      content: string;
      imagePrompt: string;
    }>(systemPrompt, blogPrompt, 'json', undefined, { feature: 'content_gen' });

    // Validate the response structure
    if (!blogData.title || !blogData.content) {
      throw new Error("LLM response missing required fields (title, content)");
    }

    // Validate word count
    const actualWordCount = blogData.content.split(/\s+/).filter((word: string) => word.length > 0).length;
    const minExpectedWords = Math.floor(finalTargetWords * 0.9);
    
    if (actualWordCount < minExpectedWords) {
      console.warn(`⚠️ Generated article has only ${actualWordCount} words, but target was ${finalTargetWords} words (minimum: ${minExpectedWords} words). The content may have been truncated.`);
      // Still return the data, but log the warning
    } else {
      console.log(`✅ Generated article has ${actualWordCount} words (target: ${finalTargetWords} words)`);
    }

    return blogData;
  } catch (llmError: any) {
    // Fallback to use the draft content if LLM fails
    console.error('Error generating blog content:', llmError);
    return {
      title: titleDraft || 'Blog Article',
      description: `A comprehensive blog article covering key strategies and practical implementation tips.`,
      content: contentDraft || '# Blog Article\n\nContent goes here.',
      imagePrompt: `Professional illustration for an article titled "${titleDraft || 'Blog Article'}". Modern, clean design with relevant visual elements. No text, conceptual representation.`,
    };
  }
}

/**
 * Restyle existing content (e.g., from deep research) in specified tone and style
 * Unlike generateBlogContent, this doesn't generate new content - just adjusts tone/style
 */
export async function restyleContent(
  originalContent: string,
  topic: string,
  tone: string = "professional",
  style: string = "default",
  includeInlineImages: boolean = false
): Promise<{
  title: string;
  description: string;
  content: string;
  imagePrompt: string;
  inlineImageCount?: number;
}> {
  // Substack-style writing guidelines
  const substackGuidelines = style === 'substack' ? `
SUBSTACK STYLE:
- Write in first-person perspective ("I", "we", "my experience")
- Be conversational and approachable, like talking to a smart friend
- Include personal transitions like "Here's what I've learned..." or "Let me share..."
- Use shorter paragraphs for better readability
- Add rhetorical questions to engage the reader` : '';

  // Inline image placeholder instructions
  const inlineImageGuidelines = includeInlineImages ? `

IMAGE PLACEHOLDERS:
- Add 2-5 {{IMAGE: prompt="...", caption="..."}} placeholders throughout (choose based on content length and sections)
- Place them after key sections that would benefit from visual illustration
- Each should have a detailed prompt (describe style, colors, composition) and brief caption
- Do NOT place a placeholder at the very beginning (hero image is separate)` : '';

  const prompt = `You are a SENIOR CONTENT EDITOR at a top-tier publication like The Atlantic or Wired. Transform this research into a polished, publication-ready blog article.

ORIGINAL RESEARCH:
${originalContent}

═══════════════════════════════════════════════════
CRITICAL QUALITY RULES (MUST FOLLOW):
═══════════════════════════════════════════════════

1. NO PLACEHOLDER TEXT
   ❌ NEVER include: [Your Name], [Organization], [Source], [Year], [Insert X here], etc.
   ✅ Either use real information from the research or omit the placeholder entirely.
   ✅ For bylines, use "Staff Writer" or omit - do NOT leave brackets.

2. CLEAN UP ACADEMIC MARKERS, BUT PRESERVE INLINE SOURCE ATTRIBUTIONS FOR FIGURES
   ❌ Remove bare academic markers: numbered footnotes like [1]/[12], trailing bibliography/"References" sections, orphaned "[Source]" placeholders
   ✅ KEEP inline source attributions that sit next to a quoted number, statistic, or data point — e.g. a parenthetical like "(Gartner, 2025)" or a linked source right after the figure it backs. Do NOT strip these; they let readers trace each figure to its origin.
   ✅ Preserve the inline-citation style of the research (source adjacent to the claim), matching Claude/Gemini outputs
   ❌ Do NOT relocate these inline citations into a separate references section at the end

3. USE ONLY FACTS FROM THE RESEARCH (NO HALLUCINATION)
   ❌ NEVER invent company names, statistics, or examples not in the research
   ❌ WRONG: "Leading companies are adopting this technology..."
   ✅ RIGHT: Name specific companies, products, or people ONLY if mentioned in the research
   ✅ If research lacks specifics, write generally: "Organizations in this space typically..."

4. ENGAGING INTRODUCTION (THE HOOK)
   ✅ Start with one of these hooks using ONLY facts from the research:
      - A striking statistic from the research
      - A provocative question that challenges assumptions about ${topic}
      - A bold statement based on research findings
   ❌ Do NOT fabricate scenarios or statistics not in the research
   ✅ The intro should be 3-5 sentences minimum, not a single line

5. WRITE LIKE A HUMAN (ANTI-AI PATTERNS)
   ✅ Write in a natural, human voice - avoid robotic AI-generated patterns
   ✅ Be specific using real examples FROM THE RESEARCH
   ✅ Sound like a human expert, not a language model
   ❌ Avoid overused AI phrases: "dive into", "landscape", "it's important to note", "in conclusion", "in today's world", "game-changer"

6. STRUCTURE AND FORMATTING
   ✅ Use clear H2 (##) and H3 (###) headings to organize content
   ✅ Do NOT include the title as an H1 heading - it will be added separately
   ✅ Use markdown tables for comparative data when it adds value
   ✅ Use bullet points and numbered lists for better readability
   ✅ Keep paragraphs short (3-4 sentences max)

7. LENGTH AND CONTENT PRESERVATION
   ✅ Maintain similar length to the original research (do NOT summarize aggressively)
   ✅ Preserve ALL key facts, data points, and insights from the research
   ✅ This is a RESTYLE, not a summary - keep the depth and detail

8. PROFESSIONAL POLISH
   ✅ Tone: ${tone}
   ✅ Include practical, actionable insights - not just theory
   ✅ Vary sentence length (mix short punchy with longer explanatory)
   ✅ Use transition phrases ("Here's where it gets interesting...", "But there's a catch...")
   ✅ End with a forward-looking conclusion or call-to-action

${substackGuidelines}
${inlineImageGuidelines}

═══════════════════════════════════════════════════
OUTPUT FORMAT (STRICT JSON):
═══════════════════════════════════════════════════
{
  "title": "Compelling, SEO-optimized title (avoid generic titles like 'The Future of X')",
  "description": "1-2 sentence meta description for SEO and social sharing",
  "content": "Full blog article in markdown format. Must follow ALL rules above.${includeInlineImages ? ' Include {{IMAGE:...}} placeholders.' : ''}",
  "imagePrompt": "Detailed hero image prompt: describe the scene, style (photorealistic/illustration/3D), mood, colors, composition. No text in image."${includeInlineImages ? ',\n  "inlineImageCount": "<number of {{IMAGE:...}} placeholders you added (2-5)>"' : ''}
}`;

  try {
    // Get Gemini API key from secrets manager
    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const secretName = `${environment}/AgentWeb/GeminiAPIKey`;
    const apiKey = await getSecret(secretName);
    
    // Metered Gemini client (Ship 1 shadow metering). restyleContent is a
    // utility with no user in scope, so usage attributes to "system".
    const ai = await getGeminiClient({ feature: 'content_gen' }, apiKey);

    const systemInstruction = "You are an expert content editor. Restyle content while preserving key information. Always respond with valid JSON only, no markdown code blocks.";
    
    const response = await ai.models.generateContent({
      model: CONTENT_RESTYLE_MODEL,
      contents: prompt,
      config: {
        systemInstruction,
        temperature: 0.7,
      },
    });

    const responseContent = response.text || '';
    if (!responseContent) {
      throw new Error("No content generated from LLM");
    }

    // Parse the JSON response
    let result;
    try {
      const cleanedContent = responseContent.replace(/```json\s*|\s*```/g, "").trim();
      result = JSON.parse(cleanedContent);
    } catch (parseError) {
      // Fallback: use original content with minor cleanup
      const firstLine = originalContent.split('\n')[0];
      const title = firstLine.replace(/^#\s*/, '').trim() || `Insights on ${topic}`;
      
      result = {
        title,
        description: `Comprehensive research on ${topic}`,
        content: originalContent,
        imagePrompt: `Professional illustration for an article about ${topic}. Modern, clean design.`,
      };
    }

    return result;
  } catch (error: any) {
    console.error('Error restyling content:', error);
    
    // Fallback: return original content
    const firstLine = originalContent.split('\n')[0];
    const title = firstLine.replace(/^#\s*/, '').trim() || `Research on ${topic}`;
    
    return {
      title,
      description: `Comprehensive research on ${topic}`,
      content: originalContent,
      imagePrompt: `Professional illustration for ${topic}. Clean, modern design.`,
    };
  }
}

// Utility function to generate blog image (extracted from generateImage)
export async function generateBlogImage(
  prompt: string,
  userId: string,
  filename?: string
): Promise<{
  imageUrl: string;
  filename: string;
}> {
  const isImageServiceAvailable = await imageService.isAvailable();

  if (!isImageServiceAvailable) {
    throw new Error("Image generation service not available. Please check API key configuration in AWS Secrets Manager.");
  }

  const result = await imageService.generateImage({
    prompt: prompt,
    size: "1536x1024",
    quality: "low",
    filename: filename || `blog-hero-${Date.now()}.png`,
    userId: userId,
    inputImages: []
  });

  if (result.success && result.imageUrl) {
    return {
      imageUrl: result.imageUrl,
      filename: result.filename || filename || `blog-hero-${Date.now()}.png`
    };
  } else {
    throw new Error(result.error || 'Image generation failed');
  }
}



// Utility function to generate HTML from blog content
export async function generateBlogHtml(
  title: string,
  description: string,
  content: string,
  imageUrl: string,
  style: string = 'default'
): Promise<string> {
  // Convert markdown content to HTML using remark with enhanced plugins
  // Use dynamic import for ES modules
  const { remark } = await import('remark');
  const remarkHtml = (await import('remark-html')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const remarkBreaks = (await import('remark-breaks')).default;
  
  const processor = remark()
    .use(remarkGfm) // GitHub Flavored Markdown support (tables, strikethrough, etc.)
    .use(remarkBreaks) // Convert line breaks to <br> tags
    .use(remarkHtml, { sanitize: false }); // Convert to HTML

  const htmlContent = processor.processSync(content).toString();

  if (style === 'substack') {
    // Substack-style: clean, minimal, elegant design with serif body font
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: Georgia, 'Times New Roman', serif;
            line-height: 1.75;
            color: #1a1a1a;
            max-width: 680px;
            margin: 0 auto;
            padding: 40px 20px;
            background-color: #ffffff;
        }
        .hero-image {
            width: 100%;
            max-width: 100%;
            height: auto;
            margin: 0 0 48px 0;
            border-radius: 0;
        }
        h1 {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 42px;
            font-weight: 700;
            line-height: 1.2;
            color: #1a1a1a;
            margin: 0 0 16px 0;
            padding: 0;
            border: none;
        }
        h2 {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 28px;
            font-weight: 600;
            line-height: 1.3;
            color: #1a1a1a;
            margin: 48px 0 16px 0;
        }
        h3 {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 22px;
            font-weight: 600;
            line-height: 1.4;
            color: #1a1a1a;
            margin: 32px 0 12px 0;
        }
        p {
            font-size: 20px;
            line-height: 1.75;
            color: #1a1a1a;
            margin: 0 0 24px 0;
        }
        ul, ol {
            font-size: 20px;
            line-height: 1.75;
            margin: 0 0 24px 0;
            padding-left: 32px;
        }
        li {
            margin: 0 0 8px 0;
        }
        a {
            color: #1a1a1a;
            text-decoration: underline;
            text-decoration-color: rgba(26, 26, 26, 0.3);
            text-underline-offset: 2px;
        }
        a:hover {
            text-decoration-color: rgba(26, 26, 26, 0.6);
        }
        .meta {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 14px;
            color: #757575;
            margin: 0 0 32px 0;
            letter-spacing: 0.01em;
        }
        .content {
            margin-top: 0;
        }
        .content > *:first-child {
            margin-top: 0;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 32px 0;
            font-size: 18px;
            line-height: 1.6;
        }
        th, td {
            padding: 12px 16px;
            text-align: left;
            border-bottom: 1px solid #e5e5e5;
        }
        th {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-weight: 600;
            color: #1a1a1a;
            background-color: transparent;
        }
        tr:last-child td {
            border-bottom: none;
        }
        pre {
            background-color: #f8f8f8;
            border: none;
            border-radius: 4px;
            padding: 20px;
            margin: 32px 0;
            overflow-x: auto;
            font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
            font-size: 16px;
            line-height: 1.6;
            white-space: pre;
        }
        pre code {
            background: none;
            padding: 0;
            border: none;
            font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
            color: #1a1a1a;
        }
        blockquote {
            border-left: 3px solid #e5e5e5;
            padding-left: 20px;
            margin: 32px 0;
            font-style: italic;
            color: #4a4a4a;
        }
        .content img {
            width: 100%;
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            margin: 32px 0;
            display: block;
        }
        .content iframe,
        .content video {
            width: 100%;
            max-width: 100%;
            border-radius: 4px;
            margin: 32px 0;
            display: block;
        }
        .content iframe {
            aspect-ratio: 16 / 9;
            height: auto;
            min-height: 400px;
        }
        .content video {
            height: auto;
        }
        @media (max-width: 768px) {
            body {
                padding: 24px 16px;
            }
            h1 {
                font-size: 32px;
            }
            h2 {
                font-size: 24px;
            }
            h3 {
                font-size: 20px;
            }
            p, ul, ol {
                font-size: 18px;
            }
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div class="meta">Published on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <img src="${imageUrl}" alt="${title}" class="hero-image">
    <div class="content">
        ${htmlContent}
    </div>
</body>
</html>`;
  }

  // Default style: original design
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #fff;
        }
        .hero-image {
            width: 100%;
            height: 400px;
            object-fit: cover;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        h2 {
            color: #34495e;
            margin-top: 30px;
        }
        h3 {
            color: #7f8c8d;
        }
        p {
            margin-bottom: 20px;
        }
        ul, ol {
            margin-bottom: 20px;
            padding-left: 20px;
        }
        a {
            color: #3498db;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .meta {
            color: #7f8c8d;
            font-size: 14px;
            margin-bottom: 20px;
        }
                 /* Enhanced table styling */
                 table {
                     width: 100%;
                     border-collapse: collapse;
                     margin: 20px 0;
                     background-color: #fff;
                     border-radius: 8px;
                     overflow: hidden;
                     box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                 }
                 th, td {
                     padding: 12px 16px;
                     text-align: left;
                     border-bottom: 1px solid #e1e5e9;
                 }
                 th {
                     background-color: #3498db;
                     color: white;
                     font-weight: 600;
                     font-size: 14px;
                 }
                 tr:nth-child(even) {
                     background-color: #f8f9fa;
                 }
                 tr:hover {
                     background-color: #e3f2fd;
                 }
                 
                 /* Enhanced code block styling for ASCII art */
                 pre {
                     background-color: #f8f9fa;
                     border: 1px solid #e1e5e9;
                     border-radius: 8px;
                     padding: 16px;
                     margin: 20px 0;
                     overflow-x: auto;
                     font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
                     font-size: 13px;
                     line-height: 1.5;
                     white-space: pre;
                 }
                 
                 /* ASCII art specific styling */
                 pre code {
                     background: none;
                     padding: 0;
                     border: none;
                     font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
                     font-size: 12px;
                     line-height: 1.4;
                     white-space: pre;
                     color: #2c3e50;
                 }
                 
                 /* Content image and video styling */
                 .content img {
                     width: 100%;
                     max-width: 100%;
                     height: auto;
                     border-radius: 8px;
                     margin: 20px 0;
                     display: block;
                     box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                 }
                 .content iframe,
                 .content video {
                     width: 100%;
                     max-width: 100%;
                     border-radius: 8px;
                     margin: 20px 0;
                     display: block;
                     box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                 }
                 .content iframe {
                     aspect-ratio: 16 / 9;
                     height: auto;
                     min-height: 400px;
                 }
                 .content video {
                     height: auto;
                 }
                 
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div class="meta">Published on ${new Date().toLocaleDateString()}</div>
    <img src="${imageUrl}" alt="${title}" class="hero-image">
    <div class="content">
        <p>${htmlContent}</p>
    </div>
</body>
</html>`;
}

// --- CMS Config self-service endpoints ---

const CMS_CONFIG_KEY_PREFIX = 'cms_config_';
const VALID_CMS_TYPES = ['Basehub', 'Webflow', 'WordPress'];

function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

/**
 * GET /api/blog/cms-config
 * Returns the user's CMS configuration with sensitive fields masked.
 */
export const getCmsConfig = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    const cmsType = user?.cmsType || null;

    const { settingsService } = await import('../services/settingsService');
    const setting = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);

    if (setting) {
      const config = JSON.parse(setting.settingValue);

      // Mask sensitive fields
      if (config.applicationPassword) {
        config.applicationPassword = maskSecret(config.applicationPassword);
      }
      if (config.apiToken) {
        config.apiToken = maskSecret(config.apiToken);
      }

      return res.status(200).json({ success: true, cmsType, config, source: 'settings' });
    }

    // Fallback: check Secrets Manager for admin-configured credentials
    if (cmsType === 'WordPress' || cmsType === 'Webflow' || cmsType === 'Basehub') {
      try {
        let config: Record<string, any> = {};
        if (cmsType === 'WordPress') {
          const wpConfig = await getWordPressConfig(userId);
          config = {
            siteUrl: wpConfig.siteUrl,
            username: wpConfig.username,
            applicationPassword: maskSecret(wpConfig.applicationPassword),
            categories: wpConfig.categories,
          };
        } else if (cmsType === 'Webflow') {
          const wfConfig = await getWebflowConfig(userId);
          config = {
            apiToken: maskSecret(wfConfig.apiToken),
            siteId: wfConfig.siteId,
            collectionId: wfConfig.collectionId,
            categories: wfConfig.categories,
          };
        } else if (cmsType === 'Basehub') {
          const bhConfig = await getBaseHubConfig();
          config = {
            apiUrl: bhConfig.apiUrl,
            token: maskSecret(bhConfig.token),
            postsCollectionId: bhConfig.postsCollectionId,
            imageComponentId: bhConfig.imageComponentId,
          };
        }
        return res.status(200).json({ success: true, cmsType, config, source: 'admin' });
      } catch (secretsError) {
        // No Secrets Manager config either — return empty
        console.log(`No Secrets Manager config found for user ${userId} cmsType ${cmsType}`);
      }
    }

    return res.status(200).json({ success: true, cmsType, config: {} });
  } catch (error: any) {
    console.error('Error getting CMS config:', error);
    return res.status(500).json({ success: false, message: 'Failed to get CMS config', error: error.message });
  }
};

/**
 * PUT /api/blog/cms-config
 * Saves the user's CMS configuration. Supports partial updates (omit password to keep existing).
 */
export const saveCmsConfig = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const email = req.user?.email;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { cmsType, config } = req.body;

    // Clearing CMS config
    if (cmsType === null || cmsType === '') {
      const { settingsService } = await import('../services/settingsService');
      const { userDb } = await import('../services/db');
      await settingsService.deleteSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
      await userDb.updateUser(userId, { cmsType: null as any });
      return res.status(200).json({ success: true, message: 'CMS configuration cleared' });
    }

    // Validate cmsType
    if (!VALID_CMS_TYPES.includes(cmsType)) {
      return res.status(400).json({
        message: `Invalid cmsType. Must be one of: ${VALID_CMS_TYPES.join(', ')}`,
      });
    }

    // Validate required fields per CMS type
    const configData = config || {};

    if (cmsType === 'WordPress') {
      const missing: string[] = [];
      if (!configData.siteUrl) missing.push('siteUrl');
      if (!configData.username) missing.push('username');
      // applicationPassword can be omitted for partial updates
      if (!configData.applicationPassword) {
        // Check if there's an existing config with a password
        const { settingsService } = await import('../services/settingsService');
        const existing = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
        if (existing) {
          const existingConfig = JSON.parse(existing.settingValue);
          if (existingConfig.applicationPassword) {
            configData.applicationPassword = existingConfig.applicationPassword;
          } else {
            missing.push('applicationPassword');
          }
        } else {
          missing.push('applicationPassword');
        }
      }
      if (missing.length > 0) {
        return res.status(400).json({
          message: `WordPress config missing required fields: ${missing.join(', ')}`,
        });
      }
    } else if (cmsType === 'Webflow') {
      const missing: string[] = [];
      if (!configData.apiToken) {
        // Check existing config for partial update
        const { settingsService } = await import('../services/settingsService');
        const existing = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
        if (existing) {
          const existingConfig = JSON.parse(existing.settingValue);
          if (existingConfig.apiToken) {
            configData.apiToken = existingConfig.apiToken;
          } else {
            missing.push('apiToken');
          }
        } else {
          missing.push('apiToken');
        }
      }
      if (!configData.siteId) missing.push('siteId');
      if (!configData.collectionId) missing.push('collectionId');
      if (missing.length > 0) {
        return res.status(400).json({
          message: `Webflow config missing required fields: ${missing.join(', ')}`,
        });
      }
    } else if (cmsType === 'Basehub') {
      const missing: string[] = [];
      if (!configData.token) {
        // Check existing config for partial update
        const { settingsService } = await import('../services/settingsService');
        const existing = await settingsService.getSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
        if (existing) {
          const existingConfig = JSON.parse(existing.settingValue);
          if (existingConfig.token) {
            configData.token = existingConfig.token;
          } else {
            missing.push('token');
          }
        } else {
          missing.push('token');
        }
      }
      if (!configData.postsCollectionId) missing.push('postsCollectionId');
      if (missing.length > 0) {
        return res.status(400).json({
          message: `Basehub config missing required fields: ${missing.join(', ')}`,
        });
      }
      // Default apiUrl if not provided
      if (!configData.apiUrl) {
        configData.apiUrl = 'https://api.basehub.com/graphql';
      }
    }

    // Strip trailing slashes from siteUrl if present
    if (configData.siteUrl) {
      configData.siteUrl = configData.siteUrl.replace(/\/+$/, '');
    }

    // Save to AW-Settings
    const { settingsService } = await import('../services/settingsService');
    await settingsService.setSetting(
      `${CMS_CONFIG_KEY_PREFIX}${userId}`,
      JSON.stringify(configData),
      'User CMS configuration',
      email || 'system'
    );

    // Update user's cmsType
    const { userDb } = await import('../services/db');
    await userDb.updateUser(userId, { cmsType });

    return res.status(200).json({ success: true, message: `CMS configuration saved (${cmsType})` });
  } catch (error: any) {
    console.error('Error saving CMS config:', error);
    return res.status(500).json({ success: false, message: 'Failed to save CMS config', error: error.message });
  }
};

/**
 * DELETE /api/blog/cms-config
 * Clears the user's CMS configuration.
 */
export const deleteCmsConfig = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { settingsService } = await import('../services/settingsService');
    const { userDb } = await import('../services/db');

    await settingsService.deleteSetting(`${CMS_CONFIG_KEY_PREFIX}${userId}`);
    await userDb.updateUser(userId, { cmsType: null as any });

    return res.status(200).json({ success: true, message: 'CMS configuration cleared' });
  } catch (error: any) {
    console.error('Error deleting CMS config:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete CMS config', error: error.message });
  }
};

export const generateBlogPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const {
      topic,
      keywords,
      tone = "professional",
      length = "medium",
      researchContext,
    } = req.body;

    if (!topic) {
      return res.status(400).json({ message: "Topic is required" });
    }

    console.log("🤖 Starting AI blog generation workflow...");
    console.log("📝 Topic:", topic);
    console.log("🎭 Tone:", tone);
    console.log("📏 Length:", length);
    if (keywords) console.log("🔑 Keywords:", keywords);
    if (researchContext) console.log("📚 Research context provided");
    console.log("---");

    // Use the utility function for content generation
    console.log("🧠 Analyzing topic and crafting content strategy...");
    console.log("💭 Generating engaging, founder-focused content...");

    try {
      // AgentWeb-specific requirements
      const agentWebRequirements = `4. Include relevant internal links naturally:
   - Link to https://www.agentweb.pro when discussing done-for-you marketing services
   - Link to https://www.agentweb.pro/build for self-service options
   - Link to https://www.agentweb.pro/pricing for cost discussions
5. End with this exact CTA: "Ready to put your marketing on autopilot? [Book a call with Harsha](https://calendly.com/harsha-agentweb/30min) to walk through your current marketing workflow and see how AgentWeb can help you scale."`;

      // Create drafts from the topic for generateBlogContent
      const titleDraft = topic;
      const contentDraft = `# ${topic}\n\nThis article will cover ${topic}.`;
      
      const blogData = await generateBlogContent(titleDraft, contentDraft, length, researchContext, agentWebRequirements);

      console.log("✅ Content generation complete! Processing AI response...");
      console.log("✅ Content validation passed!");
      console.log("📰 Title:", blogData.title);
      console.log("📄 Content length:", blogData.content.length, "characters");
      console.log("🎨 Image prompt ready for generation");
      console.log("---");
      console.log("🎉 Blog post generated successfully via LLM");

      return res.status(200).json({
        success: true,
        data: {
          title: blogData.title,
          description: blogData.description,
          content: blogData.content,
          imagePrompt: blogData.imagePrompt,
        },
      });
    } catch (llmError: any) {
      console.log(
        "⚠️ Primary AI generation failed, activating fallback mode..."
      );
      console.log("🔄 Generating backup content structure...");

      // Fallback to placeholder response if LLM fails
      const fallbackResponse = {
        title: `Essential Guide: ${topic}`,
        description: `A comprehensive guide to ${topic} for startup founders, covering key strategies and practical implementation tips.`,
        content: `# Essential Guide: ${topic}

This guide covers the fundamentals of ${topic} for startup founders.

## Understanding ${topic}

- Core concepts and principles
- Why it matters for your startup
- Key considerations for implementation

## Practical Strategies

- Step-by-step approach
- Common challenges and solutions
- Best practices from successful startups

## Getting Started

Ready to put your marketing on autopilot? [Book a call with Harsha](https://calendly.com/harsha-agentweb/30min) to walk through your current marketing workflow and see how AgentWeb can help you scale.`,
        imagePrompt: `A professional business illustration representing ${topic}. Clean, modern design with relevant visual elements. No text, conceptual business representation.`,
      };

      console.log("✅ Fallback content generated successfully");
      console.log("---");

      return res.status(200).json({
        success: true,
        data: fallbackResponse,
        message: "Used fallback response due to LLM generation failure",
      });
    }
  } catch (error: any) {
    console.error("❌ Error generating blog post:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate blog post",
      error: error.message,
    });
  }
};

export const generateImage = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { prompt, filename } = req.body;

    if (!prompt) {
      return res.status(400).json({ message: "Image prompt is required" });
    }

    console.log("🎨 Starting AI image generation workflow...");
    console.log(
      "💭 Prompt:",
      prompt.substring(0, 100) + (prompt.length > 100 ? "..." : "")
    );
    console.log("📁 Filename:", filename || "auto-generated");
    console.log("---");

    // Generate image using imageService
    console.log("🤖 Generating image using imageService...");
    const isImageServiceAvailable = await imageService.isAvailable();

    if (!isImageServiceAvailable) {
      console.warn("🚫 Image generation service not available");
      return res.status(503).json({
        success: false,
        message: "Image generation service not available. Please check API key configuration in AWS Secrets Manager.",
        error: "Service unavailable",
      });
    }

    console.log("🔧 Using imageService for image generation...");

    const result = await imageService.generateImage({
        prompt: prompt,
        size: "1536x1024",
        quality: "low",
        filename: filename || "generated-blog-image.png",
        userId: userId,
        inputImages: []
      });

    if (result.success && result.imageUrl) {
      console.log("✅ Image generated successfully via imageService");
        console.log("📤 Initiating S3 upload process...");

        // Upload to S3 and return S3 URL
        try {
          // Image is already uploaded to S3 by imageService
          console.log("✅ S3 upload completed successfully!");
          console.log("�� Final image URL:", result.imageUrl);
          console.log("---");
          return res.status(200).json({
            success: true,
            data: {
              imageUrl: result.imageUrl,
              filename:
                result.filename || filename || "generated-blog-image.png",
            },
          });
        } catch (uploadError) {
          console.error(
            "S3 upload failed, returning original URL:",
            uploadError
          );
          return res.status(200).json({
            success: true,
            data: {
              imageUrl: result.imageUrl,
              filename:
                result.filename || filename || "generated-blog-image.png",
            },
          });
        }
      } else {
      console.error("❌ Image generation failed:", result.error);
      return res.status(500).json({
          success: false,
        message: "Image generation failed",
        error: result.error,
      });
    }
  } catch (error: any) {
    console.error("❌ Image generation failed:", error);
    return res.status(500).json({
      success: false,
      message: "Image generation failed",
      error: error.message,
    });
  }
};

// Function to publish to Webflow CMS
async function publishToWebflow(
  title: string,
  description: string,
  content: string,
  imageUrl: string | undefined,
  userId: string
): Promise<any> {
  console.log('publishToWebflow called with:', {
    userId,
    titleSnippet: title?.substring(0, 60),
    hasImage: !!imageUrl,
  });

  const { apiToken, siteId, collectionId, fieldMappings } = await getWebflowConfig(userId);

  // Convert markdown content to HTML
  // Use dynamic import for ES modules
  const { remark } = await import('remark');
  const remarkHtml = (await import('remark-html')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const remarkBreaks = (await import('remark-breaks')).default;
  
  const processor = remark()
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkHtml, { sanitize: false });
  const htmlContent = processor.processSync(content).toString();

  // Prepare the CMS item data
  // Field names must match the actual field slugs in your Webflow collection
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  
  const cmsItemData: any = {
    fieldData: {
      name: title,
      slug: slug,
      _archived: false,
      _draft: false,
    }
  };

  // Add custom fields based on field mappings (only include if field exists in collection)
  // Webflow API may strip HTML tags if newlines are present, so remove them
  const cleanHtmlContent = htmlContent.replace(/\n/g, '').replace(/\r/g, '');
  
  if (fieldMappings?.summary) {
    cmsItemData.fieldData[fieldMappings.summary] = description;
  }
  
  if (fieldMappings?.body) {
    cmsItemData.fieldData[fieldMappings.body] = cleanHtmlContent;
  }

  // Only include publish date if the field mapping is configured
  if (fieldMappings?.publishDate) {
    cmsItemData.fieldData[fieldMappings.publishDate] = new Date().toISOString();
  }

  // Add image if provided and field mapping is configured
  if (imageUrl && fieldMappings?.image) {
    cmsItemData.fieldData[fieldMappings.image] = imageUrl;
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "accept-version": "2.0.0"
  };

  console.log("🌐 Publishing to Webflow CMS...");
  
  try {
    const response = await axios.post(
      `https://api.webflow.com/v2/sites/${siteId}/collections/${collectionId}/items`,
      cmsItemData,
      { headers }
    );

    console.log("✅ Blog post published successfully to Webflow");
    return response.data;
  } catch (error: any) {
    // Extract only relevant error information
    const errorInfo: any = {
      status: error.response?.status,
      statusText: error.response?.statusText,
    };

    if (error.response?.data) {
      const errorData = error.response.data;
      
      // Extract error message - Webflow often has nested error structures
      if (errorData.msg) {
        errorInfo.message = errorData.msg;
      } else if (errorData.message) {
        errorInfo.message = errorData.message;
      } else if (errorData.error) {
        errorInfo.message = errorData.error;
      } else if (typeof errorData === 'string') {
        errorInfo.message = errorData;
      }

      // Extract detailed validation errors - Webflow may nest them
      if (errorData.errors) {
        errorInfo.fieldErrors = errorData.errors;
        // If errors is an array, format it nicely
        if (Array.isArray(errorData.errors)) {
          errorInfo.message = errorData.errors.join(', ') || errorInfo.message;
        } else if (typeof errorData.errors === 'object') {
          // If errors is an object, extract all error messages
          const errorMessages = Object.entries(errorData.errors)
            .map(([key, value]) => {
              if (Array.isArray(value)) {
                return `${key}: ${value.join(', ')}`;
              }
              return `${key}: ${value}`;
            })
            .join('; ');
          if (errorMessages) {
            errorInfo.message = errorMessages;
          }
        }
      }

      // Extract nested error details (Webflow validation errors)
      if (errorData.details && Array.isArray(errorData.details)) {
        errorInfo.details = errorData.details;
        // Format details into readable error messages
        const detailMessages = errorData.details
          .map((detail: any) => {
            if (detail.param && detail.description) {
              return `${detail.param}: ${detail.description}`;
            }
            return JSON.stringify(detail);
          })
          .join('; ');
        if (detailMessages) {
          errorInfo.message = `${errorInfo.message || 'Validation Error'}. ${detailMessages}`;
        }
      }

      // Extract code if present
      if (errorData.code) {
        errorInfo.code = errorData.code;
      }
    } else {
      errorInfo.message = error.message || 'Unknown error';
    }

    // Log concise error summary
    if (errorInfo.details && errorInfo.details.length > 0) {
      const errorDetails = errorInfo.details
        .map((d: any) => `${d.param}: ${d.description}`)
        .join(', ');
      console.error(`❌ Webflow API error (${errorInfo.status}): ${errorDetails}`);
    } else {
      console.error(`❌ Webflow API error (${errorInfo.status}): ${errorInfo.message}`);
    }
    
    // Create a more user-friendly error message
    const errorMessage = errorInfo.message || `Webflow API error: ${errorInfo.status} ${errorInfo.statusText}`;
    const webflowError = new Error(errorMessage);
    (webflowError as any).status = errorInfo.status;
    (webflowError as any).fieldErrors = errorInfo.fieldErrors;
    (webflowError as any).details = errorInfo.details;
    throw webflowError;
  }
}

// Function to publish to WordPress via REST API
async function publishToWordPress(
  title: string,
  description: string,
  content: string,
  imageUrl: string | undefined,
  userId: string,
  status: string = 'draft',
  categoryIds: number[] = []
): Promise<any> {
  console.log('publishToWordPress called with:', {
    userId,
    titleSnippet: title?.substring(0, 60),
    hasImage: !!imageUrl,
    status,
    categoryIds,
  });

  const { siteUrl, username, applicationPassword } = await getWordPressConfig(userId);

  // Convert markdown content to HTML
  const { remark } = await import('remark');
  const remarkHtml = (await import('remark-html')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const remarkBreaks = (await import('remark-breaks')).default;

  const processor = remark()
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkHtml, { sanitize: false });
  const htmlContent = processor.processSync(content).toString();

  // Build Basic Auth header
  const authHeader = 'Basic ' + Buffer.from(`${username}:${applicationPassword}`).toString('base64');

  // Upload featured image if provided
  let featuredMediaId: number | undefined;
  if (imageUrl) {
    try {
      console.log("Uploading featured image to WordPress...");
      // Download the image
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const imageBuffer = Buffer.from(imageResponse.data as ArrayBuffer);
      const contentType = imageResponse.headers['content-type'] || 'image/png';
      const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
      const filename = `blog-hero-${Date.now()}.${ext}`;

      const mediaResponse = await axios.post(
        `${siteUrl}/wp-json/wp/v2/media`,
        imageBuffer,
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
          timeout: 60000,
        }
      );

      featuredMediaId = (mediaResponse.data as any).id;
      console.log("Featured image uploaded, media ID:", featuredMediaId);
    } catch (imgError: any) {
      console.error("Failed to upload featured image to WordPress:", imgError.message);
      // Continue without featured image rather than failing the whole publish
    }
  }

  // Create the post
  const wpStatus = status === 'published' ? 'publish' : 'draft';
  const postData: any = {
    title: title,
    content: htmlContent,
    excerpt: description,
    status: wpStatus,
  };

  if (featuredMediaId) {
    postData.featured_media = featuredMediaId;
  }

  if (categoryIds.length > 0) {
    postData.categories = categoryIds;
  }

  console.log("Publishing to WordPress...");

  try {
    const response = await axios.post(
      `${siteUrl}/wp-json/wp/v2/posts`,
      postData,
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log("Blog post published successfully to WordPress");
    return response.data;
  } catch (error: any) {
    const errorInfo: any = {
      status: error.response?.status,
      statusText: error.response?.statusText,
    };

    if (error.response?.data) {
      const errorData = error.response.data;
      errorInfo.message = errorData.message || errorData.error || error.message;
      if (errorData.code) {
        errorInfo.code = errorData.code;
      }
    } else {
      errorInfo.message = error.message || 'Unknown error';
    }

    console.error(`WordPress API error (${errorInfo.status}): ${errorInfo.message}`);

    const wpError = new Error(errorInfo.message || `WordPress API error: ${errorInfo.status} ${errorInfo.statusText}`);
    (wpError as any).status = errorInfo.status;
    (wpError as any).code = errorInfo.code;
    throw wpError;
  }
}

export const publishBlogPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { title, description, content, imageUrl, imageFilename, executionId, htmlReportUrl } = req.body;

    // Debug: Log the entire request body
    console.log("📥 Request body received:", req.body);

    if (!title || !description || !content) {
      return res
        .status(400)
        .json({ message: "Title, description, and content are required" });
    }

    // Get user's CMS Type
    const { userDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const cmsType = user.cmsType;

    // Check if CMS Type is configured
    if (!cmsType) {
      return res.status(400).json({
        success: false,
        message: "CMS Type is not configured for this user. Please contact an administrator to set up CMS publishing.",
      });
    }

    console.log(`🚀 Starting ${cmsType} publishing workflow...`);
    console.log("📰 Blog Title:", title);
    console.log("📝 Description length:", description.length, "characters");
    console.log("📄 Content length:", content.length, "characters");
    console.log("🖼️ Image URL:", imageUrl);
    console.log("🖼️ Image Filename:", imageFilename);
    console.log("🔍 Execution ID:", executionId);
    console.log("📊 HTML Report URL:", htmlReportUrl);
    console.log("---");

    let response: any;
    let publishedField: string;

    if (cmsType === "Webflow") {
      // Publish to Webflow
      response = await publishToWebflow(title, description, content, imageUrl, userId);
      publishedField = "publishedToWebflow";
    } else if (cmsType === "Basehub") {
      // Publish to BaseHub (existing logic)
      const { apiUrl, token, postsCollectionId, imageComponentId } = await getBaseHubConfig(userId);

      if (!token) {
        return res.status(500).json({
          success: false,
          message: "BaseHub token is not configured",
        });
      }

      // Randomly select an author (you can modify this logic)
      console.log("👤 Selecting author for this blog post...");
      const authorIds = Object.values(AUTHORS);
      const randomAuthorId =
        authorIds[Math.floor(Math.random() * authorIds.length)];
      console.log("✅ Author assigned:", randomAuthorId);

      // Create the transaction data structure
      console.log("🏗️ Building BaseHub transaction structure...");
      const transactionData = {
        type: "create",
        parentId: postsCollectionId,
        data: {
          title: title,
          type: "instance",
          value: {
            description: {
              type: "text",
              value: description,
            },
            publishedAt: {
              type: "date",
              value: new Date().toISOString(),
            },
            body: {
              type: "rich-text",
              value: {
                format: "markdown",
                value: content,
              },
            },
            authors: {
              type: "reference",
              value: [randomAuthorId],
            },
          },
        },
      };

      // Add image if provided - using the correct BaseHub structure from working Python code
      if (imageUrl && imageFilename) {
        console.log("🖼️ Adding image data to transaction...");
        console.log("🖼️ Image URL to add:", imageUrl);
        console.log("🖼️ Image filename to add:", imageFilename);

        // This is the correct structure based on the working Python code
        (transactionData.data.value as any).image = {
          type: "instance",
          mainComponentId: imageComponentId, // This is the image component ID from BaseHub
          value: {
            light: {
              type: "media",
              value: {
                url: imageUrl,
                fileName: imageFilename,
              },
            },
          },
        };
        console.log("✅ Image data integrated into transaction");
        console.log(
          "🖼️ Final image data structure:",
          (transactionData.data.value as any).image
        );
      } else {
        console.log(
          "⚠️ No image data provided - imageUrl:",
          imageUrl,
          "imageFilename:",
          imageFilename
        );
      }

      const mutation = `
        mutation CreateBlogPost($data: String!) {
          transaction(data: $data)
        }
      `;

      const variables = { data: JSON.stringify(transactionData) };

      // Debug: Log summary of what we're sending to BaseHub
      console.log("📤 Sending to BaseHub - Title:", title, "Content length:", content.length);

      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      console.log("🌐 Initiating BaseHub API request...");
      const basehubResponse = await axios.post(
        apiUrl,
        { query: mutation, variables },
        { headers }
      );

      // Log BaseHub response summary
      const responseData = basehubResponse.data as any;
      if (responseData?.errors) {
        console.error("📥 BaseHub Response Errors:", JSON.stringify(responseData.errors, null, 2));
      } else {
        console.log("📥 BaseHub Response: Success");
      }

      console.log("✅ Blog post published successfully to BaseHub");
      response = basehubResponse.data;
      publishedField = "publishedToBasehub";
    } else if (cmsType === "WordPress") {
      // Publish to WordPress
      response = await publishToWordPress(title, description, content, imageUrl, userId);
      publishedField = "publishedToWordPress";
    } else {
      return res.status(400).json({
        success: false,
        message: `Unsupported CMS Type: ${cmsType}. Supported types are 'Basehub', 'Webflow', and 'WordPress'.`,
      });
    }

    // Update the existing execution record with published timestamp
    if (executionId && htmlReportUrl) {
      try {
        const { taskDb } = await import('../services/db');
        
        // Get the existing execution
        const existingExecution = await taskDb.getTaskExecutionById(executionId);
        
        if (existingExecution && existingExecution.userId === userId) {
          console.log(`✅ Found existing execution, updating with ${publishedField} timestamp`);
          
          // Find the HTML report file in result_files by URL and add published timestamp
          const currentResultFiles = existingExecution.result_files || [];
          const updatedResultFiles = currentResultFiles.map((file: any) => {
            if (file.url === htmlReportUrl) {
              // Add published timestamp to this file
              return {
                ...file,
                [publishedField]: new Date().toISOString()
              };
            }
            return file;
          });
          
          // Update the execution with the modified result_files
          await taskDb.updateTaskExecution(executionId, {
            result_files: updatedResultFiles
          });
          
          console.log(`✅ ${publishedField} timestamp added to existing execution record`);
        } else {
          console.log("⚠️ Execution not found or access denied, cannot update record");
        }
      } catch (dbError) {
        console.error(`⚠️ Failed to update execution record with ${publishedField} timestamp:`, dbError);
        // Don't fail the request if database update fails
      }
    }

    return res.status(200).json({
      success: true,
      message: `Blog post published successfully to ${cmsType}`,
      data: {
        cmsResponse: response,
      },
    });
  } catch (error: any) {
    console.error("Error publishing blog post:", error);
    
    // Extract meaningful error information
    let errorMessage = "Error publishing blog post";
    let statusCode = 500;
    
    if (error.message) {
      errorMessage = error.message;
    }
    
    // Handle Webflow field validation errors
    if (error.details && Array.isArray(error.details)) {
      const fieldErrors = error.details
        .map((detail: any) => {
          if (detail.param && detail.description) {
            return `${detail.param}: ${detail.description}`;
          }
          return JSON.stringify(detail);
        })
        .join('; ');
      errorMessage = `Webflow validation error: ${fieldErrors}`;
      statusCode = 400;
    } else if (error.fieldErrors) {
      const fieldErrors = Object.entries(error.fieldErrors)
        .map(([field, msg]) => `${field}: ${msg}`)
        .join(', ');
      errorMessage = `Webflow validation error: ${fieldErrors}`;
      statusCode = 400;
    }
    
    // Handle HTTP status codes from CMS APIs
    if (error.status) {
      statusCode = error.status >= 400 && error.status < 600 ? error.status : 500;
    }
    
    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error.message || "Unknown error occurred",
    });
  }
};

/**
 * GET /api/blog/categories
 * Returns the list of CMS category names for the authenticated user.
 */
export const getCmsCategories = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { userDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    const cmsType = user?.cmsType;

    // Webflow and WordPress have categories configured via Secrets Manager
    if (cmsType === 'Webflow') {
      const config = await getWebflowConfig(userId);
      const categoryNames = config.categories ? Object.keys(config.categories) : [];
      return res.status(200).json({
        success: true,
        cmsType,
        categories: categoryNames,
      });
    }

    if (cmsType === 'WordPress') {
      const config = await getWordPressConfig(userId);
      const categoryNames = config.categories ? Object.keys(config.categories) : [];
      return res.status(200).json({
        success: true,
        cmsType,
        categories: categoryNames,
      });
    }

    return res.status(200).json({
      success: true,
      cmsType: cmsType || null,
      categories: [],
    });
  } catch (error: any) {
    console.error("❌ Error fetching CMS categories:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch CMS categories",
      error: error.message,
    });
  }
};

/**
 * POST /api/blog/publish-direct
 * Publishes a blog article directly from an HTML report URL.
 * Extracts title, description, and hero image from the HTML, then delegates
 * to agentModeService.publishBlogArticle.
 */
export const publishBlogDirect = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { blogHtmlUrl, status = 'draft', author, categories, sessionId } = req.body;

    if (!blogHtmlUrl) {
      return res.status(400).json({ message: "blogHtmlUrl is required" });
    }

    // Fetch the HTML
    const htmlResponse = await axios.get(blogHtmlUrl, {
      timeout: 30000,
      responseType: 'text',
      headers: { 'User-Agent': 'AgentWeb-Backend/1.0' },
    });
    const html = htmlResponse.data as string;

    // Extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    // Extract description from <meta name="description">
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const description = descMatch ? descMatch[1].trim() : '';

    // Extract hero image — try class="hero-image" first, then fall back to first <img> with src
    const heroMatch = html.match(/<img[^>]*class=["'][^"']*hero-image[^"']*["'][^>]*src=["']([^"']+)["']/i);
    let heroImageUrl = heroMatch ? heroMatch[1] : '';
    if (!heroImageUrl) {
      // Fallback: try src before class pattern
      const heroMatchAlt = html.match(/<img[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*hero-image[^"']*["']/i);
      if (heroMatchAlt) {
        heroImageUrl = heroMatchAlt[1];
      } else {
        // Last resort: first <img> with an https src
        const firstImgMatch = html.match(/<img[^>]*src=["'](https?:\/\/[^"']+)["']/i);
        heroImageUrl = firstImgMatch ? firstImgMatch[1] : '';
      }
    }

    // For manually_published, skip CMS and just store the status
    if (status === 'manually_published') {
      if (sessionId) {
        try {
          const { ChatbotDB } = await import('../services/chatbotService');
          const chatbotDb = new ChatbotDB();
          const session = await chatbotDb.getChatSession(sessionId);
          if (session) {
            const currentStatuses = session.publishStatuses || {};
            await chatbotDb.updateSessionPublishStatuses(sessionId, {
              ...currentStatuses,
              [blogHtmlUrl]: status,
            });
          }
        } catch (sessionError) {
          console.error("⚠️ Failed to update session publish status:", sessionError);
        }
      }
      return res.status(200).json({
        success: true,
        message: 'Report marked as manually published',
        data: { status: 'manually_published', title },
      });
    }

    // Call agentModeService.publishBlogArticle
    const { agentModeService } = await import('../services/agentModeService');
    const result = await agentModeService.publishBlogArticle(
      title,
      description,
      heroImageUrl,
      blogHtmlUrl,
      userId,
      sessionId || '',
      status,
      author,
      categories
    );

    // If publish succeeded and sessionId is provided, store publish status on the session
    if (result.success && sessionId) {
      try {
        const { ChatbotDB } = await import('../services/chatbotService');
        const chatbotDb = new ChatbotDB();
        const session = await chatbotDb.getChatSession(sessionId);
        if (session) {
          const currentStatuses = session.publishStatuses || {};
          await chatbotDb.updateSessionPublishStatuses(sessionId, {
            ...currentStatuses,
            [blogHtmlUrl]: status,
          });
        }
      } catch (sessionError) {
        // Don't fail the publish if session update fails
        console.error("⚠️ Failed to update session publish status:", sessionError);
      }
    }

    return res.status(200).json(result);
  } catch (error: any) {
    console.error("❌ Error in publish-direct:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to publish blog article",
      error: error.message,
    });
  }
};
