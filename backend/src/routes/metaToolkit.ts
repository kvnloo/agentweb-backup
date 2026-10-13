/**
 * ENG-2288 — HTTP surface for the Meta Toolkit (ENG-2268 child 4).
 *
 * Mounts the ENG-2283 gateway so an external agent can list and call the ENG-2282 manifest:
 *   GET  /api/meta-toolkit/tools              -> manifest (bearer auth required)
 *   POST /api/meta-toolkit/tools/:name/call   -> handleMetaToolkitCall
 * Auth, account resolution, reads-only enforcement and metering all live in the gateway; this file only
 * maps HTTP <-> gateway and errors -> status codes. No new storage.
 */
import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  authenticateMetaToolkitCaller,
  handleMetaToolkitCall,
  MetaToolkitAuthError,
} from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest, MetaToolkitRefusal } from '../mcp/metaToolkitManifest';
import { rateLimiter } from '../middleware/rateLimiter';
import { buildMcpAuthChallenge, getBackendUrl, META_TOOLKIT_MCP_RESOURCE_PATH } from '../mcp/oauth/authChallenge';

/** Per-IP request ceiling, applied before bearer auth so unauthenticated floods are throttled too. */
export const META_TOOLKIT_MAX_PER_MINUTE = 60;

export function sendMetaToolkitError(res: Response, error: unknown) {
  if (error instanceof MetaToolkitAuthError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof MetaToolkitRefusal) {
    return res.status(400).json({ error: error.message });
  }
  console.error('[meta-toolkit] call failed:', error instanceof Error ? error.message : error);
  return res.status(500).json({ error: 'Meta Toolkit call failed.' });
}

const router = Router();

router.use((req: Request, res: Response, next) => {
  const result = rateLimiter.check(`meta-toolkit:${req.ip ?? 'unknown'}`, META_TOOLKIT_MAX_PER_MINUTE);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(result.resetInMs / 1000)));
    return res.status(429).json({ error: 'Too many Meta Toolkit requests. Try again shortly.' });
  }
  return next();
});

/** ENG-2303 P5 — public agent guide for the toolkit (served from backend/docs, like /skill.md). */
router.get('/skill.md', (_req: Request, res: Response) => {
  try {
    res.type('text/markdown').send(fs.readFileSync(path.join(__dirname, '../../docs/meta-toolkit-skill.md'), 'utf-8'));
  } catch {
    res.status(404).json({ error: 'Documentation not found' });
  }
});

router.get('/tools', async (req: Request, res: Response) => {
  try {
    await authenticateMetaToolkitCaller(req.headers.authorization);
    return res.json({ tools: getMetaToolkitManifest() });
  } catch (error) {
    return sendMetaToolkitError(res, error);
  }
});

router.post('/tools/:name/call', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const result = await handleMetaToolkitCall({
      authorization: req.headers.authorization,
      toolName: req.params.name,
      args: body.args && typeof body.args === 'object' ? body.args : {},
      sessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
      userAgent: req.get('user-agent') ?? undefined,
    });
    return res.json({ result });
  } catch (error) {
    return sendMetaToolkitError(res, error);
  }
});

/**
 * ENG-2295 — stateless MCP (JSON-RPC 2.0) surface so an MCP client such as Claude can add the
 * toolkit as a remote server (`claude mcp add --transport http <base>/api/meta-toolkit/mcp`).
 * Same gateway as the REST routes above: auth, account resolution, reads-only enforcement and metering are
 * not re-implemented here. No session state, no storage.
 */
export const META_TOOLKIT_MCP_PROTOCOL_VERSION = '2025-06-18';
const META_TOOLKIT_MCP_SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26']);

function isValidRpcId(id: unknown) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));
}

function rpcResult(res: Response, id: unknown, result: unknown) {
  return res.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: Response, id: unknown, code: number, message: string, httpStatus = 200) {
  return res.status(httpStatus).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResultContent(result: unknown) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  return [{ type: 'text', text }];
}

// No SSE stream is offered; MCP Streamable HTTP requires 405 for GET in that case.
router.get('/mcp', (_req: Request, res: Response) => {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({ error: 'Method Not Allowed' });
});

router.post('/mcp', async (req: Request, res: Response) => {
  const msg = req.body;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(res, msg?.id, -32600, 'Invalid Request', 400);
  }
  const { id, method } = msg;
  if (id !== undefined && !isValidRpcId(id)) {
    return rpcError(res, null, -32600, 'Invalid Request: id must be a string or integer', 400);
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  // Notifications (no id) never get a response body.
  if (method.startsWith('notifications/') || id === undefined) {
    return res.status(202).end();
  }

  try {
    switch (method) {
      case 'initialize':
        // MCP authorization: the protected resource answers an unauthenticated initialize with
        // 401 + an RFC 9728 challenge, which is what makes Claude Code / Codex open the browser
        // OAuth login. Serving initialize anonymously left clients "connected" with no tools.
        await authenticateMetaToolkitCaller(req.headers.authorization);
        return rpcResult(res, id, {
          protocolVersion:
            typeof params.protocolVersion === 'string' && META_TOOLKIT_MCP_SUPPORTED_VERSIONS.has(params.protocolVersion)
              ? params.protocolVersion
              : META_TOOLKIT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentweb-meta-toolkit', version: '1.0.0' },
        });
      case 'ping':
        return rpcResult(res, id, {});
      case 'tools/list':
        await authenticateMetaToolkitCaller(req.headers.authorization);
        return rpcResult(res, id, { tools: getMetaToolkitManifest() });
      case 'tools/call': {
        if (typeof params.name !== 'string' || !params.name) {
          return rpcError(res, id, -32602, 'Invalid params: tools/call requires a tool name.');
        }
        if (
          params.arguments !== undefined &&
          (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments))
        ) {
          return rpcError(res, id, -32602, 'Invalid params: tools/call arguments must be an object.');
        }
        try {
          const result = await handleMetaToolkitCall({
            authorization: req.headers.authorization,
            toolName: params.name,
            args: params.arguments && typeof params.arguments === 'object' ? params.arguments : {},
            sessionId: req.get('mcp-session-id') ?? undefined,
            userAgent: req.get('user-agent') ?? undefined,
          });
          return rpcResult(res, id, { content: toolResultContent(result), isError: false });
        } catch (error) {
          // A refusal is a tool-level failure the model should see, not a transport error.
          if (error instanceof MetaToolkitRefusal) {
            return rpcResult(res, id, { content: toolResultContent(error.message), isError: true });
          }
          throw error;
        }
      }
      default:
        return rpcError(res, id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof MetaToolkitAuthError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      if (error.status === 401) {
        res.setHeader(
          'WWW-Authenticate',
          buildMcpAuthChallenge(
            getBackendUrl(),
            req.headers.authorization ? 'invalid_token' : undefined,
            META_TOOLKIT_MCP_RESOURCE_PATH,
          ),
        );
      }
      return rpcError(res, id, -32001, error.message, error.status);
    }
    console.error('[meta-toolkit] MCP call failed:', error instanceof Error ? error.message : error);
    return rpcError(res, id, -32603, 'Meta Toolkit call failed.');
  }
});

export default router;
