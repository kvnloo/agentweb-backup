import { Request, Response } from "express";
import OpenAI from "openai";
import axios from "axios";
import { agentEngineImageService } from "../services/imageGeneration";

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

// Initialize Azure OpenAI client for text generation
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: {
    "api-version": process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
  },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

// Initialize OpenAI client for image generation (DALL-E)
// Check if we have either Azure DALL-E deployment or direct OpenAI API key
let imageClient: OpenAI | null = null;

if (
  process.env.AZURE_OPENAI_DALLE_DEPLOYMENT &&
  process.env.AZURE_OPENAI_API_KEY
) {
  // Use Azure OpenAI DALL-E deployment
  imageClient = new OpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DALLE_DEPLOYMENT}`,
    defaultQuery: {
      "api-version":
        process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
    },
    defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
  });
} else if (process.env.OPENAI_API_KEY) {
  // Use direct OpenAI API for DALL-E
  imageClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} else {
  console.warn(
    "⚠️ No image generation client available. Set AZURE_OPENAI_DALLE_DEPLOYMENT or OPENAI_API_KEY to enable DALL-E image generation."
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

    console.log("🤖 Generating blog post for topic:", topic);

    // Generate blog post content using LLM
    let blogPrompt = `Generate a comprehensive blog post about "${topic}". 
    
    Requirements:
    - Topic: ${topic}
    - Keywords to include: ${keywords || "relevant industry keywords"}
    - Tone: ${tone}
    - Length: ${length} (400-800 words for short, 800-1200 for medium, 1200-2000 for long)`;

    // Add research context if provided
    if (researchContext) {
      blogPrompt += `
    - Source Research: Use the following research report as the foundation for the blog post. Extract key insights, data points, and findings to create an engaging blog post:
    
    ${researchContext}`;
    }

    blogPrompt += `
    
    Please provide:
    1. A compelling title
    2. A brief description (1-2 sentences for SEO)
    3. The full article content in markdown format
    4. A suggested filename for a hero image (descriptive, kebab-case)
    5. A detailed image prompt for generating the hero image
    
    Format the response as JSON with the following structure:
    {
      "title": "Blog Post Title",
      "description": "Brief SEO description",
      "content": "# Blog Post Title\\n\\nFull markdown content...",
      "imageFilename": "descriptive-image-name.jpg",
      "imagePrompt": "Detailed prompt for image generation"
    }`;

    const completion = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a professional content writer who creates engaging, well-structured blog posts. Always respond with valid JSON in the exact format requested.",
        },
        { role: "user", content: blogPrompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const responseContent = completion.choices[0].message.content;
    if (!responseContent) {
      throw new Error("No response from AI");
    }

    // Parse the JSON response
    let blogPostData: BlogPostData;
    try {
      blogPostData = JSON.parse(responseContent);
    } catch (parseError) {
      console.error("Failed to parse AI response as JSON:", responseContent);
      throw new Error("Invalid response format from AI");
    }

    console.log("✅ Blog post generated successfully");

    return res.status(200).json({
      success: true,
      data: blogPostData,
    });
  } catch (error: any) {
    console.error("Error generating blog post:", error);
    return res.status(500).json({
      success: false,
      message: "Error generating blog post",
      error: error.message,
    });
  }
};

export const publishBlogPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { title, description, content, imageUrl, imageFilename } = req.body;

    if (!title || !description || !content) {
      return res
        .status(400)
        .json({ message: "Title, description, and content are required" });
    }

    console.log("🚀 Publishing blog post to BaseHub:", title);

    const BASEHUB_API_URL =
      process.env.BASEHUB_API_URL || "https://api.basehub.com/graphql";
    const BASEHUB_TOKEN = process.env.BASEHUB_TOKEN || "";
    const POSTS_COLLECTION_ID = "dKrosxXlaGpnZCrAbHxlX";

    if (!BASEHUB_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "BaseHub token is not configured",
      });
    }

    // Create the transaction data structure
    const transactionData = {
      type: "create",
      parentId: POSTS_COLLECTION_ID,
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
            value: ["PCMhesaHZ237t05iG8ms6"],
          },
        },
      },
    };

    // Add image if provided
    if (imageUrl && imageFilename) {
      (transactionData.data.value as any).image = {
        type: "instance",
        mainComponentId: "AAzuzbz0jSbfwGJYvtMu3",
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
    }

    const mutation = `
      mutation CreateBlogPost($data: String!) {
        transaction(data: $data)
      }
    `;

    const variables = { data: JSON.stringify(transactionData) };

    const headers = {
      Authorization: `Bearer ${BASEHUB_TOKEN}`,
      "Content-Type": "application/json",
    };

    const response = await axios.post(
      BASEHUB_API_URL,
      { query: mutation, variables },
      { headers }
    );

    console.log("✅ Blog post published successfully to BaseHub");

    return res.status(200).json({
      success: true,
      message: "Blog post published successfully",
      data: {
        basehubResponse: response.data,
      },
    });
  } catch (error: any) {
    console.error("Error publishing blog post:", error);
    return res.status(500).json({
      success: false,
      message: "Error publishing blog post",
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

    console.log("🎨 Generating image with prompt:", prompt);

    // Try agent-engine image generation first (uses gpt-image-1)
    const agentEngineAvailable = await agentEngineImageService.isAvailable();

    if (agentEngineAvailable) {
      console.log("🔧 Using agent-engine image generation (gpt-image-1)...");

      const agentResult = await agentEngineImageService.generateImage({
        prompt: prompt,
        filename: filename || "generated-blog-image.png",
        size: "1024x1024",
        quality: "medium",
      });

      if (agentResult.success && agentResult.imageUrl) {
        console.log("✅ Image generated successfully via agent-engine");
        return res.status(200).json({
          success: true,
          data: {
            imageUrl: agentResult.imageUrl,
            filename:
              agentResult.filename || filename || "generated-blog-image.png",
          },
        });
      } else {
        console.warn(
          "⚠️ Agent-engine image generation failed:",
          agentResult.error
        );
        // Continue to fallback methods
      }
    }

    // Fallback to direct DALL-E if agent-engine fails or isn't available
    if (!imageClient) {
      console.warn("🚫 No image generation methods available");
      return res.status(503).json({
        success: false,
        message:
          "Image generation service not available. Please configure AZURE_OPENAI_DALLE_DEPLOYMENT, OPENAI_API_KEY, or ensure agent-engine is available.",
        error: "No image generation client configured",
      });
    }

    console.log("🔄 Falling back to direct DALL-E image generation...");

    // Generate image using DALL-E with the dedicated image client
    const imageResponse = await imageClient.images.generate({
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
    console.log("🖼️ Using Picsum placeholder as final fallback...");
    const placeholderImageUrl = "https://picsum.photos/1200/600?random=1";

    return res.status(200).json({
      success: true,
      data: {
        imageUrl: placeholderImageUrl,
        filename: req.body.filename || "placeholder-image.jpg",
        isPlaceholder: true,
      },
      message: "Used placeholder image due to generation failure",
    });
  }
};
