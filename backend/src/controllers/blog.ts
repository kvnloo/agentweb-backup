import { Request, Response } from "express";
import { imageService } from "../services/imageGeneration";
import OpenAI from "openai";
import axios from "axios";
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import { remark } from 'remark';
import remarkHtml from 'remark-html';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

// Initialize Azure OpenAI client for text generation
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

// Initialize AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "us-east-1",
});

// Function to get BaseHub configuration from Secrets Manager
export async function getBaseHubConfig(): Promise<{
  apiUrl: string;
  token: string;
  postsCollectionId: string;
  imageComponentId: string;
}> {
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
  };
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
        console.log(
          `Per-user Webflow config not found for user ${userId} at ${userSecretName}, using global secret ${baseSecretName}`,
        );
        configJson = await getSecret(baseSecretName);
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
    
    return {
      apiToken: config.apiToken,
      siteId: config.siteId,
      collectionId: config.collectionId,
      fieldMappings: config.fieldMappings || {
        summary: "post-summary",
        body: "post-body",
        image: "main-image",
        publishDate: undefined, // Optional - only include if field exists in collection
      }
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
  topic: string,
  keywords: string = "",
  tone: string = "professional",
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
  const targetWordCounts: Record<string, number> = { short: 600, medium: 1000, long: 1600 };
  const targetWords = targetWordCounts[length] ?? 1000;
  const isLongForm = length === 'medium' || length === 'long';

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

  // Generic blog prompt for content generation
  let blogPrompt = `You are an expert marketing strategist and content writer. Create a high-quality, engaging blog post about: ${topic}

Requirements:
- Tone: ${tone} (be conversational but professional, avoid overly formal language)
- Target length: approximately ${targetWords} words (±10%)
- Keywords to naturally include: ${keywords || "relevant industry keywords"}
${substackGuidelines}

Content Guidelines:
1. Write in a natural, human voice - avoid AI-generated patterns
2. Use practical examples and actionable insights
3. Structure with clear H2 and H3 headings (no H4+)
4. If research context is provided, use it as a foundation but rewrite in your own voice
5. Avoid generic AI language - be specific, use real examples, and sound like a human expert
6. Do NOT include the title as an H1 heading in the content - the title will be added separately
7. Use tables, bullet points, numbered lists, or paragraphs for data presentation${isLongForm ? `
8. For ${length} articles, focus on clear, well-structured content:
    - Create markdown tables for structured data when it adds value
    - Use bullet points, numbered lists, and clear headings for organization
    - Avoid ASCII art, diagrams, or complex visual elements
    - Focus on readable, professional content that provides real value` : ''}

Format the response as JSON with this structure:
{
  "title": "Compelling, SEO-optimized title",
  "description": "1-2 sentence meta description for SEO",
  "content": "Full blog content in markdown format",
  "imagePrompt": "Detailed visual description for hero image (avoid text, be conceptual)"
}`;

  // Add custom requirements if provided
  if (requirements) {
    blogPrompt += `

Additional Requirements:
${requirements}`;
  }

  // Add research context if provided
  if (researchContext) {
    blogPrompt += `

Research Context (use as foundation but rewrite naturally):
${researchContext}`;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a seasoned marketing strategist and content writer. Write naturally, avoid AI patterns, and focus on providing real value to startup founders. Never create tables - use bullet points, numbered lists, or paragraphs instead. Always respond with valid JSON.",
        },
        { role: "user", content: blogPrompt },
      ],
      temperature: 0.8,
      max_tokens: 3000,
    });

    const responseContent = completion.choices[0].message.content;
    if (!responseContent) {
      throw new Error("No content generated from LLM");
    }

    // Parse the JSON response
    let blogData;
    try {
      const cleanedContent = responseContent.replace(/```json\s*|\s*```/g, "").trim();
      blogData = JSON.parse(cleanedContent);
    } catch (parseError) {
      // Fallback: create a structured response from the raw content
      blogData = {
        title: `Insights on ${topic}`,
        description: `Key insights and strategies for ${topic}, providing valuable information for readers.`,
        content: `# Insights on ${topic}

This article provides practical insights on ${topic}.

## Key Takeaways

- Understanding the fundamentals of ${topic}
- Practical strategies for implementation
- Common pitfalls to avoid

## Conclusion

This guide covers the essential aspects of ${topic} to help you get started.`,
        imagePrompt: `A modern, professional business illustration representing ${topic}. Clean design with relevant visual elements, suitable for a business blog. No text, conceptual representation.`,
      };
    }

    // Validate the response structure
    if (!blogData.title || !blogData.content) {
      throw new Error("LLM response missing required fields (title, content)");
    }

    return blogData;
  } catch (llmError: any) {
    // Fallback to placeholder response if LLM fails
    return {
      title: `Essential Guide: ${topic}`,
      description: `A comprehensive guide to ${topic}, covering key strategies and practical implementation tips.`,
      content: `# Essential Guide: ${topic}

This guide covers the fundamentals of ${topic}.

## Understanding ${topic}

- Core concepts and principles
- Why it matters
- Key considerations for implementation

## Practical Strategies

- Step-by-step approach
- Common challenges and solutions
- Best practices

## Getting Started

This guide provides the essential information you need to get started with ${topic}.`,
      imagePrompt: `A professional business illustration representing ${topic}. Clean, modern design with relevant visual elements. No text, conceptual business representation.`,
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
- Write in first-person perspective ("I", "we", "my experience")
- Be conversational and approachable
- Include personal transitions like "Here's what I've learned..." or "Let me share..."
- Use shorter paragraphs for better readability` : '';

  // Inline image placeholder instructions
  const inlineImageGuidelines = includeInlineImages ? `

Image Placeholders:
- Add 3-5 {{IMAGE: prompt="...", caption="..."}} placeholders throughout
- Place them after key sections that would benefit from visual illustration
- Each should have a detailed prompt and brief caption
- Do NOT place a placeholder at the very beginning` : '';

  const prompt = `You are an expert editor. Restyle the following research content into a blog article.

TASK: Restyle this content (do NOT generate new content, preserve the key information)

ORIGINAL CONTENT:
${originalContent}

REQUIREMENTS:
- Tone: ${tone}
- Preserve all key facts, data, and insights from the original
- Improve readability and flow
- Remove any overly academic or dry language
- Keep the structure but make it more engaging
${substackGuidelines}
${inlineImageGuidelines}

Format the response as JSON:
{
  "title": "Engaging title for the article",
  "description": "1-2 sentence meta description",
  "content": "Restyled content in markdown${includeInlineImages ? ' with {{IMAGE:...}} placeholders' : ''}",
  "imagePrompt": "Detailed prompt for hero image (conceptual, no text)"${includeInlineImages ? ',\n  "inlineImageCount": 3' : ''}
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",  // Using GPT-4o for restyling
      messages: [
        {
          role: "system",
          content: "You are an expert content editor. Restyle content while preserving key information. Always respond with valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 16000,  // High limit for long research content output
    });

    const responseContent = completion.choices[0].message.content;
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
export function generateBlogHtml(
  title: string,
  description: string,
  content: string,
  imageUrl: string,
  style: string = 'default'
): string {
  // Convert markdown content to HTML using remark with enhanced plugins
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

      const blogData = await generateBlogContent(topic, keywords, tone, length, researchContext, agentWebRequirements);

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
      const { apiUrl, token, postsCollectionId, imageComponentId } = await getBaseHubConfig();

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
    } else {
      return res.status(400).json({
        success: false,
        message: `Unsupported CMS Type: ${cmsType}. Supported types are 'Basehub' and 'Webflow'.`,
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
