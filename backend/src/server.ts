import { requireActiveEvaluation } from './services/evaluationPolicy';
import { evaluationSocketDecision } from './utils/socketEvaluationAuth';
import { installSandboxMetaInterceptorAtBoot } from './services/sandbox/bootstrap';
import app from './app';
import { isCronEnabled, disableCron, shouldBootstrapBackgroundJobs } from './utils/instanceState';
import { cronJobRegistry } from './utils/cronJobRegistry';
import { DRAIN_CEILING_MS } from './utils/shutdownConstants';
import { agentModeService } from './services/agentModeService';
import { generateMarketingResponseWorkerService } from './services/generateMarketingResponseWorkerService';
import dotenv from 'dotenv';
import { getJwtSecret, assertJwtSecretAtBoot } from './config/jwt';
import { logServiceSecretResolutionAtBoot } from './middleware/serviceAuth';
import bcrypt from 'bcryptjs';
import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { chatbotDb } from './services/chatbotService';
import { userDb } from './services/db';
import { registerIo } from './services/sessionSockets';
import { handleSocketChatMessage } from './services/chatSocketHandler';
import {
  sendAudioChunk,
  sendAudioStreamEnd,
  sendTextTurn,
  closeLiveSession,
  hasLiveSession,
  drainLiveVoiceToolExecutions,
} from './services/liveVoiceService';
import {
  getEffectiveLiveUserId,
  registerLiveCloseHandler,
  registerLiveStartHandler,
  authenticateConversableSocket,
} from './services/liveVoiceSocket';
import {
  ONBOARDING_TELEMETRY_EVENTS,
  recordOnboardingEvent,
} from './services/onboardingTelemetry';
import { createFathomLinearPort } from './services/fathomLinearProductionPort';
import { registerFathomLinearPort } from './services/fathomLinearPortRegistry';

dotenv.config();

// Production composition root for the Fathom → Linear router. The adapter is
// inert until a signed recording.ready webhook reaches the router; credentials
// are resolved lazily through linearService on the first Linear operation.
registerFathomLinearPort(createFathomLinearPort());

// Fail fast at boot (before binding the port) if the JWT secret is missing, rather than
// letting tokens be signed/verified with a fallback secret or erroring on first request.
assertJwtSecretAtBoot();

// Best-effort visibility only (ENG-1754 AC3) — never blocks/delays binding the port.
logServiceSecretResolutionAtBoot().catch((err) =>
  console.error('[serviceAuth] boot-time secret resolution check failed:', err)
);

const port = process.env.PORT || 3001;
const server = http.createServer(app);

