import type { Socket } from 'socket.io';
import {
  closeLiveSession,
  startLiveSession,
  type LiveToolProfile,
} from './liveVoiceService';

interface LiveSocketPrincipal {
  userId?: string;
  delegateAccess?: {
    targetUserId?: string;
  };
}

/**
 * Resolve the principal already authenticated by the Socket.IO middleware.
 *
 * Delegated sockets act as the target customer. Interactive-share sockets act
 * as the owner resolved when the share token was authenticated.
 */
export function getEffectiveLiveUserId(socket: Socket): string {
  if (socket.data.conversableUserId) {
    return socket.data.conversableUserId;
  }

  const principal = socket.data.user as LiveSocketPrincipal | undefined;
  const effectiveUserId = principal?.delegateAccess?.targetUserId || principal?.userId;
  if (!effectiveUserId) throw new Error('No authenticated live user');
  return effectiveUserId;
}

/**
 * Register the security-sensitive live:start boundary separately from server
 * boot so it can be exercised through a real Socket.IO server/client pair.
 */
export function registerLiveStartHandler(socket: Socket): void {
  const liveEmit = (event: string, data: unknown) => socket.emit(event, data);

  socket.on('live:start', async ({
    sessionId,
    toolProfile = 'default',
  }: {
    sessionId: string;
    toolProfile?: LiveToolProfile;
  }) => {
    try {
      if (socket.data.conversableSessionId && socket.data.conversableSessionId !== sessionId) {
        throw new Error('Session ID mismatch for conversable socket');
      }

      const userId = getEffectiveLiveUserId(socket);
      console.log(`[liveVoice] live:start received for session ${sessionId} on socket ${socket.id}`);
      await startLiveSession(sessionId, socket.id, liveEmit, userId, toolProfile);

      // Authorization and Gemini start both completed. Only now grant the
      // socket-local capability used by stream-end/report handlers. If the
      // socket disconnected while start was in flight, its disconnect cleanup
      // could not see this session yet, so close it here instead of orphaning it.
      if (!socket.connected) {
        closeLiveSession(sessionId, socket.id);
        return;
      }
      if (!socket.data.liveSessions) socket.data.liveSessions = new Set<string>();
      socket.data.liveSessions.add(sessionId);
      console.log(`[liveVoice] live:start completed for session ${sessionId}`);
    } catch (err: any) {
      socket.data.liveSessions?.delete(sessionId);
      console.error(`[liveVoice] live:start error for session ${sessionId}:`, err?.message);
      socket.emit('live:error', {
        sessionId,
        error: err?.message ?? 'Failed to start live session',
      });
    }
  });
}
