import { randomBytes } from 'crypto';
import type { SimResponse } from './types';

/**
 * Meta Graph error envelope. Every failure the simulator emits goes through here so the
 * product's existing Meta error handling (which switches on `error.code` / `error_subcode`)
 * sees exactly the shapes it sees from graph.facebook.com.
 */
export interface GraphErrorBody {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  fbtrace_id: string;
  error_user_title?: string;
  error_user_msg?: string;
}

export function fbtraceId(): string {
  return randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 11).padEnd(11, 'A');
}

export class GraphError extends Error {
  readonly status: number;
  readonly graphError: GraphErrorBody;

  constructor(init: { code: number; message: string; type?: string; subcode?: number; status?: number; userTitle?: string; userMsg?: string }) {
    super(init.message);
    this.name = 'GraphError';
    this.status = init.status ?? 400;
    this.graphError = {
      message: init.message,
      type: init.type ?? 'OAuthException',
      code: init.code,
      ...(init.subcode !== undefined ? { error_subcode: init.subcode } : {}),
      fbtrace_id: fbtraceId(),
      ...(init.userTitle ? { error_user_title: init.userTitle } : {}),
      ...(init.userMsg ? { error_user_msg: init.userMsg } : {}),
    };
  }

  toResponse(headers: Record<string, string> = {}): SimResponse {
    return { status: this.status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ error: this.graphError }) };
  }
}

export const graphErrors = {
  /** Unknown / foreign object or edge — what Meta answers for an id you cannot see. */
  unsupportedGet(id: string): GraphError {
    return new GraphError({
      code: 100, subcode: 33, type: 'GraphMethodException',
      message: `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api`,
    });
  },
  invalidParam(message: string): GraphError {
    return new GraphError({ code: 100, message: `(#100) ${message}` });
  },
  invalidToken(): GraphError {
    return new GraphError({ code: 190, subcode: 467, message: 'Error validating access token: The session is invalid because the user logged out.' });
  },
  unknown(): GraphError {
    return new GraphError({ code: 1, status: 500, message: 'An unknown error occurred' });
  },
  /** Writes are refused until the phase-3 write simulator lands; the type makes the cause obvious in logs. */
  sandboxWrite(path: string): GraphError {
    return new GraphError({ code: 100, type: 'SandboxNotAvailable', message: `(#100) Sandbox writes are not available for ${path} in this phase.` });
  },
};
