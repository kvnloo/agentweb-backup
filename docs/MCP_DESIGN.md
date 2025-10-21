# MCP (Model Context Protocol) Integration Design - Simplified

## Overview

This document outlines a simplified design for integrating Model Context Protocol (MCP) support into AgentWeb's Agent Mode. The focus is on essential features to enable basic MCP server usage with minimal complexity.

## Table of Contents

1. [Current Architecture](#current-architecture)
2. [Simplified Goals](#simplified-goals)
3. [Core Architecture](#core-architecture)
4. [Essential Database Schema](#essential-database-schema)
5. [Basic API Design](#basic-api-design)
6. [Implementation Plan](#implementation-plan)
7. [Basic Use Cases](#basic-use-cases)

## Current Architecture

### Existing Tool System

Agent Mode currently uses a hardcoded set of tools defined in `agentModeService.ts`:

```typescript
// Current tool definition example
{
  type: 'function' as const,
  function: {
    name: 'create_task_from_template',
    description: 'Create a task using a specific template',
    parameters: {
      type: 'object',
      properties: {
        template_id: { type: 'string' },
        parameters_json: { type: 'string' }
      },
      required: ['template_id', 'parameters_json']
    }
  }
}
```

### Current Limitations

1. **Static Tool Set**: Tools are hardcoded and require code changes to add new ones
2. **Limited Extensibility**: No way for users to add custom tools
3. **Single Provider**: All tools are implemented within the AgentWeb codebase
4. **No Standardization**: Each tool has its own implementation pattern

## Simplified Goals

### Essential Goals

1. **Basic MCP Support**: Connect to MCP servers and execute tools
2. **Tool Discovery**: Automatically discover tools from configured MCP servers
3. **Backward Compatibility**: Keep existing native tools working
4. **Simple Configuration**: Basic admin interface to add/remove MCP servers

### Excluded Features (for now)

- Advanced analytics and monitoring
- Complex security and access control
- Tool versioning and caching
- Performance optimizations
- Advanced admin features

## Core Architecture

### Simplified Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Agent Mode    │    │   MCP Adapter    │    │  MCP Servers    │
│   Service       │◄──►│   Service        │◄──►│  (External)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐    ┌──────────────────┐
│  Native Tools   │    │  MCP Tools       │
│  (Existing)     │    │  (Discovered)    │
└─────────────────┘    └──────────────────┘
```

### Essential Components

#### 1. MCP Adapter Service using mcp-use

```typescript
import { MCPClient } from 'mcp-use';

export class MCPAdapterService {
  private mcpClients: Map<string, MCPClient> = new Map();
  private tools: Map<string, MCPTool> = new Map();
  
  // Essential methods using mcp-use
  async connectToServer(config: MCPServerConfig): Promise<void> {
    const client = new MCPClient();
    await client.connect({
      serverName: config.serverName,
      command: config.command,
      args: config.args,
      env: config.env,
      startServer: true
    });
    this.mcpClients.set(config.serverId, client);
  }
  
  async discoverTools(serverId: string): Promise<void> {
    const client = this.mcpClients.get(serverId);
    if (!client) throw new Error(`Server ${serverId} not connected`);
    
    const tools = await client.listTools({ verbose: true });
    tools.forEach(tool => {
      this.tools.set(tool.name, {
        serverId,
        toolName: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      });
    });
  }
  
  async executeTool(serverId: string, toolName: string, args: any): Promise<any> {
    const client = this.mcpClients.get(serverId);
    if (!client) throw new Error(`Server ${serverId} not connected`);
    
    return await client.executeTool(toolName, args);
  }
  
  getAvailableTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }
  
  convertToOpenAIFormat(tool: MCPTool): OpenAIFunction {
    return {
      type: 'function',
      function: {
        name: tool.toolName,
        description: tool.description,
        parameters: tool.parameters
      }
    };
  }
}
```

#### 2. Modified Agent Mode Service

```typescript
export class AgentModeService {
  private mcpAdapter: MCPAdapterService;
  
  constructor() {
    this.mcpAdapter = new MCPAdapterService();
    this.initializeMCPServers();
  }
  
  // Initialize MCP servers on startup
  private async initializeMCPServers(): Promise<void> {
    try {
      const servers = await this.getMCPServersFromDB();
      for (const server of servers) {
        if (server.isActive) {
          await this.mcpAdapter.connectToServer(server);
          await this.mcpAdapter.discoverTools(server.serverId);
        }
      }
    } catch (error) {
      console.error('Failed to initialize MCP servers:', error);
    }
  }
  
  // Enhanced tool discovery
  public getAvailableTools(): OpenAIFunction[] {
    const nativeTools = this.getNativeTools();
    const mcpTools = this.mcpAdapter.getAvailableTools()
      .map(tool => this.mcpAdapter.convertToOpenAIFormat(tool));
    
    return [...nativeTools, ...mcpTools];
  }
  
  // Enhanced tool execution
  private async executeTool(toolName: string, args: any, userId: string, sessionId: string): Promise<any> {
    // Try MCP tools first, then native tools
    const mcpTool = this.mcpAdapter.findTool(toolName);
    if (mcpTool) {
      return await this.mcpAdapter.executeTool(mcpTool.serverId, toolName, args);
    }
    
    return await this.executeNativeTool(toolName, args, userId, sessionId);
  }
  
  // Helper method to find MCP tool
  private findTool(toolName: string): MCPTool | null {
    return this.mcpAdapter.getAvailableTools().find(tool => tool.toolName === toolName) || null;
  }
}
```

## Essential Database Schema

### Single MCP Servers Table

```typescript
interface MCPServer {
  serverId: string;           // Unique identifier
  serverName: string;         // Display name
  command: string;            // Command to start server
  args: string[];             // Command arguments
  env: Record<string, string>; // Environment variables
  isActive: boolean;          // Whether server is enabled
  createdAt: string;
  updatedAt: string;
}

// Tools are discovered dynamically, not stored in database
interface MCPTool {
  serverId: string;           // Reference to MCP server
  toolName: string;           // Tool name
  description: string;        // Tool description
  parameters: JSONSchema;     // Tool parameters schema
}
```

## Basic API Design

### Essential MCP Endpoints

```typescript
// GET /api/mcp/servers
// Get all MCP servers
interface GetMCPServersResponse {
  servers: MCPServer[];
}

// POST /api/mcp/servers
// Add new MCP server
interface AddMCPServerRequest {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

// DELETE /api/mcp/servers/:serverId
// Remove MCP server

// POST /api/mcp/servers/:serverId/test
// Test MCP server connection
interface TestMCPServerResponse {
  success: boolean;
  message: string;
  toolsDiscovered?: number;
}

// GET /api/mcp/tools
// Get all discovered MCP tools
interface GetMCPToolsResponse {
  tools: MCPTool[];
}
```

## Implementation Plan

### Phase 1: Basic MCP Support (Week 1)

**Goals**: Enable basic MCP server connection and tool execution

**Tasks**:
1. Install mcp-use library
   ```bash
   npm install mcp-use
   ```

2. Create single database table
   - `AW-MCPServers`

3. Implement `MCPAdapterService` using mcp-use
   - Use MCPClient from mcp-use library
   - Connect to MCP servers with proper configuration
   - Discover tools using client.listTools()
   - Execute tools using client.executeTool()

4. Modify `AgentModeService`
   - Initialize MCP servers on startup
   - Add MCP tools to available tools
   - Route MCP tool execution through mcp-use client

**Deliverables**:
- Basic MCP adapter service
- Database table
- MCP tool integration

### Phase 2: Admin Interface (Week 2)

**Goals**: Add simple admin interface for MCP management

**Tasks**:
1. Create basic API endpoints
   - Add/remove MCP servers
   - Test connections
   - List discovered tools

2. Add simple admin UI
   - MCP server configuration form
   - Server list with test/remove buttons
   - Tool discovery display

**Deliverables**:
- MCP API endpoints
- Basic admin interface
- MCP server management

## Basic Use Cases with mcp-use

### 1. File System Operations

**MCP Server Configuration**:
```typescript
{
  serverId: 'filesystem-server',
  serverName: 'filesystem',
  command: 'npx',
  args: ['@modelcontextprotocol/server-filesystem', '/path/to/allowed/directory'],
  env: {},
  isActive: true
}
```

**Example Tools** (discovered via mcp-use):
- `read_file` - Read file contents
- `write_file` - Write file contents
- `list_directory` - List directory contents
- `create_directory` - Create new directory

**Example Usage**:
```
User: "Read the contents of my project README file"
Agent: Uses mcp-use client to execute filesystem MCP server tools
```

### 2. Database Queries

**MCP Server Configuration**:
```typescript
{
  serverId: 'postgres-server',
  serverName: 'postgres',
  command: 'npx',
  args: ['@modelcontextprotocol/server-postgres'],
  env: {
    POSTGRES_CONNECTION_STRING: 'postgresql://user:pass@localhost/db'
  },
  isActive: true
}
```

**Example Tools** (discovered via mcp-use):
- `execute_query` - Run SQL queries
- `list_tables` - List database tables
- `describe_table` - Get table schema

**Example Usage**:
```
User: "Show me all users created in the last month"
Agent: Uses mcp-use client to execute PostgreSQL MCP server tools
```

### 3. Simple Data Analytics

**MCP Server Configuration**:
```typescript
{
  serverId: 'simple-analytics-server',
  serverName: 'analytics',
  command: 'npx',
  args: ['@modelcontextprotocol/server-simple-analytics'],
  env: {},
  isActive: true
}
```

**Single Tool** (discovered via mcp-use):
- `analyze_data` - Takes analysis goal and data sources, returns complete analysis

**Example Usage**:
```
User: "Analyze our Q4 sales performance using our sales.csv file"
Agent: Uses mcp-use client to execute the single analytics tool
```

### 4. Web Search

**MCP Server Configuration**:
```typescript
{
  serverId: 'websearch-server',
  serverName: 'websearch',
  command: 'npx',
  args: ['@modelcontextprotocol/server-web-search'],
  env: {
    SEARCH_API_KEY: 'your-api-key'
  },
  isActive: true
}
```

**Example Tools** (discovered via mcp-use):
- `search_web` - Search the web
- `get_page_content` - Get webpage content

**Example Usage**:
```
User: "Search for the latest AI trends"
Agent: Uses mcp-use client to execute web search MCP server tools
```

## Basic Security

### Simple Access Control
- Only admin users can add/remove MCP servers
- All users can use discovered MCP tools
- Basic error handling and logging

### Basic Validation
- Test MCP server connections before adding
- Simple error messages for failed operations
- Basic logging of MCP tool executions

## Simple Data Analytics Example

### One-Tool Analytics Workflow

**User Request**: "Analyze our Q4 sales performance using our sales.csv file"

**Agent Response**: Uses single `analyze_data` tool that handles everything:

```typescript
// Single tool call
const result = await client.executeTool('analyze_data', {
  goal: "Analyze Q4 sales performance and identify trends",
  dataSources: [
    {
      type: "csv",
      path: "/data/sales.csv",
      description: "Q4 sales data with columns: date, product, revenue, quantity"
    }
  ],
  outputFormat: "comprehensive_report" // or "summary", "visualization"
});
```

**What the tool does internally**:
1. Loads the CSV data
2. Performs statistical analysis
3. Identifies trends and patterns
4. Generates insights and recommendations
5. Creates visualizations
6. Returns complete analysis report

**Example MCP Server Configuration**:
```typescript
{
  serverId: 'simple-analytics-server',
  serverName: 'analytics',
  command: 'npx',
  args: ['@modelcontextprotocol/server-simple-analytics'],
  env: {},
  isActive: true
}
```

**Single Tool Interface**:
- `analyze_data` - Complete analysis in one call
  - **Input**: Analysis goal + data sources list
  - **Output**: Complete analysis report with insights, charts, and recommendations

## Implementation with mcp-use Library

### Key Benefits of Using mcp-use

1. **Simplified Integration**: mcp-use provides a clean API for MCP client management
2. **Automatic Tool Discovery**: Built-in `listTools()` method with verbose output
3. **Easy Tool Execution**: Simple `executeTool()` method for running MCP tools
4. **Server Management**: Built-in connection handling and server lifecycle management
5. **Error Handling**: Proper error handling and connection management

### mcp-use Integration Pattern

```typescript
// 1. Create MCP client
const client = new MCPClient();

// 2. Connect to simple analytics server
await client.connect({
  serverName: 'analytics',
  command: 'npx',
  args: ['@modelcontextprotocol/server-simple-analytics'],
  env: {},
  startServer: true
});

// 3. Discover tools (will find single 'analyze_data' tool)
const tools = await client.listTools({ verbose: true });

// 4. Execute single analytics tool
const result = await client.executeTool('analyze_data', {
  goal: "Analyze sales performance and identify trends",
  dataSources: [
    { type: "csv", path: "/data/sales.csv" },
    { type: "database", connection: "postgresql://...", query: "SELECT * FROM customers" }
  ],
  outputFormat: "comprehensive_report"
});
```

## Conclusion

This simplified MCP design leverages the mcp-use library to provide essential MCP server functionality:

1. **Basic MCP Support**: Connect to MCP servers using mcp-use MCPClient
2. **Tool Discovery**: Use mcp-use listTools() for automatic tool discovery
3. **Simple Management**: Basic admin interface to add/remove servers
4. **Backward Compatibility**: Existing native tools continue to work
5. **Easy Integration**: mcp-use simplifies MCP client management

The implementation can be completed in 2 weeks using the mcp-use library and provides a solid foundation for future enhancements.
