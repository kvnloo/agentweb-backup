import axios from 'axios';
import { getWebflowConfig, getWordPressConfig } from '../controllers/blog';
import { getSecret } from '../utils/secretsManager';

export type BlogPublishStatus = 'draft' | 'published';

export type BlogPublishInput = {
  title: string;
  slug: string;
  summary: string;
  bodyHtml: string;
  heroImageUrl?: string;
  author?: string;
  categories: string[];
  status: BlogPublishStatus;
  publishedAt: string;
};

export type BlogPublishContext = {
  userId: string;
  sessionId: string;
};

export interface BlogPublisher {
  id: 'payload' | 'webflow' | 'wordpress' | 'basehub';
  canPublish(ctx: BlogPublishContext): Promise<boolean>;
  publish(input: BlogPublishInput, ctx: BlogPublishContext): Promise<any>;
}

type PayloadConfig = {
  endpoint: string;
  secret: string;
};

async function getPayloadConfig(): Promise<PayloadConfig | null> {
  try {
    const env = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const payloadSecretJson = await getSecret(`${env}/AgentWeb/PayloadCMS`);
    if (!payloadSecretJson) return null;

    const parsed = JSON.parse(payloadSecretJson);
    if (!parsed.PAYLOAD_PUBLISH_SECRET) return null;

    return {
      endpoint: parsed.PAYLOAD_PUBLISH_ENDPOINT || 'https://www.agentweb.pro/api/publish-post',
      secret: parsed.PAYLOAD_PUBLISH_SECRET,
    };
  } catch (error) {
    console.warn('AgentMode: Could not load PayloadCMS secret, falling back to configured user CMS:', error);
    return null;
  }
}

function mapPayloadCategory(categories: string[]) {
  const categoryMap: Record<string, string> = {
    'AI in Marketing': 'AI in Marketing',
    'Founder Playbooks': 'Founder Playbooks',
    'Growth Tips': 'Growth Tips',
    'Thought Leadership': 'Thought Leadership',
    'Other': 'Other',
    'Alternatives': 'Alternatives',
    'Listicles': 'Listicles',
    'User Guide': 'User Guide',
    'Case Studies': 'Case Studies',
  };

  return categories.length > 0 ? (categoryMap[categories[0]] || 'Other') : 'Other';
}

function mapPayloadAuthor(author?: string) {
  return author?.toLowerCase().includes('rui') ? 'rui'
    : author?.toLowerCase().includes('harsha') ? 'harsha'
      : author?.toLowerCase().includes('fangfang') ? 'fangfang'
        : author?.toLowerCase().includes('matthew') ? 'matthew'
          : 'emma';
}

export class PayloadBlogPublisher implements BlogPublisher {
  id = 'payload' as const;

  async canPublish(): Promise<boolean> {
    return Boolean(await getPayloadConfig());
  }

  async publish(input: BlogPublishInput): Promise<any> {
    const config = await getPayloadConfig();
    if (!config) {
      return {
        success: false,
        message: 'Payload CMS publish secret is not configured.',
        error: 'Payload CMS not configured',
      };
    }

    const payloadResponse = await axios.post(
      config.endpoint,
      {
        title: input.title,
        slug: input.slug,
        summary: input.summary,
        bodyHtml: input.bodyHtml,
        category: mapPayloadCategory(input.categories),
        author: mapPayloadAuthor(input.author),
        featuredImageUrl: input.heroImageUrl,
        publishedAt: input.publishedAt,
        status: input.status,
      },
      {
        headers: { 'Authorization': `Bearer ${config.secret}` },
        timeout: 30000,
      }
    );

    console.log(`AgentMode: Blog article published successfully to Payload CMS as ${input.status}`);

    return {
      success: true,
      message: `Blog article published successfully to Payload CMS as ${input.status}`,
      data: {
        title: input.title,
        slug: input.slug,
        status: input.status,
        cmsType: 'Payload',
        url: `/blog/${input.slug}`,
        cmsResponse: payloadResponse.data,
      }
    };
  }
}

export class WebflowBlogPublisher implements BlogPublisher {
  id = 'webflow' as const;

  async canPublish(): Promise<boolean> {
    return true;
  }

