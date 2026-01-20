import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: "perform_data_analysis",
  definition: {
    name: "perform_data_analysis",
    description: "Perform advanced data analysis on one or more files using Python and common data science libraries.",
    inputSchema: {
      type: "object",
      properties: {
        file_urls: { type: "array", items: { type: "string" }, default: [] },
        analysis_instruction: { type: "string" }
      },
      required: ["analysis_instruction"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.performDataAnalysis(args.file_urls, args.analysis_instruction, args.userId);
  }
});

mcpToolRegistry.register({
  name: "create_html_file",
  definition: {
    name: "create_html_file",
    description: "Create a well-formatted HTML file from a title, content draft, and format requirements.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content_draft: { type: "string" },
        format_requirements: { type: "string" }
      },
      required: ["title", "content_draft"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createHtmlFile(args.title, args.content_draft, args.format_requirements, args.userId, args.sessionId);
  }
});

mcpToolRegistry.register({
  name: "save_file",
  definition: {
    name: "save_file",
    description: "Save content to a new file in the user's storage.",
    inputSchema: {
      type: "object",
      properties: {
        file_name: { type: "string" },
        file_content: { type: "string" }
      },
      required: ["file_name", "file_content"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.saveFile(args.file_name, args.file_content, args.userId, args.sessionId);
  }
});
