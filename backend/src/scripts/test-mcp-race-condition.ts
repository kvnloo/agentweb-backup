/**
 * Test script to stress-test MCP race condition fix
 * Creates multiple concurrent agent mode sessions to verify session ID handling
 */

import axios from 'axios';
import { io, Socket } from 'socket.io-client';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const TEST_EMAIL = 'test@example.com';
const TEST_PASSWORD = 'Test123!';
const NUM_SESSIONS = 5; // Number of concurrent sessions to test
const TIMEOUT_MS = 30000; // 30 seconds timeout per session

interface TestResult {
  sessionIndex: number;
  chatSessionId: string;
  success: boolean;
  error?: string;
  toolCalls: string[];
  duration: number;
}

/**
 * Login and get JWT token
 */
async function login(): Promise<string> {
  console.log(`🔐 Logging in as ${TEST_EMAIL}...`);
  try {
    const response = await axios.post<{ token: string }>(`${BACKEND_URL}/api/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });
    console.log(`✅ Login successful, got token`);
    return response.data.token;
  } catch (error: any) {
    console.error(`❌ Login failed:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Create a chat session via API
 */
async function createChatSession(token: string): Promise<string> {
  try {
    const response = await axios.post<{ sessionId: string }>(
      `${BACKEND_URL}/api/agent-mode/sessions`,
      {
        title: `MCP Race Condition Test ${Date.now()}`
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    return response.data.sessionId;
  } catch (error: any) {
    console.error(`❌ Failed to create session:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Run a single agent mode session test
 */
async function runSessionTest(
  sessionIndex: number,
  token: string,
  chatSessionId: string
): Promise<TestResult> {
  const startTime = Date.now();
  const result: TestResult = {
    sessionIndex,
    chatSessionId,
    success: false,
    toolCalls: [],
    duration: 0
  };

  return new Promise((resolve) => {
    const socket: Socket = io(BACKEND_URL, {
      auth: { token },
      transports: ['websocket']
    });

    const timeout = setTimeout(() => {
      console.log(`⏱️  Session ${sessionIndex} (${chatSessionId}): Timeout after ${TIMEOUT_MS}ms`);
      result.error = 'Timeout';
      result.duration = Date.now() - startTime;
      socket.disconnect();
      resolve(result);
    }, TIMEOUT_MS);

    let responseReceived = false;

    socket.on('connect', () => {
      console.log(`🔌 Session ${sessionIndex} (${chatSessionId}): Connected to socket`);

      // Send a message that will trigger MCP tool calls
      const testMessage = 'Run search_knowledge_base to find information about marketing strategy';

      socket.emit('message', {
        message: testMessage,
        sessionId: chatSessionId
      });
    });

    socket.on('message', (data: any) => {
      if (responseReceived) return;
      responseReceived = true;

      clearTimeout(timeout);
      result.duration = Date.now() - startTime;

      console.log(`✅ Session ${sessionIndex} (${chatSessionId}): Response complete (${result.duration}ms)`);

      // Check response data for any indicators of tool calls
      if (data && typeof data === 'object') {
        // Try to extract tool information from response
        const responseStr = JSON.stringify(data);
        if (responseStr.includes('search_knowledge_base') ||
            responseStr.includes('create_work_plan') ||
            responseStr.includes('read_brand_guidelines')) {
          result.toolCalls.push('MCP tool detected in response');
        }
      }

      result.success = true;
      socket.disconnect();
      resolve(result);
    });

    socket.on('error', (data: { error?: string; message?: string }) => {
      clearTimeout(timeout);
      result.duration = Date.now() - startTime;
      result.error = data.error || data.message || 'Unknown error';

      console.error(`❌ Session ${sessionIndex} (${chatSessionId}): Error - ${result.error}`);

      socket.disconnect();
      resolve(result);
    });

    socket.on('connect_error', (error: Error) => {
      clearTimeout(timeout);
      result.duration = Date.now() - startTime;
      result.error = `Connection error: ${error.message}`;

      console.error(`❌ Session ${sessionIndex} (${chatSessionId}): Connection error - ${error.message}`);

      resolve(result);
    });
  });
}

/**
 * Main test runner
 */
async function main() {
  console.log('='.repeat(80));
  console.log('🧪 MCP Race Condition Stress Test');
  console.log('='.repeat(80));
  console.log(`Backend URL: ${BACKEND_URL}`);
  console.log(`Concurrent Sessions: ${NUM_SESSIONS}`);
  console.log(`Timeout per Session: ${TIMEOUT_MS}ms`);
  console.log('');

  try {
    // Step 1: Login
    const token = await login();
    console.log('');

    // Step 2: Create chat sessions
    console.log(`📝 Creating ${NUM_SESSIONS} chat sessions...`);
    const sessionIds: string[] = [];
    for (let i = 0; i < NUM_SESSIONS; i++) {
      const sessionId = await createChatSession(token);
      sessionIds.push(sessionId);
      console.log(`   Session ${i + 1}: ${sessionId}`);
    }
    console.log('');

    // Step 3: Run all sessions concurrently
    console.log(`🚀 Starting ${NUM_SESSIONS} concurrent agent mode sessions...`);
    console.log('');

    const testPromises = sessionIds.map((sessionId, index) =>
      runSessionTest(index + 1, token, sessionId)
    );

    const results = await Promise.all(testPromises);

    // Step 4: Analyze results
    console.log('');
    console.log('='.repeat(80));
    console.log('📊 Test Results Summary');
    console.log('='.repeat(80));

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const withToolCalls = results.filter(r => r.toolCalls.length > 0);
    const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

    console.log(`Total Sessions: ${NUM_SESSIONS}`);
    console.log(`✅ Successful: ${successful.length}`);
    console.log(`❌ Failed: ${failed.length}`);
    console.log(`🔧 With MCP Tool Calls: ${withToolCalls.length}`);
    console.log(`⏱️  Average Duration: ${Math.round(avgDuration)}ms`);
    console.log('');

    if (failed.length > 0) {
      console.log('Failed Sessions:');
      failed.forEach(r => {
        console.log(`  - Session ${r.sessionIndex} (${r.chatSessionId}): ${r.error}`);
      });
      console.log('');
    }

    if (withToolCalls.length > 0) {
      console.log('MCP Tool Calls:');
      withToolCalls.forEach(r => {
        console.log(`  - Session ${r.sessionIndex}: ${r.toolCalls.join(', ')}`);
      });
      console.log('');
    }

    // Step 5: Exit status
    if (failed.length === 0) {
      console.log('🎉 All tests passed! No MCP race condition detected.');
      process.exit(0);
    } else {
      console.error('⚠️  Some tests failed. Check logs for MCP session errors.');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ Test script failed:', error.message);
    process.exit(1);
  }
}

// Run the tests
main();