// Initialize Socket.IO with CORS settings
const io = new Server(server, {
  cors: {
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      const allowedOrigins = [
        /^https:\/\/[a-zA-Z0-9\-]+\.agentweb\.pro$/,
        'https://agentweb.pro',
        'http://localhost:5173',
        'http://localhost:5174',
        process.env.FRONTEND_URL || 'http://localhost:5173',
        process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174',
      ];

      // Same fail-closed production gate as the HTTP CORS config in app.ts
      // (ENG-1751): ngrok tunnels are a local-dev convenience and must not be
      // a credentialed origin in production. `NODE_ENV !== 'production'` was
      // fail-open (no tracked EB config sets NODE_ENV=production explicitly);
      // require an explicit NODE_ENV=development or the CORS_ALLOW_NGROK=1
      // opt-in instead.
      if (
        process.env.NODE_ENV === 'development' ||
        process.env.CORS_ALLOW_NGROK === '1'
      ) {
        allowedOrigins.push(
          /^https:\/\/[a-zA-Z0-9\-]+\.ngrok-free\.app$/, // Allow any ngrok-free.app subdomain
          /^https:\/\/[a-zA-Z0-9\-]+\.ngrok\.io$/ // Allow any ngrok.io subdomain
        );
      }

      if (!origin) return callback(null, true);

      const isAllowed = allowedOrigins.some(allowedOrigin => {
        if (allowedOrigin instanceof RegExp) {
          return allowedOrigin.test(origin);
        }
        return origin === allowedOrigin;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Export io instance for use in routes
export { io };

// Make io available to disconnectStaleUserSockets without a circular import.
registerIo(io);

// Middleware to authenticate WebSocket connections
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  const conversableToken = socket.handshake.auth.conversableToken;
  const conversableSessionId = socket.handshake.auth.conversableSessionId;

  if (token) {
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as {
        userId?: string;
        email?: string;
        sv?: number;
        dte?: number;
        delegateAccess?: unknown;
        _svc?: boolean;
        isAdmin?: boolean;
      };

      // Sandbox principals stream Emma over this socket like any customer, on the
      // same policy check as the HTTP layer; the primary record is read by email
      // because a just-provisioned account may not be in the userId GSI yet.
      const evaluationDecision = await evaluationSocketDecision(decoded, requireActiveEvaluation,
        async claims => (typeof claims.email === 'string' ? userDb.getUserByEmailConsistent(claims.email) : null));
      if (evaluationDecision === 'deny') return next(new Error('Authentication error'));
      if (evaluationDecision === 'allow') {
        socket.data.user = decoded;
        return next();
      }

      // Enforce session versioning for normal user tokens so a password change
      // disconnects other devices' sockets too. Delegate/service tokens are
      // exempt (same policy as the HTTP auth middleware).
      //
      // Use `<` (token behind server), NOT `!==`: getUserById reads an
      // eventually-consistent GSI, so a freshly-issued token (higher `sv`) must
      // not be rejected just because the GSI replica still holds the old value.
      if (decoded.userId && !decoded.delegateAccess && !decoded._svc) {
        const user = await userDb.getUserById(decoded.userId);
        if (!user || (decoded.sv ?? 0) < (user.sessionVersion ?? 0)) {
          return next(new Error('Authentication error'));
        }
      }

      socket.data.user = decoded;
      return next();
    } catch {
      return next(new Error('Authentication error'));
    }
  }

  // Allow conversable (iShare) sockets — validate token against session in DynamoDB
  if (conversableToken && conversableSessionId) {
    const result = await authenticateConversableSocket(socket.handshake.auth, (id) => chatbotDb.getChatSession(id));
    if (!result.ok) return next(new Error(result.error));
    Object.assign(socket.data, result.data);
    return next();
  }

  return next(new Error('Authentication error'));
});

// WebSocket connection handling
io.on('connection', (socket: Socket) => {
  console.log('Client connected:', socket.id);

  // Auto-join user-specific room for targeted broadcasts
  try {
    const token = socket.handshake.auth.token;
    if (token) {
      const decoded = jwt.verify(token, getJwtSecret()) as { userId: string };
      if (decoded.userId) {
        socket.join(`user:${decoded.userId}`);
      }
    }
  } catch {
    // Ignore auth errors for room join — socket still works for other purposes
  }

  socket.on('error', (error: Error) => {
    console.error('Socket error:', error);
  });

  socket.on('disconnect', (reason: string) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    // Clean up any live voice sessions owned by this socket
    socket.data.liveSessions?.forEach((sessionId: string) => {
      if (hasLiveSession(sessionId)) {
        closeLiveSession(sessionId, socket.id);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Gemini Live Voice handlers
  // ---------------------------------------------------------------------------

  registerLiveStartHandler(socket);
  registerLiveCloseHandler(socket);

  socket.on('live:audio', ({ sessionId, chunk }: { sessionId: string; chunk: string }) => {
    console.log(`[liveVoice] live:audio received for session ${sessionId}, hasSession=${hasLiveSession(sessionId)}`);
    sendAudioChunk(sessionId, chunk, socket.id).catch((err) => {
      socket.emit('live:error', { sessionId, error: err?.message });
    });
  });

  socket.on('live:audio-stream-end', ({ sessionId }: { sessionId: string }) => {
    if (!sessionId || !socket.data.liveSessions?.has(sessionId)) {
      socket.emit('live:error', { sessionId, error: 'No active voice session' });
      return;
    }
    console.warn(`[liveVoice] live:audio-stream-end received for session ${sessionId}`);
    sendAudioStreamEnd(sessionId, socket.id).catch((err) => {
      socket.emit('live:error', { sessionId, error: err?.message });
    });
  });

  socket.on('live:text', async ({ sessionId, text }: { sessionId: string; text: string }) => {
    try {
      console.log(`[liveVoice] live:text received for session ${sessionId}, hasSession=${hasLiveSession(sessionId)}`);
      await sendTextTurn(sessionId, text, socket.id);
    } catch (err: any) {
      console.error(`[liveVoice] live:text error for session ${sessionId}:`, err?.message);
      socket.emit('live:error', { sessionId, error: err?.message });
    }
  });

  socket.on('live:report-issue', async ({
    sessionId,
    phase,
    breadcrumbs,
  }: {
    sessionId: string;
    phase?: string;
    breadcrumbs?: unknown[];
  }) => {
    try {
      if (!sessionId || !socket.data.liveSessions?.has(sessionId)) {
        throw new Error('No active voice session for this report');
      }
      const userId = getEffectiveLiveUserId(socket);
      const safePhase = typeof phase === 'string' ? phase.slice(0, 40) : 'unknown';
      const safeBreadcrumbs = Array.isArray(breadcrumbs)
        ? JSON.stringify(breadcrumbs.slice(-25)).slice(0, 2_500)
        : '[]';

      console.warn('[voiceOnboardingTelemetry] tester reported an issue', {
        sessionId,
        userId,
        phase: safePhase,
        breadcrumbs: safeBreadcrumbs,
      });
      await recordOnboardingEvent(
        userId,
        ONBOARDING_TELEMETRY_EVENTS.voiceIssueReported,
        {
          sessionId,
          phase: safePhase,
          breadcrumbs: safeBreadcrumbs,
        },
      );
      socket.emit('live:report-received', { sessionId });
    } catch (err: any) {
      console.error('[voiceOnboardingTelemetry] report failed', err?.message);
      socket.emit('live:report-error', {
        sessionId,
        error: 'Could not save this report. Try again.',
      });
    }
  });

  // Handle chat messages
  //
  // ENG-1189: this Emma-chatbot turn runs in-process (no fork) and can
  // dispatch MCP tools (including manage_scheduled_chat) via
  // agentModeService.executeTool, but — unlike the Agent Mode /generate
  // family — it was never tracked as in-flight work, so runDrain()'s wait
  // below wouldn't hold the listener open for it. cronJobRegistry.track() is
  // a drop-in wrap (untouched resolution/rejection), so this is a pure
  // addition, not a behavior change.
  socket.on('message', (data: {
    sessionId: string;
    message: string;
    currentUrl?: string;
    pageContent?: string;
    portal?: 'customer' | 'partner';
  }) => cronJobRegistry.track('chatbotTurn', handleSocketChatMessage(socket, data)));

  // Implement automatic reconnection
  socket.on('reconnect_attempt', () => {
    console.log('Client attempting to reconnect:', socket.id);
  });

  socket.on('reconnect', () => {
    console.log('Client reconnected:', socket.id);
  });
});

// Create test account
async function createTestAccount() {
  try {
    const { TEST_EMAIL, TEST_PASSWORD } = process.env;
    if (!TEST_EMAIL || !TEST_PASSWORD) {
      console.log('Test account credentials not found in .env');
      return;
    }

    // Access the users object from the auth controller
    const users = (global as any).users || {};

    // Check if test account already exists
    if (users[TEST_EMAIL]) {
      console.log('Test account already exists');
      return;
    }

    // Create test account
    const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 10);
    users[TEST_EMAIL] = {
      id: 'test-user-id',
      email: TEST_EMAIL,
      password: hashedPassword,
    };
    (global as any).users = users;

    console.log('Test account created successfully');
  } catch (error) {
    console.error('Error creating test account:', error);
  }
}

// Error handling for the server
server.on('error', (error: Error) => {
  console.error('Server error:', error);
});

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Drain every in-flight unit of work, WITHOUT exiting.
//
// Split out of gracefulShutdown for ENG-764: the ASG termination guard needs to
// drain and then still be alive to answer its lifecycle hook (an exit here would
// strand the instance in Terminating:Wait until the hook timed out). Memoized on
// the promise, so the SIGTERM that follows an ASG-initiated drain joins the
// in-progress drain instead of starting a second one.
let drainPromise: Promise<void> | null = null;

const drainForShutdown = (reason: string): Promise<void> => {
  drainPromise ??= runDrain(reason);
  return drainPromise;
};

const runDrain = async (reason: string): Promise<void> => {
  console.log(`\n${reason}: draining in-flight work...`);

  // Register force-exit FIRST so it's always set, even if an await below hangs.
  // Force-exit buffer = drain ceiling + 3 min.
  // EB Timeout: 900 s (15 min) sits above this so EB never force-kills first.
  setTimeout(() => {
    console.error('[gracefulShutdown] Force-exiting after drain ceiling');
    process.exit(1);
  }, DRAIN_CEILING_MS + 3 * 60 * 1000).unref();

  const drainDeadline = Date.now() + DRAIN_CEILING_MS;
  const remainingDrainMs = () => Math.max(0, drainDeadline - Date.now());

  // 1. Disable cron immediately — agent-engine's next /run-scheduled-chats call
  //    gets 503 and reroutes to the new instance within one 5-second poll cycle.
  //    All setInterval/setTimeout workers skip their next tick.
  disableCron();

  // 2. Stop the proactive MCP OAuth refresh scheduler
  try {
    const { stopMcpOAuthRefreshScheduler } = await import('./mcp/client/mcpOAuthRefreshService');
    stopMcpOAuthRefreshScheduler();
  } catch {
    // ignore — scheduler may not have started
  }

  // 3. Drain admitted cron/MCP, interactive session, and live-voice work
  //    concurrently. Keep the worker accepting work until these upstream turns
  //    settle: an admitted MCP call may still be persisting before it dispatches
  //    to the worker. Both phases share one deadline, not two drain ceilings.
  //
  //    This MUST run BEFORE the HTTP listener closes below (ENG-1189): every
  //    one of these self-calls back into THIS process via mcpFetch's
  //    http://localhost:${PORT} — the marketing-response worker is a forked
  //    child process that inherits the same PORT, and an interactive turn's
  //    (or a live-voice tool call's) tool calls run right here. Closing the
  //    listener first (as this used to do) meant any of that in-flight
  //    work's self-calls failed with an unrecoverable "fetch failed" for the
  //    rest of the process's life — not a transient blip, since
  //    server.close() refuses every new loopback connection a retry would
  //    need, no matter how long the retry waits.
  const { drainActiveSessionGenerations } = await import('./controllers/agentModeController');
  const [cronDrain, sessionDrain, liveVoiceDrain] = await Promise.all([
    cronJobRegistry.drain(remainingDrainMs()),
    drainActiveSessionGenerations(remainingDrainMs()),
    drainLiveVoiceToolExecutions(remainingDrainMs()),
  ]);
  await generateMarketingResponseWorkerService.shutdown(remainingDrainMs());
  // ENG-2113: a Claude-plan tool call that was still running when its turn ended is looked for one last time and saved, so it is not lost with the process.
  await import('./services/funding/claudeCodeBackendInstance')
    .then((m) => m.claudeCodeBackend.flush())
    .catch(() => undefined);
  // ENG-2906: flush queued product-journey events (PostHog batches in memory).
  await import('./services/journeyTracking')
    .then((m) => m.flushJourney())
    .catch(() => undefined);
  // ENG-2110: pending Claude sign-ins hold a child process and a private temp dir.
  await import('./services/funding/claudeSubscriptionService')
    .then((m) => m.shutdownClaudeSubscriptionService())
    .catch(() => undefined);
  // ENG-2110 1c: stops the hosted sign-in timers. Pending sign-ins are NOT cancelled on the login host: any instance can finish them, and the host expires abandoned ones itself.
  await import('./services/funding/hostedSubscriptionService')
    .then((m) => m.shutdownHostedSubscriptionService())
    .catch(() => undefined);
  if (!cronDrain.drained) {
    console.warn(
      `[gracefulShutdown] Cron drain ceiling reached — ${cronDrain.stuckCount} job(s) still in-flight:`,
      cronDrain.stuckJobs
    );
  }
  if (!sessionDrain.drained) {
    console.warn(
      `[gracefulShutdown] Interactive session drain ceiling reached — ${sessionDrain.stuckCount} turn(s) still in-flight`
    );
  }
  if (!liveVoiceDrain.drained) {
    console.warn(
      `[gracefulShutdown] Live voice tool-call drain ceiling reached — ${liveVoiceDrain.stuckCount} call(s) still in-flight`
    );
  }

  // A-019: CallTool handlers are now part of cronJobRegistry's in-flight set,
  // so once the wait above has settled there is no legitimate MCP tool work
  // left to preserve. Close session transports BEFORE the HTTP listener.
  const mcpShutdown = (app as any).mcpShutdown as (() => Promise<void>) | undefined;
  if (mcpShutdown) {
    await mcpShutdown();
  }

  // 4. Stop accepting new HTTP connections — safe now that in-flight
  //    self-calls above have had their chance to complete.
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }
  });

  // 5. Disconnect all Socket.IO clients (they auto-reconnect to the new instance)
  io.close((err) => {
    if (err) {
      console.error('Error closing Socket.IO:', err);
    } else {
      console.log('Socket.IO connections closed');
    }
  });

  // 6. Close parent MCP clients after the drain (child has its own MCP instance)
  await agentModeService.shutdown();

  // 6.5. Flush OTel spans (ENG-141) — best-effort, never rejects, no-op when
  //      tracing is off. Deploy-killed runs are exactly the traces we need.
  await (await import('./observability/tracing')).flushTelemetry();
};

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  await drainForShutdown(signal);

  // Clean exit
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Create test account before starting the server
createTestAccount().then(async () => {

  // Load Stripe credentials from Secrets Manager if env vars are not set
  try {
    const { getStripeCredentials } = await import('./utils/secretsManager');
    await getStripeCredentials();
    console.log('Stripe credentials loaded');
  } catch (error) {
    console.warn('Stripe credentials not available — billing features will be disabled:', (error as Error).message);
  }

  // Initialize enrich.so service (must run BEFORE specialist registration so the
  // enrich.so specialists can resolve via getEnrichSoService()).
  try {
    const { initEnrichSoServiceFromEnv } = await import('./services/enrichSoServiceFactory');
    await initEnrichSoServiceFromEnv();
    console.log('enrich.so service initialized');
  } catch (err) {
    console.warn('enrich.so service not initialized — email finder/reverse lookup specialists will fall back to LLM:', (err as Error).message);
  }

  // Initialize Apollo people-enrichment service. Defensive — a missing API key
  // (Secrets Manager not yet provisioned) must not crash boot. Apollo features
  // simply stay dormant; waterfall router falls back to enrich.so / LLM.
  try {
    const { initApolloServiceFromEnv } = await import('./services/apolloServiceFactory');
    await initApolloServiceFromEnv();
    console.log('Apollo service initialized');
  } catch (err) {
    console.warn('Apollo service not initialized — Apollo specialists will be inert:', (err as Error).message);
  }

  // Load the Okareo trace-exporter key from Secrets Manager (ENG-2070). It was an
  // 856-char EB env var that pushed the env past CloudFormation's 4096-char
  // limit. An explicit OKAREO_API_KEY env still wins; a missing secret leaves
  // the Okareo exporter off, exactly as before (config gating, not a crash).
  if (!process.env.OKAREO_API_KEY) {
    try {
      const { getOkareoApiKey } = await import('./utils/secretsManager');
      process.env.OKAREO_API_KEY = await getOkareoApiKey();
      console.log('Okareo API key loaded from Secrets Manager');
    } catch (err) {
      console.warn('Okareo API key not loaded — Okareo trace export disabled:', (err as Error).message);
    }
  }

  // Initialize Enigma card-revenue lookups (ENG-1388). Defensive like Apollo —
  // without the Secrets Manager key getEnigmaService() stays null and nothing
  // calls Enigma.
  try {
    const { initEnigmaServiceFromEnv } = await import('./services/enigmaServiceFactory');
    await initEnigmaServiceFromEnv();
    console.log('Enigma service initialized');
  } catch (err) {
    console.warn('Enigma service not initialized — card-revenue lookups disabled:', (err as Error).message);
  }

  // Initialize Unipile LinkedIn-profile cache wrapper (cache-first reads of
  // Unipile /users/{id} backed by AW-EnrichmentRawCache, cacheType='unipile').
  try {
    const { initUnipileProfileService } = await import('./services/unipileProfileServiceFactory');
    initUnipileProfileService();
    console.log('Unipile profile cache initialized');
  } catch (err) {
    console.warn('Unipile profile cache not initialized — LinkedIn lookups will hit Unipile live:', (err as Error).message);
  }

  // Initialize Unipile LinkedIn-company cache wrapper (cacheType='unipile_company').
  try {
    const { initUnipileCompanyService } = await import('./services/unipileCompanyServiceFactory');
    initUnipileCompanyService();
    console.log('Unipile company cache initialized');
  } catch (err) {
    console.warn('Unipile company cache not initialized — LinkedIn company lookups will hit Unipile live:', (err as Error).message);
  }

  // Initialize Unipile LinkedIn search-parameter resolver (cacheType='unipile_search_param').
  // Resolves free-text company/location/industry/school → LinkedIn entity IDs
  // for use in classic + sales-navigator search filters.
  try {
    const { initUnipileSearchParamServiceFromEnv } = await import('./services/unipileSearchParamServiceFactory');
    initUnipileSearchParamServiceFromEnv();
    console.log('Unipile search-parameter resolver initialized');
  } catch (err) {
    console.warn('Unipile search-parameter resolver not initialized — searches will not auto-resolve company IDs:', (err as Error).message);
  }

  // Register CRM enrichment specialists (Crunchbase, enrich.so, et al.)
  try {
    const { registerAllEnrichmentSpecialists } = await import('./services/specialists');
    registerAllEnrichmentSpecialists();
    console.log('Enrichment specialists registered');
  } catch (err) {
    console.warn('Failed to register enrichment specialists:', (err as Error).message);
  }

  // ENG-2271: load the admin vendor-rate overrides BEFORE listening, so no usage recording
  // (HTTP request or queue processor) prices a Twilio unit at the defaults while an override
  // exists. Bounded by the read's own 1.5s timeout; a settings outage must not block boot.
  // Skipped under Jest (shouldBootstrapBackgroundJobs), where no settings I/O may happen.
  // (refresh never rejects and logs its own failure once.)
  if (shouldBootstrapBackgroundJobs()) {
    const { refreshVendorRateOverrides } = await import('./utils/vendorRateCard');
    await refreshVendorRateOverrides();
  }

  server.listen(port, async () => {
    console.log(`Server is running on port ${port}`);
    console.log(`WebSocket server is ready`);
    console.log(`Test account email: ${process.env.TEST_EMAIL}`);

    // ENG-1286: everything below this line either schedules a timer or awaits a
    // dynamic import, and under Jest both outlive the test that triggered them.
    // Nothing asks for this — `app.ts` registers `routes/crm.ts`, which imports
    // `../server`, so merely touching `app` boots the real server. The 30-second
    // cron bootstrap then fires long after that file's environment is torn down,
    // resolves every `await import(...)` against a dead module registry, and
    // throws `TypeError: <fn> is not a function` inside an unrelated suite.
    // Returning here — rather than guarding each cron — is deliberate: a guard
    // per job is a list that the next background job will be added without.
    if (!shouldBootstrapBackgroundJobs()) {
      console.log('[server] Test runtime — background jobs not started (ENG-1286)');
      return;
    }

    // ENG-1908: install the sandbox Meta interceptor once, here, in every real runtime
    // (dev/staging/prod) but never under the Jest test-boot path above — same reasoning as
    // the ENG-1286 guard: metaInterceptor.test.ts manages its own install/uninstall lifecycle
    // against the same module-level singleton, and this call is synchronous with no timer or
    // dynamic import, so it carries none of the risk that guard exists for; it just needs to
    // stay on this side of the same line so it doesn't fire during an incidental test boot.
    try {
      installSandboxMetaInterceptorAtBoot();
      console.log('[server] Sandbox Meta interceptor installed');
    } catch (error) {
      console.error('[server] Failed to install sandbox Meta interceptor:', (error as Error).message);
    }

    // ENG-764: an EB deploy terminates this instance without waiting for the
    // drain, killing any in-flight scheduled run. Watch for the ASG's termination
    // signal, drain first, then release the instance. Self-disables off-ASG (local
    // dev, the test box) where the IMDS lifecycle path 404s.
    import('./services/asgLifecycleGuard')
      .then(({ startAsgTerminationGuard }) =>
        startAsgTerminationGuard(() => drainForShutdown('ASG termination'))
      )
      .catch((error) => console.error('Failed to start the ASG termination guard:', error));

    // Self-heal the telemetry/loop tables if missing — fire-and-forget, non-fatal.
    // Prevents the silent-no-op class of bug where a writer swallows
    // ResourceNotFound and a whole loop subsystem runs against a table that
    // was never provisioned (see services/ensureCriticalTables.ts).
    void import('./services/ensureCriticalTables')
      .then(({ ensureCriticalTables }) => ensureCriticalTables())
      .catch((err) => console.error('[startup] ensureCriticalTables failed (non-fatal):', err?.message || err));

    // Register app-wide HubSpot webhook subscriptions once per build (one instance wins the claim).
    import('./utils/hubspotWebhookSubscriptionsBoot')
      .then(({ ensureWebhookSubscriptionsOncePerBuild }) => ensureWebhookSubscriptionsOncePerBuild())
      .then((outcome) => console.log(`[startup] HubSpot webhook subscription sync: ${outcome}`))
      .catch((err) => console.error('[startup] HubSpot webhook subscription sync failed (non-fatal):', err?.message || err));

    // Proactively refresh OAuth tokens for outbound MCP servers before they expire.
    import('./mcp/client/mcpOAuthRefreshService')
      .then(({ startMcpOAuthRefreshScheduler }) => startMcpOAuthRefreshScheduler())
      .catch((error) => console.error('Failed to start MCP OAuth refresh scheduler:', error));

    // Initialize Agent Mode tools in background - don't block server startup
    // This prevents health check timeouts during deployment (e.g. Elastic Beanstalk)
    console.log('Initializing Agent Mode Tools (non-blocking)...');
    agentModeService.initialize()
      .then(() => {
        // initialize() resolves even when a step failed — every step swallows its own
        // errors — so this must report the actual outcome. Logging unconditional success
        // directly beneath the latch's own failure line is how a degraded boot reads as a
        // healthy one, which cost real debugging time on ENG-1852.
        if (agentModeService.isInitialized) {
          console.log('Agent Mode Tools initialized successfully');
        } else {
          console.error(
            'Agent Mode Tools initialization DEGRADED — a later request will retry. ' +
            'See the AgentMode latch error above for which step failed.',
          );
        }
        // Pre-start the worker process so MCP servers are ready before the first chat message
        console.log('Pre-starting worker process...');
        generateMarketingResponseWorkerService.ensureWorkerReady()
          .then(() => console.log('Worker process pre-started and ready'))
          .catch((error) => console.error('Failed to pre-start worker process:', error));
      })
      .catch((error) => console.error('Failed to initialize Agent Mode Tools:', error));

    // Social Engagement Automation
    // Scanner: discovers posts and queues engagement actions — runs every 60 minutes
    // TimerScheduler: every 5 min, registers precise setTimeout for actions due within 10 min
    //   - replaces fixed executor poll; also handles crash recovery (overdue actions fire with delay=0)
    const SCANNER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

    setTimeout(async () => {
      try {
        const { SocialEngagementExecutor, SocialEngagementTimerScheduler } = await import('./cron/socialEngagementExecutor');
        const executor = new SocialEngagementExecutor();
        const timerScheduler = new SocialEngagementTimerScheduler(executor);
        timerScheduler.start();
        console.log('[SocialEngagement] TimerScheduler started.');

        const { SocialEngagementScanner } = await import('./cron/socialEngagementScannerCron');
        // Pass callback: when scanner schedules an action within 30 min, register a direct setTimeout
        const scanner = new SocialEngagementScanner((delayMs) => {
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('SocialEngagementExecutor.processQueue', executor.processQueue())
              .catch(e => console.error('[SocialEngagement] Direct executor error:', e));
          }, delayMs);
        });

        console.log('[SocialEngagement] Scanner initialized — running first pass...');
        cronJobRegistry.track('SocialEngagementScanner', scanner.runScanner())
          .catch(e => console.error('[SocialEngagement] Scanner error:', e));

        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('SocialEngagementScanner', scanner.runScanner())
            .catch(e => console.error('[SocialEngagement] Scanner error:', e));
        }, SCANNER_INTERVAL_MS);

      } catch (error) {
        console.error('[SocialEngagement] Failed to initialize scanner:', error);
      }

      // Activation Analysis Automation — runs daily at 08:00 UTC (00:00 PST / 01:00 PDT)
      try {
        const ACTIVATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
        const { runActivationAnalysis } = await import('./cron/activationAnalysisCron');

        // Calculate delay until next 08:00 UTC
        const nowForCron = new Date();
        const nextRunUTC = new Date(nowForCron);
        nextRunUTC.setUTCHours(8, 0, 0, 0);
        if (nextRunUTC <= nowForCron) {
          nextRunUTC.setUTCDate(nextRunUTC.getUTCDate() + 1);
        }
        const msUntilNextRun = nextRunUTC.getTime() - nowForCron.getTime();

        console.log(`[ActivationCron] Initialized — first run at 08:00 UTC (in ${Math.round(msUntilNextRun / 60000)} min)`);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('ActivationCron', runActivationAnalysis())
            .catch(e => console.error('[ActivationCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('ActivationCron', runActivationAnalysis())
              .catch(e => console.error('[ActivationCron] Error:', e));
          }, ACTIVATION_INTERVAL_MS);
        }, msUntilNextRun);
      } catch (error) {
        console.error('[ActivationCron] Failed to initialize:', error);
      }

      // ENG-1839: Domain reachability sweep — records whether managed domains actually serve.
      // Three landing pages sat unreachable while every record read healthy, one of them
      // unreported for months, because nothing ever asked whether the site loads.
      try {
        const { runDomainReachabilitySweep, REACHABILITY_INTERVAL_MS } =
          await import('./cron/domainReachabilityCron');

        /*
         * DAILY at a fixed UTC time, not hourly-from-boot.
         *
         * Hourly meant we made an unsolicited HTTPS request to every customer's domain 24
         * times a day. That is traffic they did not ask for, against their origin, and a WAF
         * or bot-protection layer is entitled to start refusing it — at which point we would
         * confidently report a working site as unreachable. Daily is enough: these are static
         * landing pages, and the failure this watches for (a certificate that can never be
         * issued) does not come and go.
         *
         * Fixed clock time rather than boot+offset, matching every other cron here. Under
         * boot-relative scheduling the schedule reshuffles on every deploy, so "hourly" really
         * meant "whenever this instance happened to start, then every hour after that" — which
         * is neither predictable nor reproducible when reading the timestamps back.
         */
        const nowForReach = new Date();
        const nextReachRun = new Date(nowForReach);
        nextReachRun.setUTCHours(6, 15, 0, 0);
        if (nextReachRun <= nowForReach) {
          nextReachRun.setUTCDate(nextReachRun.getUTCDate() + 1);
        }
        const msUntilReach = nextReachRun.getTime() - nowForReach.getTime();

        console.log(
          `[DomainReachability] Initialized — first sweep at 06:15 UTC (in ${Math.round(msUntilReach / 60000)} min), then daily`,
        );
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('DomainReachabilitySweep', runDomainReachabilitySweep())
            .catch(e => console.error('[DomainReachability] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('DomainReachabilitySweep', runDomainReachabilitySweep())
              .catch(e => console.error('[DomainReachability] Error:', e));
          }, REACHABILITY_INTERVAL_MS);
        }, msUntilReach);
      } catch (error) {
        console.error('[DomainReachability] Failed to initialize:', error);
      }

      // ENG-673: the Smartlead push resumer. Every minute it claims push runs whose worker is gone (a crash or a deploy) and cancels runs
      // left paused for a week. It does nothing unless SMARTLEAD_PUSH_ENABLED=true. In-flight work is drained at shutdown by the registry.
      try {
        const { getSmartleadPushService } = await import('./services/smartleadPushRuntime');
        const { pollSmartleadEvents } = await import('./services/smartleadEventRuntime');
        setInterval(() => {
          // The tick itself does nothing but retry cancels of unsettled starts while the push is switched off.
          if (!isCronEnabled()) return;
          cronJobRegistry.track('SmartleadPushResumer', getSmartleadPushService().resumerTick())
            .catch(e => console.error('[SmartleadPush] Resumer error:', e));
        }, 60 * 1000);
        console.log('[SmartleadPush] Resumer initialized — every minute (active only when SMARTLEAD_PUSH_ENABLED=true)');

        // The withdrawal sweep: an opt-out recorded here must reach Smartlead. Hourly, and deliberately NOT behind the kill switch (stopping
        // pushes must never stop opt-outs); it only has work when a push has ever run.
        setTimeout(() => {
          let sweeping = false; // a pass over many lists can outlast the hour: never overlap two
          const sweep = () => {
            if (!isCronEnabled() || sweeping) return;
            sweeping = true;
            cronJobRegistry.track('SmartleadWithdrawalSweep', getSmartleadPushService().sweepWithdrawals())
              .catch(e => console.error('[SmartleadWithdrawal] Sweep error:', e))
              .finally(() => { sweeping = false; });
          };
          sweep();
          setInterval(sweep, 60 * 60 * 1000);
        }, 5 * 60 * 1000);
        console.log('[SmartleadWithdrawal] Sweep initialized — hourly, first pass in 5 minutes');

        // The event poll: backs up the Smartlead event webhook, so a missed unsubscribe or bounce still blocks the contact. Hourly, offset from the
        // withdrawal sweep, and like it NOT behind the kill switch.
        setTimeout(() => {
          let polling = false; // a pass over many campaigns can outlast the hour: never overlap two
          const poll = () => {
            if (!isCronEnabled() || polling) return;
            polling = true;
            cronJobRegistry.track('SmartleadEventPoll', pollSmartleadEvents())
              .catch(e => console.error('[SmartleadPoll] Poll error:', e))
              .finally(() => { polling = false; });
          };
          poll();
          setInterval(poll, 60 * 60 * 1000);
        }, 20 * 60 * 1000);
        console.log('[SmartleadPoll] Event poll initialized — hourly, first pass in 20 minutes');
      } catch (error) {
        console.error('[SmartleadPush] Failed to initialize the resumer:', error);
      }

      // ENG-3131: day-3 "your Zoma trial ends soon" email, once per trial. Hourly; a no-op until
      // ZOMA_BILLING_ENABLED=true. The marker lives on the Stripe subscription (no new table).
      setTimeout(() => {
        let running = false;
        const tick = () => {
          if (!isCronEnabled() || running) return;
          running = true;
          import('./mcp/zomaBilling')
            .then(({ runZomaTrialReminders }) => cronJobRegistry.track('ZomaTrialReminders', runZomaTrialReminders()))
            .catch(e => console.error('[ZomaTrialReminders] Error:', e))
            .finally(() => { running = false; });
        };
        tick();
        setInterval(tick, 60 * 60 * 1000);
      }, 7 * 60 * 1000);
      console.log('[ZomaTrialReminders] Initialized — hourly, first pass in 7 minutes (active only when ZOMA_BILLING_ENABLED=true)');

      // ENG-2156: warn oncall at 80%/95% of the OpenRouter key's own monthly limit, before
      // the cap starts 402'ing every Agent Mode call. Read-only; hourly from boot.
      try {
        const { runOpenRouterKeyBudgetCheck, KEY_BUDGET_INTERVAL_MS } =
          await import('./cron/openRouterKeyBudgetCron');
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('OpenRouterKeyBudget', runOpenRouterKeyBudgetCheck())
            .catch(e => console.error('[OpenRouterKeyBudget] Error:', e));
        }, KEY_BUDGET_INTERVAL_MS);
        console.log('[OpenRouterKeyBudget] Initialized — hourly');
      } catch (error) {
        console.error('[OpenRouterKeyBudget] Failed to initialize:', error);
      }


      // ENG-1967: one bounded due-record page per tick. Registry drains in-flight work at shutdown.
      const { runAdsLearningEvaluation } = await import('./cron/adsLearningCron');
      setInterval(() => {
        if (!isCronEnabled()) return;
        cronJobRegistry.track('AdsLearningEvaluation', runAdsLearningEvaluation())
          .catch(e => console.error('[AdsLearning] due evaluation failed:', e));
      }, 15 * 60 * 1000).unref();
      console.info('[AdsLearning] evaluation scheduled every 15 minutes');

      // ENG-1644 gap-closing: sweep AW-ApprovalDecisions for decisions past
      // expiresAt that nobody ever answered — flip to 'expired', notify the
      // origin session. Hourly — decisions expire on a 1-30 day horizon
      // (review fix: was "1-7 day", stale relative to emma/tools.ts's own
      // MAX_EXPIRES_IN_DAYS=30 clamp added earlier in this same PR).
      // Own try/catch (review fix) — an import failure here must not abort
      // registration of every cron block after it in this boot sequence.
      try {
        const { runApprovalExpirySweep } = await import('./cron/approvalExpirySweepCron');
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('ApprovalExpirySweep', runApprovalExpirySweep())
            .catch(e => console.error('[ApprovalExpirySweep] sweep failed:', e));
        }, 60 * 60 * 1000).unref();
        console.info('[ApprovalExpirySweep] sweep scheduled hourly');
      } catch (error) {
        console.error('[ApprovalExpirySweep] Failed to initialize:', error);
      }

      // ENG-916: Meta Ads Metrics Snapshot — runs daily at 09:00 UTC (after
      // ActivationCron at 08:00), re-pulling the last 30 dates each run so the
      // final refresh occurs after reporting-day end plus 28 elapsed days.
      try {
        const METRICS_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
        const { runMetaMetricsSnapshot } = await import('./cron/metaMetricsSnapshotCron');

        const nowForMetricsCron = new Date();
        const nextMetricsRunUTC = new Date(nowForMetricsCron);
        nextMetricsRunUTC.setUTCHours(9, 0, 0, 0);
        if (nextMetricsRunUTC <= nowForMetricsCron) {
          nextMetricsRunUTC.setUTCDate(nextMetricsRunUTC.getUTCDate() + 1);
        }
        const msUntilNextMetricsRun = nextMetricsRunUTC.getTime() - nowForMetricsCron.getTime();

        console.log(`[MetaMetricsSnapshotCron] Initialized — first run at 09:00 UTC (in ${Math.round(msUntilNextMetricsRun / 60000)} min)`);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('MetaMetricsSnapshotCron', runMetaMetricsSnapshot())
            .catch(e => console.error('[MetaMetricsSnapshotCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('MetaMetricsSnapshotCron', runMetaMetricsSnapshot())
              .catch(e => console.error('[MetaMetricsSnapshotCron] Error:', e));
          }, METRICS_SNAPSHOT_INTERVAL_MS);
        }, msUntilNextMetricsRun);
      } catch (error) {
        console.error('[MetaMetricsSnapshotCron] Failed to initialize:', error);
      }

      // ENG-2215: Google Ads Metrics Snapshot — runs daily at 09:15 UTC (after
      // MetaMetricsSnapshotCron at 09:00), re-pulling the last 92 dates each run so the final
      // refresh occurs after reporting-day end plus Google's up-to-90-day conversion attribution
      // window has elapsed. Inert unless GOOGLE_ADS_METRICS_SNAPSHOT_ENABLED=true — the cron
      // itself refuses to enumerate accounts or call the Google Ads API without it (see
      // runGoogleAdsMetricsSnapshot's own flag check).
      try {
        const GOOGLE_ADS_METRICS_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
        const { runGoogleAdsMetricsSnapshot } = await import('./cron/googleAdsMetricsSnapshotCron');

        const nowForGoogleAdsMetricsCron = new Date();
        const nextGoogleAdsMetricsRunUTC = new Date(nowForGoogleAdsMetricsCron);
        nextGoogleAdsMetricsRunUTC.setUTCHours(9, 15, 0, 0);
        if (nextGoogleAdsMetricsRunUTC <= nowForGoogleAdsMetricsCron) {
          nextGoogleAdsMetricsRunUTC.setUTCDate(nextGoogleAdsMetricsRunUTC.getUTCDate() + 1);
        }
        const msUntilNextGoogleAdsMetricsRun = nextGoogleAdsMetricsRunUTC.getTime() - nowForGoogleAdsMetricsCron.getTime();

        console.log(`[GoogleAdsMetricsSnapshotCron] Initialized — first run at 09:15 UTC (in ${Math.round(msUntilNextGoogleAdsMetricsRun / 60000)} min)`);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('GoogleAdsMetricsSnapshotCron', runGoogleAdsMetricsSnapshot())
            .catch(e => console.error('[GoogleAdsMetricsSnapshotCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('GoogleAdsMetricsSnapshotCron', runGoogleAdsMetricsSnapshot())
              .catch(e => console.error('[GoogleAdsMetricsSnapshotCron] Error:', e));
          }, GOOGLE_ADS_METRICS_SNAPSHOT_INTERVAL_MS);
        }, msUntilNextGoogleAdsMetricsRun);
      } catch (error) {
        console.error('[GoogleAdsMetricsSnapshotCron] Failed to initialize:', error);
      }

      // Drip Sequence Worker — runs every 5 minutes
      try {
        const { processDueEnrollments } = await import('./services/dripSequenceWorker');
        const DRIP_INTERVAL_MS = 5 * 60 * 1000;
        cronJobRegistry.track('dripWorker', processDueEnrollments())
          .catch(e => console.error('[dripWorker] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('dripWorker', processDueEnrollments())
            .catch(e => console.error('[dripWorker] Error:', e));
        }, DRIP_INTERVAL_MS);
        console.log('[dripWorker] Initialized — running every 5 minutes');
      } catch (error) {
        console.error('[dripWorker] Failed to initialize:', error);
      }

      // Async job queue poller (ENG-524 fast-follow) — crash-safety net for any
      // webhook receiver's fire-and-forget processing (Calendly, HubSpot). Enqueueing
      // fails open, so this poller finding nothing to do (table not provisioned yet,
      // or simply empty) is completely normal, not an error.
      try {
        const { pollAndProcessOnce } = await import('./services/asyncJobQueue');
        // Verify the binding BEFORE scheduling the timer. The import is captured
        // once, and calling an undefined binding throws SYNCHRONOUSLY inside the
        // interval callback — past this try/catch and past the `.catch()` below,
        // which only sees rejected promises. That error then surfaces 30s later
        // against whichever unrelated suite happens to be running, which is how
        // `settings.replaySessions` and `securityHeaders` failed on a PR that
        // touches neither. Failing here instead keeps it to one init-time log.
        if (typeof pollAndProcessOnce !== 'function') {
          throw new Error('asyncJobQueue.pollAndProcessOnce is unavailable — poller not started');
        }
        const QUEUE_POLL_INTERVAL_MS = 30 * 1000;
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('AsyncJobQueuePoller', pollAndProcessOnce())
            .catch(e => console.error('[AsyncJobQueuePoller] Error:', e));
        }, QUEUE_POLL_INTERVAL_MS);
        console.log('[AsyncJobQueuePoller] Initialized — polling every 30 seconds');
      } catch (error) {
        console.error('[AsyncJobQueuePoller] Failed to initialize:', error);
      }

      // ENG-324: Scheduled-run reconciler — crash-safe backstop for the drain.
      // Recovers scheduled runs whose process died mid-flight (SIGTERM past the
      // 10-min drain ceiling, SIGKILL, OOM) by requeuing any in-flight lease whose
      // heartbeat has gone stale. Boot sweep reclaims runs orphaned by the PREVIOUS
      // instance's death (the common deploy case); the interval catches the rest.
      try {
        const { reconcileStaleScheduledRuns, RECONCILE_INTERVAL_MS } = await import('./controllers/agentModeController');
        cronJobRegistry.track('scheduledRunReconciler', reconcileStaleScheduledRuns())
          .catch(e => console.error('[scheduledRunReconciler] Boot sweep error:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('scheduledRunReconciler', reconcileStaleScheduledRuns())
            .catch(e => console.error('[scheduledRunReconciler] Sweep error:', e));
        }, RECONCILE_INTERVAL_MS);
        console.log(`[scheduledRunReconciler] Initialized — sweeping every ${Math.round(RECONCILE_INTERVAL_MS / 60000)} min`);
      } catch (error) {
        console.error('[scheduledRunReconciler] Failed to initialize:', error);
      }

      // Durable Landing-Page Poller — redeploy backstop for in-flight builds.
      // No-op unless DURABLE_LANDING_GENERATION is on. Runs every 5 minutes.
      try {
        const { startDurableLandingPoller } = await import('./services/durableLandingPoller');
        startDurableLandingPoller();
      } catch (error) {
        console.error('[durableLandingPoller] Failed to initialize:', error);
      }

      // v0 Credit Alert — hourly low-credit check on the v0 (landing-page
      // generation) account. Fires an oncall alert on warn-level transitions
      // into low/critical so credits can never silently run out again.
      try {
        const { checkAndAlert } = await import('./services/v0BillingService');
        const V0_CREDIT_ALERT_INTERVAL_MS = 60 * 60 * 1000;
        cronJobRegistry.track('v0CreditAlert', checkAndAlert())
          .catch(e => console.error('[v0CreditAlert] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('v0CreditAlert', checkAndAlert())
            .catch(e => console.error('[v0CreditAlert] Error:', e));
        }, V0_CREDIT_ALERT_INTERVAL_MS);
        console.log('[v0CreditAlert] Initialized — running hourly');
      } catch (error) {
        console.error('[v0CreditAlert] Failed to initialize:', error);
      }

      // LinkedIn Connection Sync — runs every 10 minutes
      // Polls Unipile for accepted connections, upserts into AW-UnipileConnections cache,
      // and activates any awaiting_connection drip enrollments.
      try {
        const { runLinkedInConnectionSync } = await import('./cron/linkedInConnectionSyncCron');
        const LI_CONN_INTERVAL_MS = 10 * 60 * 1000;
        cronJobRegistry.track('linkedInConnectionSync', runLinkedInConnectionSync())
          .catch(e => console.error('[linkedInConnectionSync] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('linkedInConnectionSync', runLinkedInConnectionSync())
            .catch(e => console.error('[linkedInConnectionSync] Error:', e));
        }, LI_CONN_INTERVAL_MS);
        console.log('[linkedInConnectionSync] Initialized — running every 10 minutes');
      } catch (error) {
        console.error('[linkedInConnectionSync] Failed to initialize:', error);
      }

      // Meta Ad-Account Token Refresh — runs every 12 hours.
      // Meta issues no refresh tokens; long-lived ad-account tokens (~60 days)
      // must be re-exchanged while still valid. Proactively refreshes any token
      // within the refresh window so Meta tools / the ad builder never block on
      // an expired token.
      try {
        const { runMetaTokenRefresh } = await import('./cron/metaTokenRefreshCron');
        const META_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
        cronJobRegistry.track('metaTokenRefreshCron', runMetaTokenRefresh())
          .catch(e => console.error('[metaTokenRefreshCron] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('metaTokenRefreshCron', runMetaTokenRefresh())
            .catch(e => console.error('[metaTokenRefreshCron] Error:', e));
        }, META_REFRESH_INTERVAL_MS);
        console.log('[metaTokenRefreshCron] Initialized — running every 12 hours');
      } catch (error) {
        console.error('[metaTokenRefreshCron] Failed to initialize:', error);
      }

      // Meta Tracking Integrity Monitor (ENG-926 §F) — runs daily.
      // Watches every connected Meta ad account for an account that is spending while
      // Meta attributes it no conversions at all, and for stored credentials Meta has
      // stopped accepting. Both failures are SILENT by nature — nothing errors, leads
      // simply stop arriving — so only a clock can notice them. RankAI's tracking was
      // reported fixed three times without an end-to-end check and nobody caught it.
      // Anchored to 09:00 UTC rather than a 24h interval, and with NO run on boot.
      //
      // A 24h setInterval never elapses here: PRs merge every 1-2 hours, each merge
      // restarts the process, and the interval resets — so an interval-based daily cron is
      // really "runs on every boot". This one did exactly that, re-alerting on every
      // deploy because its in-memory dedupe reset too (observed 2026-08-16: three sweeps
      // in eleven hours). Anchoring to a wall-clock hour makes restarts free — every boot
      // re-arms the SAME target, so it fires once a day however often we deploy.
      // Same shape as the activation cron above; the arithmetic lives in dailySchedule.
      try {
        const { runMetaTrackingMonitor } = await import('./cron/metaTrackingMonitorCron');
        const { msUntilNextUtcHour } = await import('./utils/dailySchedule');
        const TRACKING_MONITOR_HOUR_UTC = 9;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const msUntilFirstRun = msUntilNextUtcHour(TRACKING_MONITOR_HOUR_UTC);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('metaTrackingMonitorCron', runMetaTrackingMonitor())
            .catch(e => console.error('[metaTrackingMonitorCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('metaTrackingMonitorCron', runMetaTrackingMonitor())
              .catch(e => console.error('[metaTrackingMonitorCron] Error:', e));
          }, DAY_MS);
        }, msUntilFirstRun);
        console.log(
          `[metaTrackingMonitorCron] Initialized — first run at ${TRACKING_MONITOR_HOUR_UTC}:00 UTC ` +
          `(in ${Math.round(msUntilFirstRun / 60000)} min)`,
        );
      } catch (error) {
        console.error('[metaTrackingMonitorCron] Failed to initialize:', error);
      }

      // Seat-based billing (ENG-2247) — daily sweep that grants each org's
      // monthly LLM usage credit for its purchased extra seats. Anchored to a
      // fixed UTC hour (same reasoning as metaTrackingMonitorCron above: a
      // naive 24h setInterval never elapses in an environment that redeploys
      // every 1-2 hours) — grantId idempotency in grantMonthlyLlmUsageCredit
      // makes any extra fire within the same usage month a safe no-op.
      try {
        const { runOrgSeatCreditGrant } = await import('./cron/orgSeatCreditGrantCron');
        const { msUntilNextUtcHour } = await import('./utils/dailySchedule');
        const SEAT_CREDIT_GRANT_HOUR_UTC = 10;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const msUntilFirstSeatCreditRun = msUntilNextUtcHour(SEAT_CREDIT_GRANT_HOUR_UTC);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('orgSeatCreditGrantCron', runOrgSeatCreditGrant())
            .catch(e => console.error('[orgSeatCreditGrantCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('orgSeatCreditGrantCron', runOrgSeatCreditGrant())
              .catch(e => console.error('[orgSeatCreditGrantCron] Error:', e));
          }, DAY_MS);
        }, msUntilFirstSeatCreditRun);
        console.log(
          `[orgSeatCreditGrantCron] Initialized — first run at ${SEAT_CREDIT_GRANT_HOUR_UTC}:00 UTC ` +
          `(in ${Math.round(msUntilFirstSeatCreditRun / 60000)} min)`,
        );
      } catch (error) {
        console.error('[orgSeatCreditGrantCron] Failed to initialize:', error);
      }

      // ENG-668 PR-2 — month-end pay-as-you-go settlement. Dark behind the AW-Settings switch
      // `payg_settlement_enabled` (exact 'true'); off = the sweep returns without reading anything.
      // Same fixed-UTC-hour anchoring as the seat-credit sweep above, and after it, so the closed
      // month's credit ledger has already been kept as `llmUsageCreditsClosed` when it runs. Every
      // month's settlement record makes an extra fire a no-op.
      try {
        const { runPaygSettlement } = await import('./cron/paygSettlementCron');
        const { msUntilNextUtcHour } = await import('./utils/dailySchedule');
        const PAYG_SETTLEMENT_HOUR_UTC = 12;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const msUntilFirstPaygSettlementRun = msUntilNextUtcHour(PAYG_SETTLEMENT_HOUR_UTC);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('paygSettlementCron', runPaygSettlement())
            .catch(e => console.error('[paygSettlementCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('paygSettlementCron', runPaygSettlement())
              .catch(e => console.error('[paygSettlementCron] Error:', e));
          }, DAY_MS);
        }, msUntilFirstPaygSettlementRun);
        console.log(
          `[paygSettlementCron] Initialized — first run at ${PAYG_SETTLEMENT_HOUR_UTC}:00 UTC ` +
          `(in ${Math.round(msUntilFirstPaygSettlementRun / 60000)} min)`,
        );
      } catch (error) {
        console.error('[paygSettlementCron] Failed to initialize:', error);
      }

      // Hot-lead call number rent (ENG-2614) — daily sweep that meters the current
      // month's rent of every org's caller number. Anchored to a fixed UTC hour
      // (a bare 24h setInterval never elapses with redeploys every 1-2 hours); the
      // month-scoped idempotency key makes any extra fire a safe no-op. Switch off
      // with HOT_LEAD_CALL_RENT_METERING=false.
      try {
        const { runNumberRentCron } = await import('./cron/numberRentCron');
        const { msUntilNextUtcHour } = await import('./utils/dailySchedule');
        const NUMBER_RENT_HOUR_UTC = 11;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const msUntilFirstNumberRentRun = msUntilNextUtcHour(NUMBER_RENT_HOUR_UTC);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('numberRentCron', runNumberRentCron())
            .catch(e => console.error('[numberRentCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('numberRentCron', runNumberRentCron())
              .catch(e => console.error('[numberRentCron] Error:', e));
          }, DAY_MS);
        }, msUntilFirstNumberRentRun);
        console.log(
          `[numberRentCron] Initialized — first run at ${NUMBER_RENT_HOUR_UTC}:00 UTC ` +
          `(in ${Math.round(msUntilFirstNumberRentRun / 60000)} min)`,
        );
      } catch (error) {
        console.error('[numberRentCron] Failed to initialize:', error);
      }

      // Hot-lead call stuck-record sweep (ENG-2271) — daily. Finds call records that stayed
      // live longer than a call can last and settles them from Twilio's own record. Anchored to
      // a fixed UTC hour like the rent sweep. REPORT-ONLY unless HOT_LEAD_CALL_STUCK_SWEEP=close;
      // =off disables it.
      try {
        const { runStuckCallSweepCron } = await import('./cron/stuckCallSweepCron');
        const { msUntilNextUtcHour } = await import('./utils/dailySchedule');
        const STUCK_CALL_SWEEP_HOUR_UTC = 12;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const msUntilFirstStuckCallSweepRun = msUntilNextUtcHour(STUCK_CALL_SWEEP_HOUR_UTC);
        setTimeout(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('stuckCallSweepCron', runStuckCallSweepCron())
            .catch(e => console.error('[stuckCallSweepCron] Error:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('stuckCallSweepCron', runStuckCallSweepCron())
              .catch(e => console.error('[stuckCallSweepCron] Error:', e));
          }, DAY_MS);
        }, msUntilFirstStuckCallSweepRun);
        console.log(
          `[stuckCallSweepCron] Initialized — first run at ${STUCK_CALL_SWEEP_HOUR_UTC}:00 UTC ` +
          `(in ${Math.round(msUntilFirstStuckCallSweepRun / 60000)} min)`,
        );
      } catch (error) {
        console.error('[stuckCallSweepCron] Failed to initialize:', error);
      }

      // Hot-lead call due-retries (ENG-2783): every 5 minutes, places the one retry of a lead who pressed 2 ("not available
      // now") once it is due; the job queue cannot run a job later. Does nothing while the global hot_lead_call_mode kill
      // switch is off. HOT_LEAD_CALL_RETRY=off|0|false does not arm it.
      try {
        const { startHotLeadCallRetryCron } = await import('./cron/hotLeadCallRetryCron');
        startHotLeadCallRetryCron({ enabled: isCronEnabled, track: (name, run) => cronJobRegistry.track(name, run) });
      } catch (error) {
        console.error('[hotLeadCallRetryCron] Failed to initialize:', error);
      }

      // Pre-Renewal Ad-Integration Health Check (ENG-1270) — runs daily.
      // Charging a customer while their ad platform connection is silently dead
      // is a trust break (ThinkingAI, TransAmerica — Aug 2026 audit, both caught
      // manually). Flags active-subscription users renewing within the lookahead
      // window whose ad integration is missing/expired via a deduped oncall alert.
      // Disabled by default: per-customer "Renewal at risk" oncall emails were flooding the team inbox.
      // Opt back in with RENEWAL_HEALTH_ALERTS_ENABLED=true. The read-only admin evaluation route is unaffected.
      if (process.env.RENEWAL_HEALTH_ALERTS_ENABLED === 'true') try {
        const { runRenewalIntegrationHealthCheck } = await import('./cron/renewalIntegrationHealthCron');
        const RENEWAL_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
        cronJobRegistry.track('renewalIntegrationHealthCron', runRenewalIntegrationHealthCheck())
          .catch(e => console.error('[renewalIntegrationHealthCron] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('renewalIntegrationHealthCron', runRenewalIntegrationHealthCheck())
            .catch(e => console.error('[renewalIntegrationHealthCron] Error:', e));
        }, RENEWAL_HEALTH_INTERVAL_MS);
        console.log('[renewalIntegrationHealthCron] Initialized — running daily');
      } catch (error) {
        console.error('[renewalIntegrationHealthCron] Failed to initialize:', error);
      }

      // Account-health classifier sweep (ENG-2143), the replacement for the renewal cron above:
      // at-risk → deduped oncall, activation incomplete → CS nudge digest email. Off unless
      // ACCOUNT_HEALTH_ALERTS_ENABLED=true (enabling it in prod is an OPS step).
      if (process.env.ACCOUNT_HEALTH_ALERTS_ENABLED === 'true') try {
        const { runAccountHealthClassifier } = await import('./cron/accountHealthClassifierCron');
        const ACCOUNT_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
        cronJobRegistry.track('accountHealthClassifierCron', runAccountHealthClassifier())
          .catch(e => console.error('[accountHealthClassifierCron] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('accountHealthClassifierCron', runAccountHealthClassifier())
            .catch(e => console.error('[accountHealthClassifierCron] Error:', e));
        }, ACCOUNT_HEALTH_INTERVAL_MS);
        console.log('[accountHealthClassifierCron] Initialized — running daily');
      } catch (error) {
        console.error('[accountHealthClassifierCron] Failed to initialize:', error);
      }

      // Weekly creative calibration batch (ENG-2142): ~20 creative pairs as pairwise golden cases
      // and one Slack link. Checked daily; each ISO week's batch is written once across instances.
      // Off unless CREATIVE_CALIBRATION_ENABLED=true (enabling it in prod is an OPS step).
      if (process.env.CREATIVE_CALIBRATION_ENABLED === 'true') try {
        const { runCreativeCalibration } = await import('./cron/creativeCalibrationCron');
        const CREATIVE_CALIBRATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
        cronJobRegistry.track('creativeCalibrationCron', runCreativeCalibration())
          .catch(e => console.error('[creativeCalibrationCron] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('creativeCalibrationCron', runCreativeCalibration())
            .catch(e => console.error('[creativeCalibrationCron] Error:', e));
        }, CREATIVE_CALIBRATION_INTERVAL_MS);
        console.log('[creativeCalibrationCron] Initialized — checking daily for the weekly batch');
      } catch (error) {
        console.error('[creativeCalibrationCron] Failed to initialize:', error);
      }

      // CRM Auto-Enrichment (ENG-88) — runs every 15 minutes.
      // Ray's manual campaign-monitoring routine included clicking "renew"
      // (the enrich-v3 engine) on managed-campaign lead lists by hand a
      // couple of times. With Ray leaving, this keeps it happening without
      // a human clicking anything — but ONLY for a list whose saved
      // enrichmentConfig has explicitly opted in (`autoEnrich: true`, set
      // via the existing PUT /lists/:listId/enrichment-config). Every
      // other list's behavior is unchanged; nothing runs until a human
      // flips that flag for a specific list.
      try {
        const { runCrmAutoEnrichmentCheck } = await import('./cron/crmAutoEnrichmentCron');
        const CRM_AUTO_ENRICHMENT_INTERVAL_MS = 15 * 60 * 1000;
        // Guard the initial run too, matching the interval callback below —
        // a disabled-cron environment must not enrich real leads once on
        // startup just because the guard was only on the recurring path.
        if (isCronEnabled()) {
          cronJobRegistry.track('crmAutoEnrichmentCron', runCrmAutoEnrichmentCheck())
            .catch(e => console.error('[crmAutoEnrichmentCron] Error on first run:', e));
        }
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('crmAutoEnrichmentCron', runCrmAutoEnrichmentCheck())
            .catch(e => console.error('[crmAutoEnrichmentCron] Error:', e));
        }, CRM_AUTO_ENRICHMENT_INTERVAL_MS);
        console.log('[crmAutoEnrichmentCron] Initialized — running every 15 minutes (opt-in per list, default off)');
      } catch (error) {
        console.error('[crmAutoEnrichmentCron] Failed to initialize:', error);
      }

      // Skill Review Queue Digest (ENG-932) — runs daily.
      // "Submit for Review" fires no notification at all (ENG-149 correctly
      // killed the old per-submission oncall page as noise, but that left the
      // queue with no reader). This alerts once a skill has sat in
      // pending_review past the stale window, deduped to at most one message
      // per day regardless of queue size — submitting a single skill still
      // pages nobody.
      try {
        const { runSkillReviewQueueDigest } = await import('./cron/skillReviewQueueDigestCron');
        const SKILL_REVIEW_DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
        if (isCronEnabled()) {
          cronJobRegistry.track('skillReviewQueueDigestCron', runSkillReviewQueueDigest())
            .catch(e => console.error('[skillReviewQueueDigestCron] Error on first run:', e));
        }
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('skillReviewQueueDigestCron', runSkillReviewQueueDigest())
            .catch(e => console.error('[skillReviewQueueDigestCron] Error:', e));
        }, SKILL_REVIEW_DIGEST_INTERVAL_MS);
        console.log('[skillReviewQueueDigestCron] Initialized — running daily');
      } catch (error) {
        console.error('[skillReviewQueueDigestCron] Failed to initialize:', error);
      }

      // Scheduled-run cost jump flag (ENG-2743). Read-only: once a day, during one UTC hour
      // (SCHEDULE_COST_JUMP_SEND_HOUR_UTC), compares each schedule's cost on the last complete
      // UTC day with its own previous 7 days and emails the oncall list when any jumped
      // (>= 2x its median and >= $3). Ticks every 15 minutes; outside that hour a tick does nothing.
      try {
        const { scheduleCostJumpTick, SCHEDULE_COST_JUMP_TICK_MS } = await import('./cron/scheduleCostJumpCron');
        if (isCronEnabled()) {
          cronJobRegistry.track('scheduleCostJumpCron', scheduleCostJumpTick())
            .catch(e => console.error('[scheduleCostJumpCron] Error on first run:', e));
        }
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('scheduleCostJumpCron', scheduleCostJumpTick())
            .catch(e => console.error('[scheduleCostJumpCron] Error:', e));
        }, SCHEDULE_COST_JUMP_TICK_MS);
        console.log('[scheduleCostJumpCron] Initialized — 15-minute tick, acts once a day in its UTC hour');
      } catch (error) {
        console.error('[scheduleCostJumpCron] Failed to initialize:', error);
      }

      // Outlook Bounce/Complaint Monitor (ENG-266 Part 3, option B+) — runs every 15
      // minutes. Resend's webhook-based bounce/complaint auto-DNC cannot fire for a
      // mailbox send (Graph produces no Resend webhooks), so this polls each connected
      // Outlook mailbox's Inbox for delivery-failure notifications and applies the same
      // suppression. This is the compliance floor B+ exists for — not optional.
      try {
        const { runOutlookBounceMonitor } = await import('./cron/outlookBounceMonitorCron');
        const OUTLOOK_BOUNCE_MONITOR_INTERVAL_MS = 15 * 60 * 1000;
        cronJobRegistry.track('outlookBounceMonitorCron', runOutlookBounceMonitor())
          .catch(e => console.error('[outlookBounceMonitorCron] Error on first run:', e));
        setInterval(() => {
          if (!isCronEnabled()) return;
          cronJobRegistry.track('outlookBounceMonitorCron', runOutlookBounceMonitor())
            .catch(e => console.error('[outlookBounceMonitorCron] Error:', e));
        }, OUTLOOK_BOUNCE_MONITOR_INTERVAL_MS);
        console.log('[outlookBounceMonitorCron] Initialized — running every 15 minutes');
      } catch (error) {
        console.error('[outlookBounceMonitorCron] Failed to initialize:', error);
      }

      // Onboarding stuck-user detector — DISABLED 2026-05-07. Was posting one
      // Notion oncall task per day grouped by stage. The cron itself is well-
      // designed but the broader telemetry pipeline (incl. per-event UI Error
      // tasks from errorReporter) was flooding the sprint board, so we cut
      // the whole pipeline. The implementation in
      // backend/src/cron/onboardingStuckDetector.ts is preserved and unit-
      // tested; re-enable here if we want the daily summary back.

      // Onboarding Loop — daily at 15:00 UTC (7am PT), gated by ONBOARDING_LOOP_ENABLED=true
      if (process.env.ONBOARDING_LOOP_ENABLED === 'true') {
        try {
          const LOOP_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runOnboardingLoop } = await import('./cron/onboardingLoop');

          const nowForLoop = new Date();
          const nextLoopRun = new Date(nowForLoop);
          nextLoopRun.setUTCHours(15, 0, 0, 0);
          if (nextLoopRun <= nowForLoop) {
            nextLoopRun.setUTCDate(nextLoopRun.getUTCDate() + 1);
          }
          const msUntilLoop = nextLoopRun.getTime() - nowForLoop.getTime();

          console.log(`[OnboardingLoop] Initialized — first run at 15:00 UTC (in ${Math.round(msUntilLoop / 60000)} min)`);
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('OnboardingLoop', runOnboardingLoop())
              .catch(e => console.error('[OnboardingLoop] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('OnboardingLoop', runOnboardingLoop())
                .catch(e => console.error('[OnboardingLoop] Error:', e));
            }, LOOP_INTERVAL_MS);
          }, msUntilLoop);
        } catch (error) {
          console.error('[OnboardingLoop] Failed to initialize:', error);
        }

        // Onboarding Loop Watchdog — hourly, gated by ONBOARDING_LOOP_ENABLED=true
        try {
          const WATCHDOG_INTERVAL_MS = 60 * 60 * 1000;
          const { runOnboardingLoopWatchdog } = await import('./cron/onboardingLoopWatchdog');

          console.log('[OnboardingWatchdog] Initialized — running hourly');
          cronJobRegistry.track('OnboardingWatchdog', runOnboardingLoopWatchdog())
            .catch(e => console.error('[OnboardingWatchdog] Error on first run:', e));
          setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('OnboardingWatchdog', runOnboardingLoopWatchdog())
              .catch(e => console.error('[OnboardingWatchdog] Error:', e));
          }, WATCHDOG_INTERVAL_MS);
        } catch (error) {
          console.error('[OnboardingWatchdog] Failed to initialize:', error);
        }
      } else {
        console.log('[OnboardingLoop] Disabled (set ONBOARDING_LOOP_ENABLED=true to enable)');
        console.log('[OnboardingWatchdog] Disabled (set ONBOARDING_LOOP_ENABLED=true to enable)');
      }

      // AI Eval Funnel closed-loop — daily at 16:00 UTC (8am PT), one hour
      // offset from the onboarding loop so the two don't race for shared
      // resources (Slack rate limits, Bedrock, etc.). Gated by
      // AI_EVAL_LOOP_ENABLED=true.
      if (process.env.AI_EVAL_LOOP_ENABLED === 'true') {
        try {
          const AI_EVAL_LOOP_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runAiEvalLoopOnce } = await import('./loops/instances/ai-eval-funnel');

          const nowForAiEval = new Date();
          const nextAiEvalRun = new Date(nowForAiEval);
          nextAiEvalRun.setUTCHours(16, 0, 0, 0);
          if (nextAiEvalRun <= nowForAiEval) {
            nextAiEvalRun.setUTCDate(nextAiEvalRun.getUTCDate() + 1);
          }
          const msUntilAiEval = nextAiEvalRun.getTime() - nowForAiEval.getTime();

          console.log(
            `[AiEvalLoop] Initialized — first run at 16:00 UTC (in ${Math.round(msUntilAiEval / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('AiEvalLoop', runAiEvalLoopOnce())
              .catch(e => console.error('[AiEvalLoop] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('AiEvalLoop', runAiEvalLoopOnce())
                .catch(e => console.error('[AiEvalLoop] Error:', e));
            }, AI_EVAL_LOOP_INTERVAL_MS);
          }, msUntilAiEval);
        } catch (error) {
          console.error('[AiEvalLoop] Failed to initialize:', error);
        }
      } else {
        console.log('[AiEvalLoop] Disabled (set AI_EVAL_LOOP_ENABLED=true to enable)');
      }

      // AI Readiness Funnel closed-loop — daily at 16:30 UTC, offset 30 min from
      // ai-eval (16:00) so they don't race for Slack/Bedrock. Explicit opt-in so
      // staging/dev environments with Emma Dev tokens cannot start DMing by
      // accident. The loop itself is always REGISTERED in app.ts so event
      // ingestion works regardless of this schedule flag.
      if (process.env.AI_READINESS_LOOP_ENABLED === 'true') {
        try {
          const AI_READINESS_LOOP_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runAiReadinessLoopOnce } = await import('./loops/instances/ai-readiness-funnel');

          const nowForReadiness = new Date();
          const nextReadinessRun = new Date(nowForReadiness);
          nextReadinessRun.setUTCHours(16, 30, 0, 0);
          if (nextReadinessRun <= nowForReadiness) {
            nextReadinessRun.setUTCDate(nextReadinessRun.getUTCDate() + 1);
          }
          const msUntilReadiness = nextReadinessRun.getTime() - nowForReadiness.getTime();

          console.log(
            `[AiReadinessLoop] Initialized — first run at 16:30 UTC (in ${Math.round(msUntilReadiness / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('AiReadinessLoop', runAiReadinessLoopOnce())
              .catch(e => console.error('[AiReadinessLoop] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('AiReadinessLoop', runAiReadinessLoopOnce())
                .catch(e => console.error('[AiReadinessLoop] Error:', e));
            }, AI_READINESS_LOOP_INTERVAL_MS);
          }, msUntilReadiness);
        } catch (error) {
          console.error('[AiReadinessLoop] Failed to initialize:', error);
        }
      } else {
        console.log('[AiReadinessLoop] Disabled (set AI_READINESS_LOOP_ENABLED=true to enable)');
      }

      // Onboarding loop V2 (framework port, REVAMP) — daily at 17:00 UTC (9am
      // PT), offset from the legacy onboarding loop (15:00) + ai-eval (16:00) so
      // they don't race for Slack/Bedrock. Gated by ONBOARDING_LOOP_V2=true; runs
      // ALONGSIDE the legacy onboarding cron until cutover.
      if (process.env.ONBOARDING_LOOP_V2 === 'true') {
        try {
          const ONBOARDING_V2_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runOnboardingLoopV2Once } = await import('./loops/instances/onboarding');

          const nowForObV2 = new Date();
          const nextObV2Run = new Date(nowForObV2);
          nextObV2Run.setUTCHours(17, 0, 0, 0);
          if (nextObV2Run <= nowForObV2) {
            nextObV2Run.setUTCDate(nextObV2Run.getUTCDate() + 1);
          }
          const msUntilObV2 = nextObV2Run.getTime() - nowForObV2.getTime();

          console.log(
            `[OnboardingLoopV2] Initialized — first run at 17:00 UTC (in ${Math.round(msUntilObV2 / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('OnboardingLoopV2', runOnboardingLoopV2Once())
              .catch(e => console.error('[OnboardingLoopV2] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('OnboardingLoopV2', runOnboardingLoopV2Once())
                .catch(e => console.error('[OnboardingLoopV2] Error:', e));
            }, ONBOARDING_V2_INTERVAL_MS);
          }, msUntilObV2);
        } catch (error) {
          console.error('[OnboardingLoopV2] Failed to initialize:', error);
        }
      } else {
        console.log('[OnboardingLoopV2] Disabled (set ONBOARDING_LOOP_V2=true to enable)');
      }

      // Agent-mode tool-reliability loop — daily at 17:30 UTC, offset from the
      // funnel loops so they don't race for Slack/Bedrock. Reads agent_tool_*
      // events the runtime-spine recorder wrote to Dev-AW-LoopEvents, clusters
      // failures per tool, and DMs Harsha a cloud-dev fix spec per failing
      // tool. This learning/dispatch loop is gated by AGENT_MODE_LOOP_ENABLED.
      // Shadow-mode telemetry can be tested separately with
      // AGENT_RUNTIME_SPINE_ENABLED=true.
      if (process.env.AGENT_MODE_LOOP_ENABLED === 'true') {
        try {
          const AGENT_MODE_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runAgentModeLoopOnce } = await import('./loops/instances/agent-mode');

          const nowForAgentMode = new Date();
          const nextAgentModeRun = new Date(nowForAgentMode);
          nextAgentModeRun.setUTCHours(17, 30, 0, 0);
          if (nextAgentModeRun <= nowForAgentMode) {
            nextAgentModeRun.setUTCDate(nextAgentModeRun.getUTCDate() + 1);
          }
          const msUntilAgentMode = nextAgentModeRun.getTime() - nowForAgentMode.getTime();

          console.log(
            `[AgentModeLoop] Initialized — first run at 17:30 UTC (in ${Math.round(msUntilAgentMode / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('AgentModeLoop', runAgentModeLoopOnce())
              .catch(e => console.error('[AgentModeLoop] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('AgentModeLoop', runAgentModeLoopOnce())
                .catch(e => console.error('[AgentModeLoop] Error:', e));
            }, AGENT_MODE_INTERVAL_MS);
          }, msUntilAgentMode);
        } catch (error) {
          console.error('[AgentModeLoop] Failed to initialize:', error);
        }
      } else {
        console.log('[AgentModeLoop] Disabled (set AGENT_MODE_LOOP_ENABLED=true to enable)');
      }

      // Agent-mode daily reliability snapshot — daily at 17:45 UTC, between the
      // agent-mode learning loop (17:30) and generic attribution (18:00) so it
      // doesn't race them. Telemetry-only: reads the agent-mode events the
      // recorder already wrote and persists a dated trend-line snapshot. Never
      // touches the chat path.
      //
      // ON BY DEFAULT (ENG-746). This was opt-in via
      // AGENT_RELIABILITY_SNAPSHOT_ENABLED=true, that variable was never added
      // to the production environment, and the cron consequently never ran — so
      // GET /api/admin/loops/reliability-trend returned {count: 0} forever and
      // closure-gate check 4 could not be satisfied for any issue. A telemetry
      // job whose absence silently disables a control should not depend on
      // someone remembering a variable. Set the flag to 'false' to opt out.
      if (process.env.AGENT_RELIABILITY_SNAPSHOT_ENABLED !== 'false') {
        try {
          const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runAgentReliabilitySnapshot, seedReliabilitySnapshotsIfEmpty } =
            await import('./cron/agentReliabilitySnapshotCron');

          // One-shot seed so the trend is readable immediately rather than
          // after the next 17:45 UTC tick. No-ops once any snapshot exists.
          if (isCronEnabled()) {
            cronJobRegistry.track('AgentReliabilitySnapshotSeed', seedReliabilitySnapshotsIfEmpty())
              .catch(e => console.error('[AgentReliabilitySnapshot] Seed error:', e));
          }

          const nowForSnapshot = new Date();
          const nextSnapshotRun = new Date(nowForSnapshot);
          nextSnapshotRun.setUTCHours(17, 45, 0, 0);
          if (nextSnapshotRun <= nowForSnapshot) {
            nextSnapshotRun.setUTCDate(nextSnapshotRun.getUTCDate() + 1);
          }
          const msUntilSnapshot = nextSnapshotRun.getTime() - nowForSnapshot.getTime();

          console.log(
            `[AgentReliabilitySnapshot] Initialized — first run at 17:45 UTC (in ${Math.round(msUntilSnapshot / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('AgentReliabilitySnapshot', runAgentReliabilitySnapshot())
              .catch(e => console.error('[AgentReliabilitySnapshot] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('AgentReliabilitySnapshot', runAgentReliabilitySnapshot())
                .catch(e => console.error('[AgentReliabilitySnapshot] Error:', e));
            }, SNAPSHOT_INTERVAL_MS);
          }, msUntilSnapshot);
        } catch (error) {
          console.error('[AgentReliabilitySnapshot] Failed to initialize:', error);
        }
      } else {
        console.log('[AgentReliabilitySnapshot] Disabled (AGENT_RELIABILITY_SNAPSHOT_ENABLED=false)');
      }

      // Online eval sampler (ENG-2144) — daily at 17:15 UTC: a seeded uniform random sample of the
      // previous day's completed sessions, graded by the deterministic ENG-2137 graders into
      // Dev-AW-LoopEvents (loopId eval-v2), plus the eval-v2-daily snapshots. Off unless
      // EVAL_V2_SAMPLER_ENABLED=true (enabling it in prod is OPS-7, ENG-2152); the run itself
      // refuses to write without the flag. No grader is validated, so it raises no alert.
      if (process.env.EVAL_V2_SAMPLER_ENABLED === 'true') {
        try {
          const EVAL_V2_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runEvalV2SamplerCron } = await import('./cron/evalV2SamplerCron');
          const nowForEvalV2 = new Date();
          const nextEvalV2Run = new Date(nowForEvalV2);
          nextEvalV2Run.setUTCHours(17, 15, 0, 0);
          if (nextEvalV2Run <= nowForEvalV2) {
            nextEvalV2Run.setUTCDate(nextEvalV2Run.getUTCDate() + 1);
          }
          const msUntilEvalV2 = nextEvalV2Run.getTime() - nowForEvalV2.getTime();
          console.log(
            `[EvalV2Sampler] Initialized — first run at 17:15 UTC (in ${Math.round(msUntilEvalV2 / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('EvalV2Sampler', runEvalV2SamplerCron())
              .catch(e => console.error('[EvalV2Sampler] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('EvalV2Sampler', runEvalV2SamplerCron())
                .catch(e => console.error('[EvalV2Sampler] Error:', e));
            }, EVAL_V2_INTERVAL_MS);
          }, msUntilEvalV2);
        } catch (error) {
          console.error('[EvalV2Sampler] Failed to initialize:', error);
        }
      }

      // Shadow-judge online sampler (ENG-2128, ENG-2189, ENG-2138, ENG-2146) — daily at 18:15
      // UTC: a seeded uniform random sample of the previous day's sessions, scored by every
      // shadow:true custom judge in AW-Settings scoring-judges via scoreSessionWithJudgeIfNeeded.
      // Off unless SHADOW_JUDGE_SAMPLER_ENABLED=true (enabling it in prod is an OPS decision); the
      // run itself refuses to write without the flag. No grader this writes is validated, so it
      // raises no alert.
      if (process.env.SHADOW_JUDGE_SAMPLER_ENABLED === 'true') {
        try {
          const SHADOW_JUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runShadowJudgeSamplerCron } = await import('./cron/shadowJudgeSamplerCron');
          const nowForShadowJudge = new Date();
          const nextShadowJudgeRun = new Date(nowForShadowJudge);
          nextShadowJudgeRun.setUTCHours(18, 15, 0, 0);
          if (nextShadowJudgeRun <= nowForShadowJudge) {
            nextShadowJudgeRun.setUTCDate(nextShadowJudgeRun.getUTCDate() + 1);
          }
          const msUntilShadowJudge = nextShadowJudgeRun.getTime() - nowForShadowJudge.getTime();
          console.log(
            `[ShadowJudgeSampler] Initialized — first run at 18:15 UTC (in ${Math.round(msUntilShadowJudge / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('ShadowJudgeSampler', runShadowJudgeSamplerCron())
              .catch(e => console.error('[ShadowJudgeSampler] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('ShadowJudgeSampler', runShadowJudgeSamplerCron())
                .catch(e => console.error('[ShadowJudgeSampler] Error:', e));
            }, SHADOW_JUDGE_INTERVAL_MS);
          }, msUntilShadowJudge);
        } catch (error) {
          console.error('[ShadowJudgeSampler] Failed to initialize:', error);
        }
      }

      // Nightly failure replay (ENG-591 AC2, ENG-2145) — 04:30 UTC: the registered replay cases
      // against current code; a regression is filed once through the ENG-240 intake. Off unless
      // FAILURE_REPLAY_NIGHTLY_ENABLED=true.
      try {
        const { scheduleFailureReplayNightly } = await import('./cron/failureReplayNightlyCron');
        scheduleFailureReplayNightly({
          isCronEnabled,
          track: (jobName, promise) => cronJobRegistry.track(jobName, promise),
        });
      } catch (error) {
        console.error('[FailureReplayNightly] Failed to initialize:', error);
      }

      // Offline eval suite on "needs eval" markers (ENG-2195) — hourly: when prompt/model/skill
      // markers appeared since the last run, run the deterministic suite and record the verdict in
      // Dev-AW-LoopEvents. Off unless EVAL_MARKER_SUITE_ENABLED=true.
      try {
        const { scheduleEvalMarkerSuite } = await import('./cron/evalMarkerSuiteCron');
        scheduleEvalMarkerSuite({
          isCronEnabled,
          track: (jobName, promise) => cronJobRegistry.track(jobName, promise),
        });
      } catch (error) {
        console.error('[EvalMarkerSuite] Failed to initialize:', error);
      }

      // Claude subscription logins (ENG-2110): daily expiry pass (no-op unless the claudeSubscription
      // funding flag is on), and recovery of any refreshed login a previous process died holding
      // (runs whatever the flag says, and does nothing unless such a dir exists).
      try {
        const { scheduleClaudeSubscriptionExpiry } = await import('./cron/claudeSubscriptionExpiryCron');
        scheduleClaudeSubscriptionExpiry({
          isCronEnabled,
          track: (jobName, promise) => cronJobRegistry.track(jobName, promise),
        });
        const { recoverClaudeSubscriptionOrphansAtBoot } = await import('./services/funding/claudeSubscriptionService');
        // Not awaited: a slow store must never hold up the rest of boot.
        void recoverClaudeSubscriptionOrphansAtBoot()
          .then((recovered) => recovered && console.log('[ClaudeSubscription] boot recovery:', recovered))
          .catch((error) => console.error('[ClaudeSubscription] boot recovery failed:', (error as { code?: string })?.code || 'error'));
      } catch (error) {
        console.error('[ClaudeSubscription] Failed to initialize:', (error as { code?: string })?.code || 'error');
      }

      // Hosted subscription logins (ENG-2110 1c/1d): finish unconfirmed disconnects. Not flag-gated on purpose.
      try {
        const { scheduleHostedSubscriptionSweep } = await import('./cron/hostedSubscriptionSweepCron');
        scheduleHostedSubscriptionSweep({
          isCronEnabled,
          track: (jobName, promise) => cronJobRegistry.track(jobName, promise),
        });
      } catch (error) {
        console.error('[HostedSubscription] Failed to initialize sweep:', (error as { code?: string })?.code || 'error');
      }

      // Weekly Engineering Scoreboard — read-only backend replacement for the
      // laptop launchd job. Runs Mondays at 09:00 UTC, gated by
      // ENGINEERING_SCOREBOARD_LOOP_ENABLED=true. It reads Linear bug stats,
      // DMs Harsha through the existing loop Slack rail, and appends one
      // snapshot for restart-safe trend rendering.
      if (process.env.ENGINEERING_SCOREBOARD_LOOP_ENABLED === 'true') {
        try {
          const { runEngineeringScoreboardLoopOnce } = await import('./cron/engineeringScoreboardLoop');

          const scheduleNextEngineeringScoreboardRun = () => {
            const nowForScoreboard = new Date();
            const nextScoreboardRun = new Date(nowForScoreboard);
            nextScoreboardRun.setUTCHours(9, 0, 0, 0);
            const daysUntilMonday = (1 - nextScoreboardRun.getUTCDay() + 7) % 7;
            nextScoreboardRun.setUTCDate(nextScoreboardRun.getUTCDate() + daysUntilMonday);
            if (nextScoreboardRun <= nowForScoreboard) {
              nextScoreboardRun.setUTCDate(nextScoreboardRun.getUTCDate() + 7);
            }
            const msUntilScoreboard = nextScoreboardRun.getTime() - nowForScoreboard.getTime();

            console.log(
              `[EngineeringScoreboard] Next run Monday 09:00 UTC (in ${Math.round(msUntilScoreboard / 60000)} min)`,
            );
            setTimeout(() => {
              scheduleNextEngineeringScoreboardRun();
              if (!isCronEnabled()) return;
              cronJobRegistry.track('EngineeringScoreboard', runEngineeringScoreboardLoopOnce())
                .catch(e => console.error('[EngineeringScoreboard] Error:', e));
            }, msUntilScoreboard);
          };

          scheduleNextEngineeringScoreboardRun();
        } catch (error) {
          console.error('[EngineeringScoreboard] Failed to initialize:', error);
        }
      } else {
        console.log('[EngineeringScoreboard] Disabled (set ENGINEERING_SCOREBOARD_LOOP_ENABLED=true to enable)');
      }

      // Generic Layer-5 attribution — daily at 18:00 UTC, after the product
      // proposal loops. This measures shipped mutations for every registered
      // loop and writes verdicts back to the durable learning store so future
      // policy runs can read what worked or failed.
      if (process.env.LOOP_ATTRIBUTION_ENABLED !== 'false') {
        try {
          const LOOP_ATTRIBUTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runLoopAttributionOnce } = await import('./loops/cron/loopAttributionCron');

          const nowForAttribution = new Date();
          const nextAttributionRun = new Date(nowForAttribution);
          nextAttributionRun.setUTCHours(18, 0, 0, 0);
          if (nextAttributionRun <= nowForAttribution) {
            nextAttributionRun.setUTCDate(nextAttributionRun.getUTCDate() + 1);
          }
          const msUntilAttribution = nextAttributionRun.getTime() - nowForAttribution.getTime();

          console.log(
            `[LoopAttribution] Initialized — first run at 18:00 UTC (in ${Math.round(msUntilAttribution / 60000)} min)`,
          );
          setTimeout(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('LoopAttribution', runLoopAttributionOnce())
              .catch(e => console.error('[LoopAttribution] Error:', e));
            setInterval(() => {
              if (!isCronEnabled()) return;
              cronJobRegistry.track('LoopAttribution', runLoopAttributionOnce())
                .catch(e => console.error('[LoopAttribution] Error:', e));
            }, LOOP_ATTRIBUTION_INTERVAL_MS);
          }, msUntilAttribution);
        } catch (error) {
          console.error('[LoopAttribution] Failed to initialize:', error);
        }
      } else {
        console.log('[LoopAttribution] Disabled (LOOP_ATTRIBUTION_ENABLED=false)');
      }

    }, 30000); // Delay 30s after startup to allow Agent Mode to boot first
  });
});
