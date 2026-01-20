import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: "search_web",
  definition: {
    name: "search_web",
    description: "Search the web for information from the internet",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "number", default: 5 }
      },
      required: ["query"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.searchWeb(args.query, args.max_results);
  }
});

mcpToolRegistry.register({
  name: "read_file_content",
  definition: {
    name: "read_file_content",
    description: "Read and extract content from a file URL.",
    inputSchema: {
      type: "object",
      properties: {
        file_url: { type: "string" }
      },
      required: ["file_url"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.readFileContent(args.file_url);
  }
});

mcpToolRegistry.register({
  name: "read_page_source",
  definition: {
    name: "read_page_source",
    description: "Read and extract the HTML source code from any webpage URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    }
  },
  execute: async (args: any) => {
    return await agentModeService.readFileContent(args.url);
  }
});
