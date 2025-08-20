# Blog Management Setup

This document describes how to set up the blog management feature that allows users to generate and publish AI-powered blog posts to BaseHub CMS directly from research reports.

## Features

- **Research Report Integration**: Generate blog posts directly from research reports in the Research Reports page
- **AI Content Generation**: Convert research reports into blog posts using OpenAI with improved prompts
- **Image Generation**: Create hero images using GPT Image 1 and DALL-E 3 with automatic S3 upload
- **BaseHub Publishing**: Directly publish to BaseHub CMS with proper image handling
- **One-Click Workflow**: Complete blog generation and publishing in a single streamlined process
- **Author Management**: Automatically assign one of four team members as authors

## Backend Setup

### Environment Variables

Add the following environment variables to your backend `.env` file:

```env
# BaseHub Configuration
BASEHUB_API_URL=https://api.basehub.com/graphql
BASEHUB_TOKEN=your_basehub_token_here
POSTS_COLLECTION_ID=dKrosxXlaGpnZCrAbHxlX
BASEHUB_IMAGE_COMPONENT_ID=AAzuzbz0jSbfwGJYvtMu3

# OpenAI Configuration (required for content and image generation)
OPENAI_IMAGE_API_KEY=your_openai_api_key_here
AZURE_OPENAI_API_KEY=your_azure_openai_api_key
AZURE_OPENAI_ENDPOINT=your_azure_openai_endpoint
AZURE_OPENAI_DEPLOYMENT=your_azure_openai_deployment
AZURE_OPENAI_API_VERSION=your_azure_openai_api_version

# AWS S3 Configuration (required for image storage)
S3_BUCKET_NAME=your_s3_bucket_name
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=your_aws_region
```

### Image Generation & Storage

The blog system now uses a **three-tier approach** for image generation and storage:

1. **OpenAI GPT Image 1 (Primary)** - Uses the advanced `gpt-image-1` model

   - Automatically available when `OPENAI_IMAGE_API_KEY` is set
   - Generates high-quality images from text prompts
   - Images are automatically uploaded to S3 for reliable storage

2. **DALL-E 3 (Fallback)** - Direct DALL-E 3 API access

   - Uses the same `OPENAI_IMAGE_API_KEY`
   - Provides high-quality image generation as a backup
   - Images are also uploaded to S3

3. **S3 Storage** - All generated images are stored in your S3 bucket

   - Images are uploaded to `blog-images/` folder with unique timestamps
   - Public URLs are generated for reliable BaseHub integration
   - Eliminates the "placeholder" issue in BaseHub

