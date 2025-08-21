import { Request, Response } from "express";
import { openaiImageService } from "../services/imageGeneration";
import OpenAI from "openai";
import axios from "axios";
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

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

// Initialize AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "us-east-1",
});

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

// Function to upload image to S3
async function uploadImageToS3(
  imageUrl: string,
  filename: string
): Promise<string> {
  try {
    console.log("📤 Uploading image to S3:", filename);

    // Download the image from the generated URL
    console.log("⬇️ Downloading image from AI service...");
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });
    const imageBuffer = Buffer.from(imageResponse.data as ArrayBuffer);
    console.log("✅ Image downloaded successfully");

    // Determine content type
    const contentType = filename.endsWith(".png")
      ? "image/png"
      : filename.endsWith(".jpg")
      ? "image/jpeg"
      : filename.endsWith(".webp")
      ? "image/webp"
      : "image/png";

    // Create unique S3 key
    const s3Key = `blog-images/${Date.now()}-${filename}`;
    console.log("🔑 S3 Key:", s3Key);

    // Upload to S3
    console.log("☁️ Uploading to AWS S3...");
    const uploadResult = await s3
      .upload({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: s3Key,
        Body: imageBuffer,
        ContentType: contentType,
      })
      .promise();

    console.log("✅ Image uploaded to S3:", uploadResult.Location);
    return uploadResult.Location;
  } catch (error) {
    console.error("❌ Error uploading image to S3:", error);
    throw error;
  }
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

    // Improved blog prompt for better content generation
    let blogPrompt = `You are an expert marketing strategist and content writer for AgentWeb, an AI marketing agency. Your audience is early-stage (pre-seed to Series A) B2B SaaS founders who are technical and product-focused.

    Create a high-quality, engaging blog post about: ${topic}
    
    Requirements:
    - Tone: ${tone} (be conversational but professional, avoid overly formal language)
    - Length: ${length} (400-800 words for short, 800-1200 for medium, 1200-2000 for long)
    - Keywords to naturally include: ${keywords || "relevant industry keywords"}
    
    Content Guidelines:
    1. Write in a natural, human voice - avoid AI-generated patterns
    2. Use practical examples and actionable insights
    3. Structure with clear H2 and H3 headings (no H4+)
    4. Include relevant internal links naturally:
       - Link to https://www.agentweb.pro when discussing done-for-you marketing services
       - Link to https://www.agentweb.pro/build for self-service options
       - Link to https://www.agentweb.pro/pricing for cost discussions
    5. End with this exact CTA: "Ready to put your marketing on autopilot? [Book a call with Harsha](https://calendly.com/harsha-agentweb/30min) to walk through your current marketing workflow and see how AgentWeb can help you scale."
    6. If research context is provided, use it as a foundation but rewrite in your own voice
    7. Avoid generic AI language - be specific, use real examples, and sound like a human expert
    8. **NO TABLES** - Tables don't render well in our CMS. Use bullet points, numbered lists, or paragraphs instead

    Format the response as JSON with this structure:
    {
      "title": "Compelling, SEO-optimized title",
      "description": "1-2 sentence meta description for SEO",
      "content": "Full blog content in markdown format",
      "imagePrompt": "Detailed visual description for hero image (avoid text, be conceptual)"
    }`;

    // Add research context if provided
    if (researchContext) {
      blogPrompt += `
    
    Research Context (use as foundation but rewrite naturally):
    ${researchContext}`;
    }

    // Generate blog post content using LLM
    console.log("🧠 Analyzing topic and crafting content strategy...");
    console.log("💭 Generating engaging, founder-focused content...");

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
        messages: [
          {
            role: "system",
            content:
              "You are a seasoned marketing strategist and content writer. Write naturally, avoid AI patterns, and focus on providing real value to startup founders. Never create tables - use bullet points, numbered lists, or paragraphs instead. Always respond with valid JSON.",
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

      console.log("✅ Content generation complete! Processing AI response...");

      // Parse the JSON response
      let blogData;
      try {
        const cleanedContent = responseContent
          .replace(/```json\s*|\s*```/g, "")
          .trim();
        blogData = JSON.parse(cleanedContent);
      } catch (parseError) {
        // Fallback: create a structured response from the raw content
        blogData = {
          title: `Insights on ${topic}`,
          description: `Key insights and strategies for ${topic}, tailored for early-stage startup founders looking to scale their marketing efforts.`,
          content: `# Insights on ${topic}

This article provides practical insights on ${topic} for startup founders.

## Key Takeaways

- Understanding the fundamentals of ${topic}
- Practical strategies for implementation
- Common pitfalls to avoid

## Conclusion

Ready to put your marketing on autopilot? [Book a call with Harsha](https://calendly.com/harsha-agentweb/30min) to walk through your current marketing workflow and see how AgentWeb can help you scale.`,
          imagePrompt: `A modern, professional business illustration representing ${topic}. Clean design with relevant visual elements, suitable for a business blog. No text, conceptual representation.`,
        };
      }

      // Validate the response structure
      if (!blogData.title || !blogData.content) {
        throw new Error(
          "LLM response missing required fields (title, content)"
        );
      }

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

    // Try OpenAI image generation first (uses gpt-image-1)
    console.log("🤖 Attempting OpenAI GPT Image 1 generation...");
    const openaiImageAvailable = await openaiImageService.isAvailable();

    if (openaiImageAvailable) {
      console.log("🔧 Using OpenAI API image generation (gpt-image-1)...");

      const openaiResult = await openaiImageService.generateImage({
        prompt: prompt,
        size: "1536x1024",
        quality: "medium",
        filename: filename || "generated-blog-image.png",
      });

      if (openaiResult.success && openaiResult.imageUrl) {
        console.log("✅ Image generated successfully via OpenAI API");
        console.log("📤 Initiating S3 upload process...");

        // Upload to S3 and return S3 URL
        try {
          const s3Url = await uploadImageToS3(
            openaiResult.imageUrl,
            openaiResult.filename || filename
          );
          console.log("✅ S3 upload completed successfully!");
          console.log("🔗 Final image URL:", s3Url);
          console.log("---");
          return res.status(200).json({
            success: true,
            data: {
              imageUrl: s3Url,
              filename:
                openaiResult.filename || filename || "generated-blog-image.png",
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
              imageUrl: openaiResult.imageUrl,
              filename:
                openaiResult.filename || filename || "generated-blog-image.png",
            },
          });
        }
      } else {
        console.warn(
          "⚠️ OpenAI API image generation failed:",
          openaiResult.error
        );
        console.log("🔄 Falling back to alternative generation method...");
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
    console.log("🎯 Using DALL-E 3 model for high-quality image creation...");

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

    console.log("✅ Image generated successfully via DALL-E");
    console.log("📤 Initiating S3 upload process...");

    // Upload to S3 and return S3 URL
    try {
      const s3Url = await uploadImageToS3(
        imageUrl,
        filename || "generated-image.jpg"
      );
      console.log("✅ S3 upload completed successfully!");
      console.log("🔗 Final image URL:", s3Url);
      console.log("---");
      return res.status(200).json({
        success: true,
        data: {
          imageUrl: s3Url,
          filename: filename || "generated-image.jpg",
        },
      });
    } catch (uploadError) {
      console.error("S3 upload failed, returning original URL:", uploadError);
      return res.status(200).json({
        success: true,
        data: {
          imageUrl,
          filename: filename || "generated-image.jpg",
        },
      });
    }
  } catch (error: any) {
    console.error("❌ All image generation methods failed:", error);
    console.log(
      "🆘 Activating emergency fallback: Professional placeholder image..."
    );

    // Final fallback: Use Picsum placeholder image
    const placeholderImageUrl = "https://picsum.photos/1200/600?random=1";
    console.log("✅ Placeholder image activated");
    console.log("🔗 Placeholder URL:", placeholderImageUrl);
    console.log("---");

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

    console.log("🚀 Starting BaseHub publishing workflow...");
    console.log("📰 Blog Title:", title);
    console.log("📝 Description length:", description.length, "characters");
    console.log("📄 Content length:", content.length, "characters");
    console.log("🖼️ Image URL:", imageUrl);
    console.log("🖼️ Image Filename:", imageFilename);
    console.log("🔍 Execution ID:", executionId);
    console.log("📊 HTML Report URL:", htmlReportUrl);
    console.log("---");

    const BASEHUB_API_URL =
      process.env.BASEHUB_API_URL || "https://api.basehub.com/graphql";
    const BASEHUB_TOKEN = process.env.BASEHUB_TOKEN || "";
    const POSTS_COLLECTION_ID = "dKrosxXlaGpnZCrAbHxlX";
    const IMAGE_COMPONENT_ID =
      process.env.BASEHUB_IMAGE_COMPONENT_ID || "AAzuzbz0jSbfwGJYvtMu3";

    if (!BASEHUB_TOKEN) {
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
        mainComponentId: IMAGE_COMPONENT_ID, // This is the image component ID from BaseHub
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

    // Debug: Log what we're sending to BaseHub
    console.log(
      "📤 Sending to BaseHub:",
      JSON.stringify(transactionData, null, 2)
    );

    const headers = {
      Authorization: `Bearer ${BASEHUB_TOKEN}`,
      "Content-Type": "application/json",
    };

    console.log("🌐 Initiating BaseHub API request...");
    const response = await axios.post(
      BASEHUB_API_URL,
      { query: mutation, variables },
      { headers }
    );

    // Debug: Log BaseHub response
    console.log("📥 BaseHub Response:", JSON.stringify(response.data, null, 2));

    console.log("✅ Blog post published successfully to BaseHub");

    // Update the existing execution record with publishedToBasehub timestamp
    if (executionId && htmlReportUrl) {
      try {
        const { taskDb } = await import('../services/db');
        
        // Get the existing execution
        const existingExecution = await taskDb.getTaskExecutionById(executionId);
        
        if (existingExecution && existingExecution.userId === userId) {
          console.log("✅ Found existing execution, updating with publishedToBasehub timestamp");
          
          // Find the HTML report file in result_files by URL and add publishedToBasehub timestamp
          const currentResultFiles = existingExecution.result_files || [];
          const updatedResultFiles = currentResultFiles.map((file: any) => {
            if (file.url === htmlReportUrl) {
              // Add publishedToBasehub timestamp to this file
              return {
                ...file,
                publishedToBasehub: new Date().toISOString()
              };
            }
            return file;
          });
          
          // Update the execution with the modified result_files
          await taskDb.updateTaskExecution(executionId, {
            result_files: updatedResultFiles
          });
          
          console.log("✅ publishedToBasehub timestamp added to existing execution record");
        } else {
          console.log("⚠️ Execution not found or access denied, cannot update record");
        }
      } catch (dbError) {
        console.error("⚠️ Failed to update execution record with publishedToBasehub timestamp:", dbError);
        // Don't fail the request if database update fails
      }
    }

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