  async publish(input: BlogPublishInput, ctx: BlogPublishContext): Promise<any> {
    const { apiToken, siteId, collectionId, fieldMappings, categories: categoryMapping } = await getWebflowConfig(ctx.userId);

    const cmsItemData: any = {
      fieldData: {
        name: input.title,
        slug: input.slug,
      }
    };

    if (input.status === 'draft') {
      cmsItemData.fieldData._archived = false;
      cmsItemData.fieldData._draft = true;
    } else {
      cmsItemData.isArchived = false;
      cmsItemData.isDraft = false;
    }

    const cleanBodyHtml = input.bodyHtml.replace(/\n/g, '').replace(/\r/g, '');

    if (fieldMappings?.summary) {
      cmsItemData.fieldData[fieldMappings.summary] = input.summary;
    }

    if (fieldMappings?.body) {
      cmsItemData.fieldData[fieldMappings.body] = cleanBodyHtml;
    }

    if (input.heroImageUrl && fieldMappings?.image) {
      cmsItemData.fieldData[fieldMappings.image] = input.heroImageUrl;
    }

    if (input.author) {
      const authorField = fieldMappings?.author || 'author';
      cmsItemData.fieldData[authorField] = input.author;
    }

    const categoryField = fieldMappings?.category || 'categories';
    const isSingleReference = !categoryField.endsWith('ies') && !categoryField.endsWith('s');

    console.log(`AgentMode: Category field "${categoryField}" detected as ${isSingleReference ? 'single reference' : 'multi-reference'}`);

    let categoryIds: string[] = [];
    const invalidCategories: string[] = [];

    if (input.categories && input.categories.length > 0 && !categoryMapping) {
      return {
        success: false,
        message: 'Category mapping is not configured in secrets manager. Please configure the "categories" field in your Webflow secrets with category name-to-ID mappings.',
        error: 'Categories mapping required but not configured',
        invalidCategories: input.categories,
        availableCategories: [],
      };
    }

    if (input.categories && input.categories.length > 0 && categoryMapping) {
      categoryIds = input.categories
        .map(name => {
          const id = categoryMapping[name];
          if (!id) {
            console.warn(`AgentMode: Category name "${name}" not found in mapping, skipping`);
            invalidCategories.push(name);
            return null;
          }
          return id;
        })
        .filter((id): id is string => id !== null);

      if (input.categories.length > 0 && categoryIds.length === 0) {
        const availableCategories = Object.keys(categoryMapping);
        return {
          success: false,
          message: `All provided category names are invalid: ${invalidCategories.join(', ')}. Available categories: ${availableCategories.join(', ')}`,
          error: 'Invalid category names',
          invalidCategories,
          availableCategories,
        };
      }
    }

    if (isSingleReference) {
      cmsItemData.fieldData[categoryField] = categoryIds.length > 0 ? categoryIds[0] : '';
      if (categoryIds.length > 1) {
        console.warn(`AgentMode: Field "${categoryField}" is a single reference but ${categoryIds.length} categories provided. Using only the first one: ${categoryIds[0]}`);
      }
    } else {
      cmsItemData.fieldData[categoryField] = categoryIds;
    }

    if (invalidCategories.length > 0 && categoryIds.length > 0) {
      const availableCategories = categoryMapping ? Object.keys(categoryMapping) : [];
      console.warn(`AgentMode: Some invalid categories were skipped: ${invalidCategories.join(', ')}. Valid categories: ${availableCategories.join(', ')}`);
    }

    if (input.status === 'published' && categoryIds.length === 0) {
      const availableCategories = categoryMapping ? Object.keys(categoryMapping) : [];
      const fieldType = isSingleReference ? 'category (single reference)' : 'categories (multi-reference)';
      let errorMessage = `Cannot publish article without ${fieldType}. Please provide at least one category when status is "published".`;

      if (invalidCategories.length > 0) {
        errorMessage = `Invalid category names provided: ${invalidCategories.join(', ')}.`;
      }

      if (availableCategories.length > 0) {
        errorMessage += ` Available categories: ${availableCategories.join(', ')}`;
      } else {
        errorMessage += ' No category mapping found in configuration.';
      }

      if (isSingleReference && input.categories.length > 1) {
        errorMessage += ` Note: Field "${categoryField}" is a single reference - only the first valid category will be used.`;
      }

      return {
        success: false,
        message: errorMessage,
        error: 'Categories required for published articles',
        invalidCategories,
        availableCategories,
        fieldType: isSingleReference ? 'single-reference' : 'multi-reference',
      };
    }

    const headers = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'accept-version': '2.0.0',
    };

