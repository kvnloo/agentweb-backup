/**
 * Live-socket cleanup for session termination on password change.
 *
 * The socket auth gate (`io.use` in server.ts) only runs at CONNECT time, so an
 * already-open socket survives a password change until it happens to reconnect.
 * To actually log other devices out on a `sessionVersion` bump we must sweep the
 * user's live sockets and drop the stale ones.
 *
 * `io` is injected via `registerIo` (called from server.ts) rather than imported
 * directly: server.ts has an unguarded `server.listen`, so importing it from the
 * controllers would boot a real server inside unit tests. DI keeps this module
 * dependency-free and the controllers testable without mocking the socket layer.
 */

interface DisconnectableSocket {
  data?: { user?: { sv?: number } };
  disconnect(close?: boolean): void;
}

interface MinimalIo {
  in(room: string): { fetchSockets(): Promise<DisconnectableSocket[]> };
}

let ioRef: MinimalIo | null = null;

export function registerIo(io: MinimalIo): void {
  ioRef = io;
}

/**
 * Force-disconnect a user's live websockets whose token predates
 * `minSessionVersion`. Each authenticated socket joins the room `user:${userId}`
 * and carries the decoded token (including `sv`) on `socket.data.user`. Only
 * sockets behind the new version are dropped — the device that just changed its
 * password reconnects with a fresh token (new `sv`) and is left untouched once
 * it does, while other-device sockets are killed and cannot re-establish.
 *
 * Best-effort: never throws (a realtime cleanup failure must not break the
 * password-change request). Returns the number of sockets disconnected.
 */
export async function disconnectStaleUserSockets(
  userId: string,
  minSessionVersion: number,
): Promise<number> {
  if (!ioRef) return 0;
  try {
    const sockets = await ioRef.in(`user:${userId}`).fetchSockets();
    let disconnected = 0;
    for (const socket of sockets) {
      const sv = Number(socket.data?.user?.sv ?? 0);
      if (sv < minSessionVersion) {
        socket.disconnect(true);
        disconnected++;
      }
    }
    return disconnected;
  } catch (error) {
    console.error('disconnectStaleUserSockets error:', error);
    return 0;
  }
}
