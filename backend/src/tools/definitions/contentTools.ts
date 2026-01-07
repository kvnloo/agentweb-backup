/**
 * Content Tools Definitions
 * 
 * Tools for content creation: blog articles, images, videos, social media posts.
 */

import { ToolDefinition } from '../types';

export const contentTools: ToolDefinition[] = [
  {
    name: 'create_blog_article',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Create a complete blog article with content, images, and HTML file. Generates blog content using AI, creates a hero image, and produces a complete HTML file uploaded to S3.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The main topic or subject of the blog article'
          },
          keywords: {
            type: 'string',
            description: 'Comma-separated keywords to include in the article for SEO',
            default: ''
          },
          tone: {
            type: 'string',
            description: 'The tone of voice for the article',
            enum: ['professional', 'casual', 'friendly', 'authoritative', 'conversational'],
            default: 'professional'
          },
          length: {
            type: 'string',
            description: 'The desired length of the article',
            enum: ['short', 'medium', 'long'],
            default: 'medium'
          },
          researchContext: {
            type: 'string',
            description: 'Optional research context or background information to include in the article',
            default: ''
          },
          requirements: {
            type: 'string',
            description: 'Specific requirements for the blog article (e.g., internal links, CTAs, branding guidelines)',
            default: ''
          },
          style: {
            type: 'string',
            description: 'The writing style of the blog article. Use "substack" for a personal, newsletter-like writing style with first-person perspective, engaging hooks, and conversational tone. Use "default" for standard blog post style.',
            enum: ['default', 'substack'],
            default: 'default'
          },
          deep_research: {
            type: 'boolean',
            description: 'When true, performs Gemini Deep Research for comprehensive information and includes 3-5 inline images. When false, uses standard content generation with hero image only. Takes several minutes when enabled.',
            default: false
          }
        },
        required: ['topic']
      }
    }
  },
  {
    name: 'publish_blog_article',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: "Publish a blog article to CMS (Basehub or Webflow) based on the user's configured CMS type. Takes the title, description, hero image URL, and blog HTML URL from a previously created blog article (via create_blog_article), extracts the HTML body content, then publishes to the appropriate CMS.",
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the blog article'
          },
          description: {
            type: 'string',
            description: 'The description/meta description of the blog article'
          },
          hero_image_url: {
            type: 'string',
            description: 'The URL of the hero image for the blog article'
          },
          blog_html_url: {
            type: 'string',
            description: 'The URL of the HTML file created by create_blog_article function'
          }
        },
        required: ['title', 'description', 'hero_image_url', 'blog_html_url']
      }
    }
  },
  {
    name: 'generate_image',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Generate or edit images using AI image generation models. Supports both text-to-image generation and image editing with input images.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of the image to generate or edit, including style, content, and visual specifications'
          },
          filename: {
            type: 'string',
            description: 'Name for the generated image file (should include .png extension)'
          },
          size: {
            type: 'string',
            description: 'Image size or ratio. For GPT models: 1024x1024, 1536x1024, 1024x1536, or auto. For Runway models: use ratio format like 1344:768, 768:1344, etc. Use "auto" for automatic sizing.',
            default: 'auto'
          },
          quality: {
            type: 'string',
            description: 'Image quality setting (low, medium, high). Defaults to medium if not specified.',
            enum: ['low', 'medium', 'high'],
            default: 'medium'
          },
          inputImages: {
            type: 'array',
            description: 'List of input image URLs to use for image editing. Leave empty for text-to-image generation.',
            items: {
              type: 'string'
            }
          },
          imageModel: {
            type: 'string',
            description: 'Optional: Specific image generation model to use.',
            enum: ['gpt-image-1', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gen4_image', 'gemini_2.5_flash']
          }
        },
        required: ['prompt', 'filename']
      }
    }
  },
  {
    name: 'generate_video',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Generate videos using AI video generation models. Supports text-to-video generation and video generation with optional start and end frames for interpolation.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of the video to generate, including style, content, motion, and visual specifications'
          },
          filename: {
            type: 'string',
            description: 'Name for the generated video file (should include .mp4 extension, will be added automatically if missing)'
          },
          videoModel: {
            type: 'string',
            description: 'Optional: Specific video generation model to use. Currently supports: veo-3.1-generate-preview (by Google). Defaults to veo-3.1-generate-preview if not specified.',
            enum: ['veo-3.1-generate-preview']
          },
          startFrame: {
            type: 'string',
            description: 'Optional: URL of the first frame image to use as the starting point for video generation.'
          },
          endFrame: {
            type: 'string',
            description: 'Optional: URL of the last frame image to use as the ending point for video generation.'
          }
        },
        required: ['prompt', 'filename']
      }
    }
  },
  {
    name: 'create_social_media_posts',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Create a list of social media posts and generate an HTML file containing all posts. Each post includes type, rich text content, and optional image URL. The output is an HTML file stored in S3.',
      parameters: {
        type: 'object',
        properties: {
          posts: {
            type: 'array',
            description: 'Array of social media posts to create',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['linkedin', 'x/twitter', 'instagram', 'facebook', 'custom'],
                  description: 'The social media platform type for this post'
                },
                content: {
                  type: 'string',
                  description: 'Rich text content for the post (supports markdown formatting). Do not include image URLs in the content text.'
                },
                image_url: {
                  type: 'string',
                  description: 'Optional image URL for posts that include images'
                }
              },
              required: ['type', 'content']
            }
          }
        },
        required: ['posts']
      }
    }
  },
  {
    name: 'post_on_connected_account',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Create a post on a connected social media account',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'The connected account ID' },
          content: { type: 'string', description: 'Post text content. Length limits depend on the specific platform.' },
          media_urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional URLs of images/videos to attach'
          }
        },
        required: ['account_id', 'content']
      }
    }
  },
  {
    name: 'remove_c2pa_from_image',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Remove C2PA metadata from an image by downloading it from a URL, stripping metadata, and uploading the cleaned image to S3. Returns the new S3 URL.',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description: 'URL of the image to process (can be S3 URL, data URL, or any accessible image URL)'
          },
          filename: {
            type: 'string',
            description: 'Optional filename for the cleaned image. If not provided, will generate a filename based on the original URL'
          }
        },
        required: ['image_url']
      }
    }
  },
  {
    name: 'describe_video',
    version: '1.0.0',
    category: 'content',
    schema: {
      description: 'Analyze and describe a video from a URL using Gemini. Use this when the user mentions a video or when you need to understand video content.',
      parameters: {
        type: 'object',
        properties: {
          video_file_url: {
            type: 'string',
            description: 'Video URL to analyze and describe. Include the complete file URL in request.'
          },
          prompt: {
            type: 'string',
            description: 'Custom prompt/instructions for analyzing the video. Specify what aspects to focus on (e.g., key events, narration, visual details, or timing).',
            default: 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.'
          }
        },
        required: ['video_file_url']
      }
    }
  }
];