    const endpoint = input.status === 'published'
      ? `https://api.webflow.com/v2/collections/${collectionId}/items/live?skipInvalidFiles=true`
      : `https://api.webflow.com/v2/sites/${siteId}/collections/${collectionId}/items`;

    console.log(`AgentMode: Publishing to Webflow ${input.status === 'published' ? 'live' : 'draft'} endpoint: ${endpoint}`);

    try {
      const response = await axios.post(
        endpoint,
        cmsItemData,
        { headers }
      );

      console.log(`AgentMode: Blog article published successfully to Webflow as ${input.status}`);

      const responseData = response.data as any;
      const sanitizedResponse = responseData && typeof responseData === 'object'
        ? { ...responseData }
        : responseData;

      if (sanitizedResponse && sanitizedResponse.fieldData && typeof sanitizedResponse.fieldData === 'object') {
        const sanitizedFieldData = { ...sanitizedResponse.fieldData };
        delete sanitizedFieldData['post-body'];
        delete sanitizedFieldData['body'];
        sanitizedResponse.fieldData = sanitizedFieldData;
      }

      return {
        success: true,
        message: `Blog article published successfully to Webflow as ${input.status}`,
        data: {
          title: input.title,
          status: input.status,
          cmsType: 'Webflow',
          cmsResponse: sanitizedResponse,
        }
      };
    } catch (webflowError: any) {
      const errorInfo: any = {
        status: webflowError.response?.status,
        statusText: webflowError.response?.statusText,
      };

      if (webflowError.response?.data) {
        const errorData = webflowError.response.data;

        if (errorData.message) {
          errorInfo.message = errorData.message;
        }

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

      const availableCategories = categoryMapping ? Object.keys(categoryMapping) : [];
      if (availableCategories.length > 0) {
        errorInfo.message = `${errorInfo.message || 'Webflow API error'}. Available categories: ${availableCategories.join(', ')}`;
        errorInfo.availableCategories = availableCategories;
      }

      if (errorInfo.message && (
        errorInfo.message.includes('File size limit') ||
        errorInfo.message.includes('failed to import') ||
        errorInfo.message.includes('image') && errorInfo.message.includes('too large')
      )) {
        errorInfo.message += '. SUGGESTION: Use repair_blog_article function to fix image size issues before retrying.';
        errorInfo.repairSuggested = true;
      }

      if (errorInfo.details && errorInfo.details.length > 0) {
        const errorDetails = errorInfo.details
          .map((d: any) => `${d.param}: ${d.description}`)
          .join(', ');
        console.error(`AgentMode: Webflow API error (${errorInfo.status}): ${errorDetails}`);
      } else {
        console.error(`AgentMode: Webflow API error (${errorInfo.status}): ${errorInfo.message}`);
      }

      return {
        success: false,
        message: errorInfo.message || `Webflow API error: ${errorInfo.status} ${errorInfo.statusText}`,
        error: 'Webflow API validation error',
        availableCategories: errorInfo.availableCategories || [],
        repairSuggested: errorInfo.repairSuggested || false,
      };
    }
  }
}

export class WordPressBlogPublisher implements BlogPublisher {
  id = 'wordpress' as const;

  async canPublish(): Promise<boolean> {
    return true;
  }

