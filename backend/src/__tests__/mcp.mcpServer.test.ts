/**
 * Unit tests for mcp/server/mcpServer.ts
 * Tests the setupMcpServer function and related middleware for MCP server functionality
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';

// Mock the MCP SDK modules
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    server: {
      setRequestHandler: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    }
  }))
}));

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((options) => {
    const transport = {
      sessionId: 'test-session-id',
      handleRequest: jest.fn().mockImplementation(async (req: any, res: any, body?: any) => {
        if (!res.headersSent) {
          res.status(200).json({ result: 'ok' });
        }
      }),
      close: jest.fn().mockResolvedValue(undefined),
      onclose: null as (() => void) | null
    };
    // Call onsessioninitialized if provided
    if (options?.onsessioninitialized) {
      setTimeout(() => options.onsessioninitialized(transport.sessionId), 0);
    }
    return transport;
  })
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: jest.fn().mockReturnValue(false),
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema'
}));

// Mock the registry
jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: {
    getToolDefinitions: jest.fn().mockReturnValue([
      { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }
    ]),
    execute: jest.fn().mockResolvedValue({ success: true })
  }
}));

// Mock tools import (it's a side-effect import)
jest.mock('../mcp/server/apiTools', () => ({}));

// Mock the shared core module
jest.mock('../mcp/server/mcpServerCore', () => ({
  createMcpServer: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined)
  })),
  mcpToolRegistry: {
    getToolDefinitions: jest.fn().mockReturnValue([
      { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }
    ]),
    execute: jest.fn().mockResolvedValue({ success: true })
  }
}));

import { setupMcpServer } from '../mcp/server/mcpServer';
import { mcpToolRegistry } from '../mcp/server/registry';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

describe('MCP Server', () => {
  let app: Express;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_HTTP_ENABLED = 'true'; // Enable HTTP server for tests
    delete process.env.MCP_ACCESS_TOKEN;
    
    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateMcpAccessToken middleware', () => {
    beforeEach(() => {
      setupMcpServer(app);
    });

    it('should reject request when no auth token is provided', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Missing access token');
      expect(response.body.hint).toBeDefined();
      expect(response.body.setup).toContain('skill.md');
    });

    it('should reject request without Authorization header even with MCP_ACCESS_TOKEN set', async () => {
      process.env.MCP_ACCESS_TOKEN = 'secret-token';
      const securedApp = express();
      securedApp.use(express.json());
      setupMcpServer(securedApp);

      const response = await request(securedApp)
        .post('/mcp')
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Missing access token');
      expect(response.body.setup).toContain('agentweb.pro');
    });

    it('should reject request with invalid token', async () => {
      process.env.MCP_ACCESS_TOKEN = 'correct-token';
      const securedApp = express();
      securedApp.use(express.json());
      setupMcpServer(securedApp);

      const response = await request(securedApp)
        .post('/mcp')
        .set('Authorization', 'Bearer wrong-token')
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Invalid access token');
      expect(response.body.setup).toContain('skill.md');
    });

    it('should accept request with valid Bearer token', async () => {
      process.env.MCP_ACCESS_TOKEN = 'valid-token';
      const securedApp = express();
      securedApp.use(express.json());
      setupMcpServer(securedApp);

      (isInitializeRequest as unknown as jest.Mock).mockReturnValueOnce(true);

      const response = await request(securedApp)
        .post('/mcp')
        .set('Authorization', 'Bearer valid-token')
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });

    it('should accept request with valid token (no Bearer prefix)', async () => {
      process.env.MCP_ACCESS_TOKEN = 'plain-token';
      const securedApp = express();
      securedApp.use(express.json());
      setupMcpServer(securedApp);

      (isInitializeRequest as unknown as jest.Mock).mockReturnValueOnce(true);

      const response = await request(securedApp)
        .post('/mcp')
        .set('Authorization', 'plain-token')
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });
  });

  describe('POST /mcp endpoint', () => {
    const TEST_TOKEN = 'test-mcp-token';

    beforeEach(() => {
      process.env.MCP_ACCESS_TOKEN = TEST_TOKEN;
      setupMcpServer(app);
    });

    it('should handle initialization request and create session', async () => {
      (isInitializeRequest as unknown as jest.Mock).mockReturnValueOnce(true);

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          method: 'initialize',
          params: { capabilities: {} },
          id: 1
        });

      // Transport's handleRequest is called
      expect(StreamableHTTPServerTransport).toHaveBeenCalled();
    });

    it('should return 404 for missing session ID on non-initialization request (so MCP client auto-reinitializes)', async () => {
      // A bare non-initialize call (no mcp-session-id header) arrives when a client's
      // session was evicted/lost and its transport dropped the cached id. The server must
      // return 404 / -32001 — identical to the unknown-session branch — so the MCP SDK's
      // StreamableHTTPClientTransport treats it as "session expired", re-runs initialize,
      // and retries with a fresh session. The prior behavior returned 400 / -32000, which
      // the SDK treats as terminal, permanently failing emma_create_session and every
      // subsequent tool call until a manual reconnect (ENG-97). This is a lock-in test
      // that previously pinned the wrong (terminal-400) contract; corrected here.
      (isInitializeRequest as unknown as jest.Mock).mockReturnValueOnce(false);

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(-32001);
      expect(response.body.error.message).toContain('Session not found');
    });

    it('should return 404 for stale/unknown session ID (so MCP client auto-reinitializes)', async () => {
      // When a sessionId is provided but unknown to this server instance (e.g. after
      // a server restart wiped the in-memory sessions Map), we return 404. The MCP
      // TypeScript SDK's StreamableHTTPClientTransport treats 404 as "session expired"
      // and automatically re-initializes a new session — eliminating the manual
      // /mcp reconnect that was previously required. Returning 400 (the prior
      // behavior) was treated as terminal by the SDK and forced manual recovery.
      (isInitializeRequest as unknown as jest.Mock).mockReturnValueOnce(false);

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .set('mcp-session-id', 'nonexistent-session')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(-32001);
      expect(response.body.error.message).toContain('Session not found');
    });
  });

  describe('GET /mcp endpoint (SSE)', () => {
    const TEST_TOKEN = 'test-mcp-token';

    beforeEach(() => {
      process.env.MCP_ACCESS_TOKEN = TEST_TOKEN;
      setupMcpServer(app);
    });

    it('should return 400 for missing session ID', async () => {
      const response = await request(app)
        .get('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`);

      expect(response.status).toBe(400);
      expect(response.text).toContain('Missing session ID');
    });

    it('should return 404 for stale/unknown session ID (so MCP client auto-reinitializes)', async () => {
      const response = await request(app)
        .get('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .set('mcp-session-id', 'invalid-session');

      expect(response.status).toBe(404);
      expect(response.text).toContain('Session not found');
    });
  });

  describe('DELETE /mcp endpoint', () => {
    const TEST_TOKEN = 'test-mcp-token';

    beforeEach(() => {
      process.env.MCP_ACCESS_TOKEN = TEST_TOKEN;
      setupMcpServer(app);
    });

    it('should return 204 for unknown session ID (idempotent termination — already gone is success)', async () => {
      // DELETE on a missing session used to return 400. That's wrong semantically:
      // the caller asked to terminate a session, the session doesn't exist (likely
      // already terminated), so we should succeed idempotently.
      const response = await request(app)
        .delete('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .set('mcp-session-id', 'invalid-session');

      expect(response.status).toBe(204);
    });

    it('should return 400 for missing session ID', async () => {
      const response = await request(app)
        .delete('/mcp')
        .set('Authorization', `Bearer ${TEST_TOKEN}`);

      expect(response.status).toBe(400);
    });
  });

  describe('Session Management', () => {
    let testApp: Express;

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.MCP_HTTP_ENABLED = 'true';
      process.env.MCP_ACCESS_TOKEN = 'session-test-token';
    });

    it('should create new session on initialization', async () => {
      jest.resetModules();

      const express = require('express');
      const { setupMcpServer: setup } = require('../mcp/server/mcpServer');
      const { isInitializeRequest: isInit } = require('@modelcontextprotocol/sdk/types.js');
      const { StreamableHTTPServerTransport: Transport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

      testApp = express();
      testApp.use(express.json());

      (isInit as jest.Mock).mockReturnValue(true);
      setup(testApp);

      await request(testApp)
        .post('/mcp')
        .set('Authorization', 'Bearer session-test-token')
        .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

      expect(Transport).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionIdGenerator: expect.any(Function),
          onsessioninitialized: expect.any(Function)
        })
      );
    });
  });

  describe('mcpShutdown', () => {
    it('should expose shutdown function on app', () => {
      setupMcpServer(app);
      
      expect((app as any).mcpShutdown).toBeDefined();
      expect(typeof (app as any).mcpShutdown).toBe('function');
    });

    it('should call shutdown function without error', async () => {
      setupMcpServer(app);
      
      // Should not throw
      await (app as any).mcpShutdown();
    });
  });
});

describe('mcpToolRegistry integration', () => {
  it('should have getToolDefinitions method', () => {
    expect(mcpToolRegistry.getToolDefinitions).toBeDefined();
    expect(typeof mcpToolRegistry.getToolDefinitions).toBe('function');
  });

  it('should have execute method', () => {
    expect(mcpToolRegistry.execute).toBeDefined();
    expect(typeof mcpToolRegistry.execute).toBe('function');
  });
});

describe('Environment configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MCP_HTTP_ENABLED = 'true'; // Enable HTTP server for tests
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use default SESSION_TIMEOUT_MS if not set', () => {
    delete process.env.MCP_SESSION_TIMEOUT_MS;
    
    const app = express();
    // Just verify it doesn't throw
    expect(() => setupMcpServer(app)).not.toThrow();
  });

  it('should use custom SESSION_TIMEOUT_MS if set', () => {
    process.env.MCP_SESSION_TIMEOUT_MS = '600000';
    
    const app = express();
    expect(() => setupMcpServer(app)).not.toThrow();
  });

  it('should use default CLEANUP_INTERVAL_MS if not set', () => {
    delete process.env.MCP_CLEANUP_INTERVAL_MS;
    
    const app = express();
    expect(() => setupMcpServer(app)).not.toThrow();
  });

  it('should use custom CLEANUP_INTERVAL_MS if set', () => {
    process.env.MCP_CLEANUP_INTERVAL_MS = '120000';
    
    const app = express();
    expect(() => setupMcpServer(app)).not.toThrow();
  });

  it('should log secured status based on MCP_ACCESS_TOKEN', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    
    process.env.MCP_ACCESS_TOKEN = 'test-token';
    const app = express();
    setupMcpServer(app);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('secured: true')
    );

    consoleSpy.mockRestore();
  });

  it('should log when MCP_ACCESS_TOKEN not set (auth still required via API keys)', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    delete process.env.MCP_ACCESS_TOKEN;
    const app = express();
    setupMcpServer(app);

    // Auth is always required, but the log reflects whether a static token is configured
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('secured: false')
    );

    consoleSpy.mockRestore();
  });
});
