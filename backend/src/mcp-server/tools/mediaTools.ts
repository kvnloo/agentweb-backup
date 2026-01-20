import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: "describe_image",
  definition: {
    name: "describe_image",
    description: "Analyze and describe an image from a URL or an uploaded file.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string" },
        prompt: { type: "string", default: "Describe this image in detail" },
        llmModel: { type: "string", default: "gemini-3-flash-preview" }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.describeImage(args.llmModel, args.image_url, args.prompt);
  }
});

mcpToolRegistry.register({
  name: "describe_video",
  definition: {
    name: "describe_video",
    description: "Analyze and describe the content of a video file.",
    inputSchema: {
      type: "object",
      properties: {
        video_file_url: { type: "string" },
        prompt: { type: "string" }
      },
      required: ["video_file_url"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.describeVideo(args.video_file_url, args.prompt);
  }
});

mcpToolRegistry.register({
  name: "remove_c2pa_from_image",
  definition: {
    name: "remove_c2pa_from_image",
    description: "Remove C2PA metadata from an image.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string" },
        filename: { type: "string" }
      },
      required: ["image_url", "filename"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.removeC2PAFromImage(args.image_url, args.filename, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'generate_image',
  definition: {
    name: 'generate_image',
    description: 'Generate a new image or revise an existing one using AI models.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        filename: { type: 'string' },
        size: { type: 'string', enum: ['1024x1024', '1024x1792', '1792x1024'], default: '1024x1024' },
        quality: { type: 'string', enum: ['standard', 'hd'], default: 'standard' },
        inputImages: { type: 'array', items: { type: 'string' } },
        imageModel: { type: 'string', default: 'dalle3' }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.generateImage(args.prompt, args.filename, args.size, args.quality, args.inputImages || [], args.userId, args.sessionId, args.imageModel);
  }
});

mcpToolRegistry.register({
  name: 'generate_video',
  definition: {
    name: 'generate_video',
    description: 'Generate a short video clip from a text prompt or an image.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        filename: { type: 'string' },
        videoModel: { type: 'string', default: 'vertex-veo' },
        startFrame: { type: 'string' },
        endFrame: { type: 'string' }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.generateVideo(args.prompt, args.filename, args.userId, args.sessionId, args.videoModel, args.startFrame, args.endFrame);
  }
});
