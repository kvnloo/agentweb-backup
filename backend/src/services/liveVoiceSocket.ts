import type { Socket } from 'socket.io';
import {
  closeLiveSession,
  LiveSessionStartCancelledError,
  startLiveSession,
  type LiveToolProfile,
} from './liveVoiceService';
import { isSessionOwnerRequest } from './shareViewerIdentity';
import type { RestrictionProfileId } from './toolRestrictionProfiles';

interface LiveSocketPrincipal {
  userId?: string;
  delegateAccess?: {
    targetUserId?: string;
  };
}

export interface ConversableSocketAuth {
  conversableToken?: unknown;
  conversableSessionId?: unknown;
  /** ENG-2816: the viewer's own login, when they are signed in; honoured only if it is the session owner's. */
  viewerToken?: unknown;
}

export type ConversableSocketResult =
  | { ok: true; data: { conversableSessionId: string; conversableUserId: string; conversableViewerIsOwner: boolean } }
  | { ok: false; error: string };

/**
 * Authenticate an interactive-share (iShare) socket: the conversable token must match the session's share token and the
 * share must be active. Extracted from the Socket.IO middleware in server.ts so it can be tested as it really runs.
 *
 * ENG-2816: the socket acts as the session owner either way, so the owner and a visitor look the same to every downstream
 * check. `conversableViewerIsOwner` records which one this really is: true only when the portal also sent the viewer's own
 * login (`viewerToken`) and it is the session owner's. Anything else, including a bad or missing `viewerToken`, is a
 * visitor and never fails the connection.
 */
export async function authenticateConversableSocket(
  auth: ConversableSocketAuth,
  getSession: (sessionId: string) => Promise<any>,
): Promise<ConversableSocketResult> {
  try {
    const conversableSessionId = String(auth.conversableSessionId);
    const session = await getSession(conversableSessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    const interactiveToken = session.interactiveShareMetadata?.token;
    if (!interactiveToken || interactiveToken !== auth.conversableToken) {
      return { ok: false, error: 'Invalid conversable token' };
    }
    if (!session.interactiveShareMetadata?.isActive) {
      return { ok: false, error: 'Interactive share is not active' };
    }
    const viewerIsOwner =
      typeof auth.viewerToken === 'string' && auth.viewerToken.length > 0
        ? await isSessionOwnerRequest({ headers: { authorization: `Bearer ${auth.viewerToken}` } }, session.userId)
        : false;
    // Leaves a trace of the decision (no token): it is the only place voice decides owner versus visitor, and nothing else
    // records it, so a production check can see which one a call was treated as.
    console.log(`[ENG-2816] voice socket for share link ${conversableSessionId}: the viewer is ${viewerIsOwner ? 'the session owner' : 'a visitor'}`);
    return {
      ok: true,
      data: { conversableSessionId, conversableUserId: session.userId, conversableViewerIsOwner: viewerIsOwner },
    };
  } catch {
    return { ok: false, error: 'Conversable auth error' };
  }
}

/**
 * ENG-2816: the restriction a live voice session runs under. An interactive-share socket that is not the session owner's own
 * logged-in view is a share-link visitor, and gets the same tool restrictions as a visitor in typed chat. Regular
 * (signed-in) sockets are unrestricted, as before.
 */
export function getLiveRestrictionProfile(socket: Socket): RestrictionProfileId | undefined {
  if (!socket.data.conversableSessionId) return undefined;
  return socket.data.conversableViewerIsOwner === true ? undefined : 'share_visitor';
}

function getPendingLiveStarts(socket: Socket): Map<string, AbortController> {
  if (!socket.data.pendingLiveStarts) {
    socket.data.pendingLiveStarts = new Map<string, AbortController>();
  }
  return socket.data.pendingLiveStarts;
}

export function cancelPendingLiveStart(socket: Socket, sessionId: string): void {
  getPendingLiveStarts(socket).get(sessionId)?.abort();
}

export function registerLiveCloseHandler(socket: Socket): void {
  socket.on('live:close', ({ sessionId }: { sessionId: string }) => {
    cancelPendingLiveStart(socket, sessionId);
    closeLiveSession(sessionId, socket.id);
    socket.data.liveSessions?.delete(sessionId);
  });
}

function cancelAllPendingLiveStarts(socket: Socket): void {
  for (const controller of getPendingLiveStarts(socket).values()) {
    controller.abort();
  }
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
  socket.once('disconnect', () => cancelAllPendingLiveStarts(socket));

  socket.on('live:start', async ({
    sessionId,
    toolProfile = 'default',
  }: {
    sessionId: string;
    toolProfile?: LiveToolProfile;
  }) => {
    const pendingStarts = getPendingLiveStarts(socket);
    pendingStarts.get(sessionId)?.abort();
    const controller = new AbortController();
    pendingStarts.set(sessionId, controller);

    try {
      if (socket.data.conversableSessionId && socket.data.conversableSessionId !== sessionId) {
        throw new Error('Session ID mismatch for conversable socket');
      }

      const userId = getEffectiveLiveUserId(socket);
      console.log(`[liveVoice] live:start received for session ${sessionId} on socket ${socket.id}`);
      await startLiveSession(
        sessionId,
        socket.id,
        liveEmit,
        userId,
        toolProfile,
        controller.signal,
        getLiveRestrictionProfile(socket),
      );

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
      if (err instanceof LiveSessionStartCancelledError) return;
      console.error(`[liveVoice] live:start error for session ${sessionId}:`, err?.message);
      socket.emit('live:error', {
        sessionId,
        error: err?.message ?? 'Failed to start live session',
        // ENG-2957: 'usage_paused' when the allowance refused the call.
        ...(err?.code === 'usage_paused' ? { code: 'usage_paused' } : {}),
      });
    } finally {
      if (pendingStarts.get(sessionId) === controller) pendingStarts.delete(sessionId);
    }
  });
}
