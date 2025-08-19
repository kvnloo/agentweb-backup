import { Request, Response } from "express";
import OpenAI from "openai";
import axios from "axios";
import { openaiImageService } from "../services/imageGeneration";

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

// Initialize Azure OpenAI client for text generation
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
});

// Initialize OpenAI client for DALL-E fallback
let dalleClient: OpenAI | null = null;

if (process.env.OPENAI_IMAGE_API_KEY) {
  dalleClient = new OpenAI({
    apiKey: process.env.OPENAI_IMAGE_API_KEY,
  });
} else {
  console.warn(
    "⚠️ No image generation client available. Set OPENAI_IMAGE_API_KEY to enable image generation."
  );
}

interface BlogPostData {
  title: string;
  description: string;
  content: string;
  imageFilename: string;
  imagePrompt: string;
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

    // Generate blog post content using LLM
    let blogPrompt = `Convert this well-written article from HTML format to a blog-ready format. 

    Requirements:
    - Topic: ${topic}
    - Keywords to include: ${keywords || "relevant industry keywords"}
    - Tone: ${tone}
    - Length: ${length} (400-800 words for short, 800-1200 for medium, 1200-2000 for long)
    
    IMPORTANT: This is a format conversion task. The article content is already excellent - you just need to:
    1. CONVERT from HTML format to clean markdown blog format
    2. MAINTAIN all the existing content, insights, and structure
    3. IMPROVE formatting for blog readability (better headings, spacing, etc.)
    4. ENSURE the content is ready for immediate blog publishing
    5. PRESERVE the article's quality and message`;

    // Add research context if provided
    if (researchContext) {
      blogPrompt += `
    
    HTML ARTICLE CONTENT:
    ${researchContext}
    
    Convert this HTML article to blog format by:
    - Removing HTML tags and converting to clean markdown
    - Improving heading structure and readability
    - Adding proper spacing and formatting
    - Ensuring all content is preserved exactly as written
    - Making it ready for immediate blog publication
    - Keeping the same high quality and insights`;
    }

    blogPrompt += `
    
    Please provide:
    1. A compelling title (can be the same as the original if it's good)
    2. A brief description (1-2 sentences for SEO) summarizing the key points
    3. The full blog content in clean markdown format, preserving all original content
    4. A detailed image prompt for generating a hero image that represents the article topic

    Format the response as JSON with the following structure:
    {
      "title": "Blog Post Title",
      "description": "SEO description highlighting key article points",
      "content": "# Blog Post Content in Markdown...",
      "imagePrompt": "Detailed description for hero image generation"
    }
    
    Remember: The article is already excellent. Just convert the format from HTML to blog-ready markdown while preserving all the quality content.`;

    // Generate blog post content using LLM
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a professional blog formatter who converts well-written HTML articles to blog-ready markdown format. The content is already excellent - focus on clean formatting and structure. Always respond with valid JSON.' },
          { role: 'user', content: blogPrompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      });

      const responseContent = completion.choices[0].message.content;
      if (!responseContent) {
        throw new Error('No content generated from LLM');
      }

      // Try to parse the JSON response
      let blogData;
      try {
        // Sometimes the LLM wraps JSON in markdown code blocks, so let's clean that up
        const cleanedContent = responseContent.replace(/```json\s*|\s*```/g, '').trim();
        blogData = JSON.parse(cleanedContent);
      } catch (parseError) {
        // Fallback: create a structured response from the raw content
        blogData = {
          title: `Article Insights: ${topic}`,
          description: `Key insights and content from the HTML article on ${topic}, converted into an accessible blog format.`,
          content: responseContent,
          imagePrompt: `A professional business illustration representing content and insights on ${topic}, suitable for a business blog post. Clean, modern design with relevant visual elements.`
        };
      }

      // Validate the response structure
      if (!blogData.title || !blogData.content) {
        throw new Error('LLM response missing required fields (title, content)');
      }

      return res.status(200).json({
        success: true,
        data: blogData,
      });
    } catch (llmError: any) {
      // Fallback to placeholder response if LLM fails
      const fallbackResponse = {
        title: `Article Insights: ${topic}`,
        description: `Key insights and content from the HTML article on ${topic}, converted into an accessible blog format for business professionals.`,
        content: `# Article Insights: ${topic}

This is a fallback blog post about ${topic}. The AI generation failed, so this is a basic template.

## Key Points

- Point 1 about ${topic}
- Point 2 about ${topic}
- Point 3 about ${topic}

## Conclusion

This concludes our exploration of ${topic}.`,
        imagePrompt: `A professional business illustration representing content and insights on ${topic}, suitable for a business blog post. Clean, modern design with relevant visual elements.`,
      };

      return res.status(200).json({
        success: true,
        data: fallbackResponse,
        message: "Used fallback response due to LLM generation failure"
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

    // Try OpenAI image generation first (uses gpt-image-1)
    const openaiImageAvailable = await openaiImageService.isAvailable();

    if (openaiImageAvailable) {
      console.log("🔧 Using OpenAI API image generation (gpt-image-1)...");

      const openaiResult = await openaiImageService.generateImage({
        prompt: prompt,
        size: "1536x1024",
        quality: "standard",
        filename: filename || "generated-blog-image.png",
      });

      if (openaiResult.success && openaiResult.imageUrl) {
        console.log("✅ Image generated successfully via OpenAI API");
        return res.status(200).json({
          success: true,
          data: {
            imageUrl: openaiResult.imageUrl,
            filename: openaiResult.filename || filename || "generated-blog-image.png",
          },
        });
      } else {
        // Continue to fallback methods
      }
    }

    // Fallback to direct DALL-E if OpenAI API fails or isn't available
    if (!dalleClient) {
      console.warn("🚫 No image generation methods available");
      return res.status(503).json({
        success: false,
        message:
          "Image generation service not available. Please configure OPENAI_IMAGE_API_KEY.",
        error: "No image generation client configured",
      });
    }

    console.log("🔄 Falling back to direct DALL-E image generation...");

    // Generate image using DALL-E with the dedicated image client
    const imageResponse = await dalleClient.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      size: "1792x1024",
      quality: "standard",
      n: 1,
    });

    const imageUrl = imageResponse.data?.[0]?.url;

    if (!imageUrl) {
      throw new Error("No image URL returned from DALL-E");
    }

    console.log("✅ Image generated successfully");

    return res.status(200).json({
      success: true,
      data: {
        imageUrl,
        filename: filename || "generated-image.jpg",
      },
    });
  } catch (error: any) {
    console.error("❌ All image generation methods failed:", error);

    // Final fallback: Use Picsum placeholder image
    const placeholderImageUrl = "https://picsum.photos/1200/600?random=1";

    return res.status(200).json({
      success: true,
      data: {
        imageUrl: placeholderImageUrl,
        filename: req.body.filename || "placeholder-image.jpg",
        isPlaceholder: true,
      },
    });
  }
};

export const publishToBaseHub = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { title, description, content, imageUrl } = req.body;

    if (!title || !description || !content || !imageUrl) {
      return res.status(400).json({
        message: "Title, description, content, and imageUrl are required",
      });
    }

    // For now, we'll return a success response since we don't have the BaseHub integration set up
    return res.status(200).json({
      success: true,
      message: "Blog post published successfully (placeholder)",
      data: {
        title,
        description,
        content,
        imageUrl,
      },
    });
  } catch (error: any) {
    console.error("❌ Error publishing to BaseHub:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to publish blog post",
      error: error.message,
    });
  }
};
