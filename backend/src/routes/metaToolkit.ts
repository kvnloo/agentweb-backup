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
import { googleToolkitEnabled } from '../mcp/zomaToolDefinitions';
import { annotateToolkitTools } from '../mcp/toolkitToolAnnotations';
import { databricksToolView } from '../mcp/zomaDatabricksReadOnly';
import { rateLimiter } from '../middleware/rateLimiter';
import { buildMcpAuthChallenge, getBackendUrl, META_TOOLKIT_MCP_RESOURCE_PATH } from '../mcp/oauth/authChallenge';
import { validateRef } from '../services/journeyAttribution';
import { toZomaVoice, zomaErrorNextStep, zomaNextStep } from '../mcp/zomaNextStep';
import { ZOMA_ADS_EXPERIENCE_QUESTION, ZOMA_WELCOME } from '../mcp/zomaAdsExperience';

/** Per-IP request ceiling, applied before bearer auth so unauthenticated floods are throttled too. */
export const META_TOOLKIT_MAX_PER_MINUTE = 60;

export function sendMetaToolkitError(res: Response, error: unknown) {
  if (error instanceof MetaToolkitAuthError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    if (error.status === 403) return res.status(403).json({ error: toZomaVoice(error.message), next_step: zomaErrorNextStep(error.message) });
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof MetaToolkitRefusal) {
    return res.status(400).json({ error: toZomaVoice(error.message), next_step: zomaErrorNextStep(error.message) });
  }
  console.error('[meta-toolkit] call failed:', error instanceof Error ? error.message : error);
  return res.status(500).json({ error: 'Meta Toolkit call failed.' });
}

/**
 * ENG-2823: Meta tools + Zoma tools, plus the Google Ads provider's tools while it is enabled.
 * The Google manifest is loaded lazily so the Meta-only path never imports it.
 */
function toolkitManifest() {
  // ENG-2747: every advertised tool carries MCP annotations (deny-by-default; see toolkitToolAnnotations.ts).
  if (!googleToolkitEnabled()) return annotateToolkitTools(getMetaToolkitManifest());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getGoogleToolkitManifest } = require('../mcp/googleToolkitManifest') as typeof import('../mcp/googleToolkitManifest');
  return annotateToolkitTools([...getMetaToolkitManifest(), ...getGoogleToolkitManifest()]);
}

/** ENG-2747 (option B): Databricks-origin callers see only the tools they may call. */
function toolsFor(caller: { databricksOrigin?: boolean } | undefined) {
  const tools = toolkitManifest();
  return caller?.databricksOrigin ? databricksToolView(tools) : tools;
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
    const caller = await authenticateMetaToolkitCaller(req.headers.authorization);
    return res.json({ tools: toolsFor(caller) });
  } catch (error) {
    return sendMetaToolkitError(res, error);
  }
});

router.post('/tools/:name/call', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const result = await handleMetaToolkitCall({
      authorization: req.headers.authorization,
      toolName: req.params.name,
      args,
      sessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
      userAgent: req.get('user-agent') ?? undefined,
    });
    // ENG-3134: every response names the next step (zoma_status carries its own in `result`).
    const next = zomaNextStep(req.params.name, args, result);
    return res.json({ result, ...(next ? { next_step: next } : {}) });
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

/**
 * ENG-3134: the result as text (Emma-app references rewritten for Zoma), then — on every response
 * except the friend path and zoma_status, which carry their own — one "Next step:" line.
 */
function toolResultContent(result: unknown, nextStep: string | null) {
  // The friend path is exactly its one sentence (zoma_status for a "just a friend" answer).
  const friend = (result as any)?.ads_experience === 'not_interested' && typeof (result as any)?.summary === 'string';
  const text = friend ? (result as any).summary : toZomaVoice(typeof result === 'string' ? result : JSON.stringify(result ?? null));
  return [{ type: 'text', text }, ...(nextStep ? [{ type: 'text', text: `Next step: ${nextStep}` }] : [])];
}

/**
 * ENG-3134: MCP `instructions` (shown to the agent on connect). The first thing the user hears is
 * the welcome, then one question; zoma_status records the answer and returns the Meta connect link.
 */
export const ZOMA_MCP_INSTRUCTIONS = [
  `${ZOMA_WELCOME} Zoma lets you run the user's Meta (and Google) ads safely from this chat.`,
  `On first connect, greet the user with exactly "${ZOMA_WELCOME}" and ask one question: "${ZOMA_ADS_EXPERIENCE_QUESTION}". ` +
    'Call zoma_status to get the answer options, then call zoma_status again with ads_experience set to their answer; it returns the next step (usually the Meta connect link). Relay it as given.',
  'Once an ad account is connected, zoma_ads_report answers spend, impressions, clicks, CTR, CPC, conversions and ROAS by campaign for any date range. ' +
    'Every change to ads is a two-step preview → confirm; never confirm without the user\'s explicit approval. Each tool response ends with the next step to take.',
].join('\n');

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
          serverInfo: { name: 'agentweb-meta-toolkit', title: 'Zoma', version: '1.0.0' },
          instructions: ZOMA_MCP_INSTRUCTIONS,
        });
      case 'ping':
        return rpcResult(res, id, {});
      case 'tools/list': {
        const caller = await authenticateMetaToolkitCaller(req.headers.authorization);
        return rpcResult(res, id, { tools: toolsFor(caller) });
      }
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
        const callArgs = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          const result = await handleMetaToolkitCall({
            authorization: req.headers.authorization,
            toolName: params.name,
            args: callArgs,
            sessionId: req.get('mcp-session-id') ?? undefined,
            userAgent: req.get('user-agent') ?? undefined,
            // ENG-2906: `?ref=` on the MCP URL; validated (or dropped) when the event is recorded.
            ref: typeof req.query.ref === 'string' ? req.query.ref : undefined,
          });
          return rpcResult(res, id, { content: toolResultContent(result, zomaNextStep(params.name, callArgs, result)), isError: false });
        } catch (error) {
          // A refusal is a tool-level failure the model should see, not a transport error.
          if (error instanceof MetaToolkitRefusal) {
            return rpcResult(res, id, { content: toolResultContent(error.message, zomaErrorNextStep(error.message)), isError: true });
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
            validateRef(req.query.ref), // ENG-2906: carry ?ref= into the resource metadata
          ),
        );
      }
      // ENG-3134: a 403 is about the caller's own setup ("No usable Meta ad account is connected"); say the fix.
      const message = error.status === 403 ? `${toZomaVoice(error.message)} Next step: ${zomaErrorNextStep(error.message)}` : error.message;
      return rpcError(res, id, -32001, message, error.status);
    }
    console.error('[meta-toolkit] MCP call failed:', error instanceof Error ? error.message : error);
    return rpcError(res, id, -32603, 'Meta Toolkit call failed.');
  }
});

export default router;
