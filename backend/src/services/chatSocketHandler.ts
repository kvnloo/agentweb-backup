import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';
import { generateChatResponse, chatbotDb } from './chatbotService';
import { checkTokenUsage, TURN_ADMISSION, toCustomerTokenUsage } from './tokenUsageService';
import { userDb } from './db';
import { buildUsageBlockCopy } from '../utils/usageBlockCopy';
import { resolveRunFunding, withRunFunding } from './funding/runFunding';

// Narrowed to exactly what this handler touches on a Socket.IO `Socket`, so a
// test can pass a plain mock without satisfying the full (much larger)
// `Handshake` shape.
interface ChatSocketLike {
  id: string;
  handshake: { auth: { token?: string } };
  emit: (event: string, ...args: any[]) => void;
}

// Extracted from server.ts's inline socket.on('message', ...) handler so the
// ENG-1222 session-ownership check can be covered by a unit test without
// booting the real HTTP/Socket.IO server that module starts as a side effect
// of import (server.listen(...) runs unconditionally at module scope there).
export async function handleSocketChatMessage(
  socket: ChatSocketLike,
  data: {
    sessionId: string;
    message: string;
    currentUrl?: string;
    pageContent?: string;
    portal?: 'customer' | 'partner';
  }
): Promise<void> {
  try {
    // Get user ID from socket auth
    const token = socket.handshake.auth.token;
    if (!token) {
      throw new Error('No authentication token provided');
    }

    const decoded = jwt.verify(token, getJwtSecret()) as { userId: string; isAdmin?: boolean; delegateAccess?: { adminUserId: string; adminEmail: string; targetUserId: string; targetEmail: string } };
    const userId = decoded.delegateAccess?.targetUserId || decoded.userId;
    const isDelegatedAdmin = !!decoded.delegateAccess || decoded.isAdmin === true;

    // Check token usage limits
    const usageStatus = await checkTokenUsage(userId, TURN_ADMISSION);
    if (!usageStatus.allowed) {
      // Same two defects as the MCP middleware carried, and the same fix: the
      // raw status leaked `costUsed`/`costAllowance` past ENG-1212's projection,
      // and the copy named tokens (not the gating dimension since ENG-1116) with
      // no reset date. `code` is unchanged — clients branch on it.
      const blockCopy = buildUsageBlockCopy({ month: usageStatus.month, paygBlock: usageStatus.paygBlock });
      socket.emit('error', {
        message: blockCopy.message,
        code: 'TOKEN_LIMIT_EXCEEDED',
        usageBlock: blockCopy,
        tokenUsage: toCustomerTokenUsage(usageStatus),
      });
      return;
    }

    // ENG-1222: this handler accepts a client-supplied sessionId with no
    // ownership check, unlike the HTTP chatbot routes (controllers/chatbot.ts),
    // which 403 when session.userId !== userId. Tools are now bound whenever
    // the target session has installed skills, regardless of portalType, so a
    // missing check here would let any authenticated caller execute another
    // user's skill tools (scoped to their own account) just by knowing/guessing
    // that user's sessionId.
    //
    // getChatSessionRecord, not getChatSession: the latter also reads
    // AW-ChatMessages and, for a legacy session, WRITES a migration of its
    // messages into that table — an unauthorized caller could otherwise force
    // a read (and possibly a write) against another user's session data
    // merely by attempting access, before ownership is ever checked. Only
    // session.userId is needed here; generateChatResponse below does its own
    // full getChatSession once ownership is confirmed.
    const session = await chatbotDb.getChatSessionRecord(data.sessionId);
    if (!session) {
      socket.emit('error', { message: 'Chat session not found' });
      return;
    }
    if (session.userId !== userId) {
      socket.emit('error', { message: 'Unauthorized access to chat session' });
      return;
    }

    const portalType = data.portal || 'partner';
    const orgRole = portalType === 'customer' ? (await userDb.getUserById(userId))?.orgRole : undefined;
    // ENG-1816 F1: without this, chatbotService's embeddings-attribution fix is a
    // silent no-op on this entry point — currentRunFunding() would read undefined.
    // resolveRunFunding always resolves 'agentweb' today, so nothing observable changes.
    const runFunding = await resolveRunFunding({ userId });
    const response = await withRunFunding(runFunding, () => generateChatResponse(
      data.sessionId,
      data.message,
      { currentUrl: data.currentUrl, pageContent: data.pageContent, portalType, userId, socketId: socket.id, isDelegatedAdmin, orgRole }
    ));

    // Send response back to the client
    const responseContent = typeof response === 'string' ? response : (response as any)?.content ?? '';
    socket.emit('message', {
      sessionId: data.sessionId,
      content: responseContent
    });
  } catch (error) {
    console.error('Error processing message:', error);
    socket.emit('error', {
      message: 'Failed to process message'
    });
  }
}