4. **Picsum Placeholder (Final Fallback)** - Beautiful placeholder images
   - If all AI image generation methods fail, uses [Picsum](https://picsum.photos/) for professional placeholder images
   - Ensures every blog post has a visually appealing hero image

### Author Management

The system automatically assigns one of four team members as authors for each blog post:

- **Harsha Vankayalapati** (ID: B7hR0AMxxh8HyBOLRKfiU)
- **Rui Wang** (ID: OVx_pLwKj00xoAf6kXSSf)
- **Fangfang Tan** (ID: Vxo_NPdrUf0Yzob_Im3_d)
- **Matthew Wilmer** (ID: UM7cOq3RuKX9OPKqYRt-2)

Authors are randomly selected for each post to distribute content across the team.

## API Endpoints

The blog management feature adds the following API endpoints:

- `POST /api/blog/generate` - Generate blog post content with improved AI prompts
- `POST /api/blog/generate-image` - Generate hero image with S3 upload
- `POST /api/blog/publish` - Publish to BaseHub with proper image handling

## Frontend Setup

The blog generation feature is integrated into the Research Reports page (`/research-reports`) in the customer portal.

### Navigation

The blog generation feature is accessible via action buttons on each research report. Look for the gradient-styled blog generation button (Edit3 icon) next to the archive button on each report.

## BaseHub Configuration

### Collection Structure

The blog posts are created in BaseHub with the following improved structure:

```json
{
  "title": "Blog Post Title",
  "description": "SEO description",
  "publishedAt": "2024-01-01T00:00:00.000Z",
  "body": {
    "format": "markdown",
    "value": "# Blog Post Content..."
  },
  "authors": ["random_author_id"],
  "image": {
    "light": {
      "url": "https://your-s3-bucket.s3.region.amazonaws.com/blog-images/timestamp-filename.png",
      "fileName": "hero-image.png"
    }
  }
}
```

### Required BaseHub Setup

1. **Collection ID**: Update the `POSTS_COLLECTION_ID` environment variable with your BaseHub posts collection ID
2. **Author References**: The system automatically uses the correct author IDs from your BaseHub setup
3. **Image Component**: Update the `mainComponentId` for the image component (`AAzuzbz0jSbfwGJYvtMu3`)

## Content Quality Improvements

### AI Prompt Enhancements

The new system addresses previous content quality issues:

1. **Natural Language**: Prompts are designed to generate human-like, conversational content
2. **Practical Examples**: Focus on actionable insights rather than generic AI content
3. **Proper Structure**: Clear H2 and H3 headings without excessive nesting
4. **Internal Linking**: Natural integration of AgentWeb service links
5. **Consistent CTAs**: Standardized call-to-action for all blog posts

### Table Formatting

- Tables are now properly formatted in markdown
- Content avoids overly AI-generated patterns
- Focus on practical, founder-focused insights

## Usage

### Step-by-Step Workflow

1. **Start Blog Generation**:

   - Navigate to the Research Reports page (`/research-reports`) in the customer portal
   - Find a research report you want to convert to a blog post
   - Click the blog generation button (Edit3 icon) next to the archive button

2. **Configure Options**:

   - Select tone (Professional, Casual, Technical, Conversational)
   - Choose length (Short, Medium, Long)
   - Optionally add keywords
   - Click "Generate Content"

3. **Preview & Edit**:

   - Review the generated hero image (now properly stored in S3)
   - Edit the blog post title if needed
   - Modify the SEO description
   - Review and edit the markdown content
   - Click "Publish to BaseHub" when satisfied

4. **Publishing**:
   - The system automatically publishes the blog post to BaseHub
   - Images are properly linked from S3 (no more placeholders)
   - Author is automatically assigned
   - Receive confirmation when complete

### Features

- **Multi-step workflow**: Generate → Preview → Publish
- **Editable content**: Modify title, description, and content before publishing
- **Hero image preview**: See the generated image before publishing
- **Content extraction**: Automatically extracts insights from research reports
- **Markdown editing**: Full control over blog post content
- **S3 image storage**: Reliable image hosting and BaseHub integration

## Error Handling

The system includes comprehensive error handling for:

- Missing environment variables
- AI generation failures
- Image generation failures
- S3 upload failures
- BaseHub publishing errors
- Network connectivity issues

## Security

- All API endpoints require authentication
- BaseHub token is stored securely in environment variables
- Generated content is validated before publishing
- S3 bucket access is controlled via IAM policies

## Development

To extend the blog management feature:

1. **Backend**: Modify `/backend/src/controllers/blog.ts`
2. **Frontend**: Modify `/customer-portal/src/pages/ResearchReports.tsx` (blog integration)
3. **Routes**: Update `/backend/src/routes/blog.ts`

## Troubleshooting

### Common Issues

1. **BaseHub Token Missing**: Ensure `BASEHUB_TOKEN` is set in environment variables
2. **Collection ID Wrong**: Verify `POSTS_COLLECTION_ID` matches your BaseHub collection
3. **Image Generation Fails**: Check `OPENAI_IMAGE_API_KEY` is set correctly
4. **S3 Upload Fails**: Verify AWS credentials and bucket permissions
5. **Content Generation Fails**: Verify Azure OpenAI configuration

### Logs

Check the backend logs for detailed error messages:

```bash
cd backend && npm run dev
```

The blog controller logs all major operations with emoji prefixes for easy identification:

- 🚀 Publishing blog post to BaseHub
- 📤 Uploading image to S3
- ✅ Image uploaded to S3
- ✅ Blog post published successfully to BaseHub

### Image Issues

If images still show as placeholders in BaseHub:

1. Check S3 bucket permissions (public read access required)
2. Verify the image URL is accessible from BaseHub's servers
3. Check that the `BASEHUB_IMAGE_COMPONENT_ID` matches your BaseHub image component
4. Ensure the image format is supported (PNG, JPG, WebP)

**Important**: The `BASEHUB_IMAGE_COMPONENT_ID` must match the component ID of the image field in your BaseHub blog post schema. The default value `AAzuzbz0jSbfwGJYvtMu3` is from the working Python example - you may need to update this to match your specific BaseHub setup.

## Performance

- Images are automatically optimized and stored in S3
- Content generation uses efficient Azure OpenAI endpoints
- S3 uploads are asynchronous and don't block the publishing process
- Fallback mechanisms ensure reliable operation even with service failures
