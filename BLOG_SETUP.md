# Blog Management Setup

This document describes how to set up the blog management feature that allows users to generate and publish AI-powered blog posts to BaseHub CMS directly from research reports.

## Features

- **Research Report Integration**: Generate blog posts directly from research reports in the Research Reports page
- **AI Content Generation**: Convert research reports into blog posts using OpenAI
- **Image Generation**: Create hero images using GPT Image 1 and DALL-E 3
- **BaseHub Publishing**: Directly publish to BaseHub CMS
- **One-Click Workflow**: Complete blog generation and publishing in a single streamlined process

## Backend Setup

### Environment Variables

Add the following environment variables to your backend `.env` file:

```env
# BaseHub Configuration
BASEHUB_API_URL=https://api.basehub.com/graphql
BASEHUB_TOKEN=your_basehub_token_here
POSTS_COLLECTION_ID=dKrosxXlaGpnZCrAbHxlX

# OpenAI Configuration (required for content and image generation)
OPENAI_IMAGE_API_KEY=your_openai_api_key_here
```

### Image Generation

The blog system now uses **OpenAI's image generation services** with automatic fallback:

1. **GPT Image 1 (Primary)** - Uses the advanced `gpt-image-1` model
   - Automatically available when `OPENAI_IMAGE_API_KEY` is set
   - Generates high-quality images from text prompts
   - Currently supports text-to-image generation only

2. **DALL-E 3 (Fallback)** - Direct DALL-E 3 API access
   - Uses the same `OPENAI_IMAGE_API_KEY`
   - Provides high-quality image generation as a backup

3. **Picsum Placeholder (Final Fallback)** - Beautiful placeholder images
   - If all AI image generation methods fail, uses [Picsum](https://picsum.photos/) for professional placeholder images
   - Ensures every blog post has a visually appealing hero image
   - Uses high-quality stock photography as placeholders

**Note**: 
- Image-to-image editing and multi-image combination features are not currently supported but can be added in the future if needed.
- Filenames are preserved as-is from the frontend request.

### API Endpoints

The blog management feature adds the following API endpoints:

- `POST /api/blog/generate` - Generate blog post content
- `POST /api/blog/generate-image` - Generate hero image
- `POST /api/blog/publish` - Publish to BaseHub

## Frontend Setup

The blog generation feature is integrated into the Research Reports page (`/research-reports`) in the customer portal.

### Navigation

The blog generation feature is accessible via action buttons on each research report. Look for the gradient-styled blog generation button (Edit3 icon) next to the archive button on each report.

## BaseHub Configuration

### Collection Structure

The blog posts are created in BaseHub with the following structure:

```json
{
  "title": "Blog Post Title",
  "description": "SEO description",
  "publishedAt": "2024-01-01T00:00:00.000Z",
  "body": {
    "format": "markdown",
    "value": "# Blog Post Content..."
  },
  "authors": ["author_reference_id"],
  "image": {
    "light": {
      "url": "https://generated-image-url.com/image.jpg",
      "fileName": "hero-image.jpg"
    }
  }
}
```

### Required BaseHub Setup

1. **Collection ID**: Update the `POSTS_COLLECTION_ID` environment variable with your BaseHub posts collection ID
2. **Author Reference**: Update the author reference ID in the blog controller (`PCMhesaHZ237t05iG8ms6`)
3. **Image Component**: Update the `mainComponentId` for the image component (`AAzuzbz0jSbfwGJYvtMu3`)

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

   - Review the generated hero image
   - Edit the blog post title if needed
   - Modify the SEO description
   - Review and edit the markdown content
   - Click "Publish to BaseHub" when satisfied

4. **Publishing**:
   - The system automatically publishes the blog post to BaseHub
   - Receive confirmation when complete

### Features

- **Multi-step workflow**: Generate → Preview → Publish
- **Editable content**: Modify title, description, and content before publishing
- **Hero image preview**: See the generated image before publishing
- **Content extraction**: Automatically extracts insights from research reports
- **Markdown editing**: Full control over blog post content

## Error Handling

The system includes comprehensive error handling for:

- Missing environment variables
- AI generation failures
- Image generation failures
- BaseHub publishing errors
- Network connectivity issues

## Security

- All API endpoints require authentication
- BaseHub token is stored securely in environment variables
- Generated content is validated before publishing

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
4. **Content Generation Fails**: Verify OpenAI API key configuration

### Logs

Check the backend logs for detailed error messages:

```bash
cd backend && npm run dev
```

The blog controller logs all major operations with emoji prefixes for easy identification:

- 🤖 Content generation
- 🎨 Image generation
- 🚀 Publishing to BaseHub
- ✅ Success operations
- ❌ Error operations
