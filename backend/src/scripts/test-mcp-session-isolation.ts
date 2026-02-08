/**
 * Test MCP session isolation fix with 10 concurrent sessions
 * Verifies each chat session gets its own isolated MCP client pool
 */

import { McpClientService } from '../mcp/client/mcpClientService';
import { v4 as uuidv4 } from 'uuid';

async function testSessionIsolation() {
  console.log('\n=== MCP Session Isolation Test (10 Concurrent Sessions) ===\n');

  const startTime = Date.now();
  const mcpService = new McpClientService();
  await mcpService.initialize();

  // Test with 10 concurrent sessions
  const sessionCount = 10;
  const sessions = Array.from({ length: sessionCount }, () => uuidv4());

  console.log(`Testing ${sessions.length} concurrent sessions...\n`);

  const sessionMcpIds = new Map<string, string>();
  const startSession = Date.now();

  // Create all session clients concurrently
  const clientPromises = sessions.map(async (sessionId) => {
    const client = await (mcpService as any).getSessionClient('agentweb-tools', sessionId);
    const transport = (client as any)._transport;
    const mcpSessionId = transport?.sessionId || 'NO_SESSION';
    sessionMcpIds.set(sessionId, mcpSessionId);
    return { sessionId, mcpSessionId };
  });

  const results = await Promise.all(clientPromises);
  const sessionCreationTime = Date.now() - startSession;

  // Display results
  results.forEach(({ sessionId, mcpSessionId }, index) => {
    console.log(`Chat ${index + 1} (${sessionId.substring(0, 8)}) → MCP ${mcpSessionId.substring(0, 8)}`);
  });

  const uniqueMcpIds = new Set(sessionMcpIds.values());
  const totalTime = Date.now() - startTime;

  console.log(`\nResult: ${uniqueMcpIds.size}/${sessions.length} unique MCP sessions`);
  console.log(`Session creation time: ${sessionCreationTime}ms`);
  console.log(`Total test time: ${totalTime}ms`);

  // Check for connection info
  const sessionPools = (mcpService as any).sessionClientPools;
  console.log(`\nActive session pools: ${sessionPools.size}`);

  let totalClients = 0;
  for (const [sessionId, pool] of sessionPools.entries()) {
    totalClients += pool.clients.size;
  }
  console.log(`Total MCP clients created: ${totalClients} (${sessionCount} sessions × ${totalClients / sessionCount} servers)`);

  if (uniqueMcpIds.size === sessions.length) {
    console.log('\n✓ SUCCESS: Each chat session has isolated MCP client');
    console.log('✓ No session ID conflicts detected\n');
    await mcpService.shutdown();
    process.exit(0);
  } else {
    console.log('\n✗ FAIL: Sessions sharing MCP clients\n');
    await mcpService.shutdown();
    process.exit(1);
  }
}

testSessionIsolation();