  async publish(input: BlogPublishInput, ctx: BlogPublishContext): Promise<any> {
    const wpConfig = await getWordPressConfig(ctx.userId);
    const authHeader = 'Basic ' + Buffer.from(`${wpConfig.username}:${wpConfig.applicationPassword}`).toString('base64');

    let featuredMediaId: number | undefined;
    if (input.heroImageUrl) {
      try {
        console.log('AgentMode: Uploading featured image to WordPress...');
        const imgResponse = await axios.get(input.heroImageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const imageBuffer = Buffer.from(imgResponse.data as ArrayBuffer);
        const contentType = imgResponse.headers['content-type'] || 'image/png';
        const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
        const filename = `blog-hero-${Date.now()}.${ext}`;

        const mediaResponse = await axios.post(
          `${wpConfig.siteUrl}/wp-json/wp/v2/media`,
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
        console.log('AgentMode: Featured image uploaded, media ID:', featuredMediaId);
      } catch (imgError: any) {
        console.error('AgentMode: Failed to upload featured image to WordPress:', imgError.message);
      }
    }

    const wpCategoryIds: number[] = [];
    const invalidCategories: string[] = [];
    if (input.categories && input.categories.length > 0 && wpConfig.categories) {
      for (const name of input.categories) {
        const id = wpConfig.categories[name];
        if (id) {
          wpCategoryIds.push(id);
        } else {
          invalidCategories.push(name);
        }
      }
    }

    const wpStatus = input.status === 'published' ? 'publish' : 'draft';
    const postData: any = {
      title: input.title,
      content: input.bodyHtml,
      excerpt: input.summary,
      status: wpStatus,
    };

    if (featuredMediaId) {
      postData.featured_media = featuredMediaId;
    }

    if (wpCategoryIds.length > 0) {
      postData.categories = wpCategoryIds;
    }

    console.log(`AgentMode: Publishing to WordPress as ${wpStatus}...`);

    try {
      const response = await axios.post(
        `${wpConfig.siteUrl}/wp-json/wp/v2/posts`,
        postData,
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const responseData = response.data as any;
      console.log(`AgentMode: Blog article published successfully to WordPress as ${wpStatus}`);

      return {
        success: true,
        message: `Blog article published successfully to WordPress as ${input.status}`,
        data: {
          title: input.title,
          status: input.status,
          cmsType: 'WordPress',
          postId: responseData.id,
          postUrl: responseData.link,
          ...(invalidCategories.length > 0 ? {
            warning: `Some categories were not found: ${invalidCategories.join(', ')}`,
            availableCategories: wpConfig.categories ? Object.keys(wpConfig.categories) : [],
          } : {})
        }
      };
    } catch (wpError: any) {
      const errorInfo: any = {
        status: wpError.response?.status,
        statusText: wpError.response?.statusText,
      };
      if (wpError.response?.data) {
        errorInfo.message = wpError.response.data.message || wpError.message;
        errorInfo.code = wpError.response.data.code;
      } else {
        errorInfo.message = wpError.message;
      }

      console.error(`AgentMode: WordPress API error (${errorInfo.status}): ${errorInfo.message}`);

      return {
        success: false,
        message: errorInfo.message || `WordPress API error: ${errorInfo.status} ${errorInfo.statusText}`,
        error: 'WordPress API error',
        availableCategories: wpConfig.categories ? Object.keys(wpConfig.categories) : [],
      };
    }
  }
}

export class BasehubBlogPublisher implements BlogPublisher {
  id = 'basehub' as const;

  async canPublish(): Promise<boolean> {
    return true;
  }

  async publish(): Promise<any> {
    return {
      success: false,
      message: 'Basehub CMS is not supported for publish_blog_article function. Please use the Research Reports page to publish to Basehub.',
      error: 'Basehub not supported',
    };
  }
}

export async function publishWithResolvedBlogPublisher(
  input: BlogPublishInput,
  ctx: BlogPublishContext
): Promise<any> {
  const payloadPublisher = new PayloadBlogPublisher();
  if (await payloadPublisher.canPublish()) {
    return payloadPublisher.publish(input);
  }

  const { userDb } = await import('./db');
  const user = await userDb.getUserById(ctx.userId);

  if (!user) {
    throw new Error('User not found');
  }

  const cmsType = user.cmsType;

  if (!cmsType) {
    return {
      success: false,
      message: 'CMS Type is not configured for this user. Please contact an administrator to set up CMS publishing.',
      error: 'CMS Type not configured',
    };
  }

  console.log('AgentMode: User CMS Type:', cmsType);

  const publisher = createConfiguredCmsPublisher(cmsType);
  return publisher.publish(input, ctx);
}

function createConfiguredCmsPublisher(cmsType: string): BlogPublisher {
  switch (cmsType) {
    case 'Webflow':
      return new WebflowBlogPublisher();
    case 'WordPress':
      return new WordPressBlogPublisher();
    case 'Basehub':
      return new BasehubBlogPublisher();
    default:
      return {
        id: 'basehub',
        async canPublish() {
          return false;
        },
        async publish() {
          return {
            success: false,
            message: `Unsupported CMS Type: ${cmsType}. Supported types are 'Basehub', 'Webflow', and 'WordPress'.`,
            error: 'Unsupported CMS Type',
          };
        },
      };
  }
}
