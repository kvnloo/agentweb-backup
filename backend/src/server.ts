import app from './app';
import { isCronEnabled, disableCron } from './utils/instanceState';
import { cronJobRegistry } from './utils/cronJobRegistry';
import { DRAIN_CEILING_MS } from './utils/shutdownConstants';
import { agentModeService } from './services/agentModeService';
import { generateMarketingResponseWorkerService } from './services/generateMarketingResponseWorkerService';
import dotenv from 'dotenv';
import { getJwtSecret, assertJwtSecretAtBoot } from './config/jwt';
import bcrypt from 'bcryptjs';
import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { generateChatResponse, chatbotDb } from './services/chatbotService';
import { checkTokenUsage } from './services/tokenUsageService';
import { userDb } from './services/db';
import { registerIo } from './services/sessionSockets';
import {
  startLiveSession,
  sendAudioChunk,
  sendAudioStreamEnd,
  sendTextTurn,
  closeLiveSession,
  hasLiveSession,
} from './services/liveVoiceService';
import {
  ONBOARDING_TELEMETRY_EVENTS,
  recordOnboardingEvent,
} from './services/onboardingTelemetry';

dotenv.config();

// Fail fast at boot (before binding the port) if the JWT secret is missing, rather than
// letting tokens be signed/verified with a fallback secret or erroring on first request.
assertJwtSecretAtBoot();

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
        /^https:\/\/[a-zA-Z0-9\-]+\.ngrok-free\.app$/, // Allow any ngrok-free.app subdomain
        /^https:\/\/[a-zA-Z0-9\-]+\.ngrok\.io$/, // Allow any ngrok.io subdomain
      ];

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
        sv?: number;
        delegateAccess?: unknown;
        _svc?: boolean;
      };

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
    try {
      const session = await chatbotDb.getChatSession(conversableSessionId);
      if (!session) return next(new Error('Session not found'));
      const interactiveToken = session.interactiveShareMetadata?.token;
      if (!interactiveToken || interactiveToken !== conversableToken) {
        return next(new Error('Invalid conversable token'));
      }
      if (!session.interactiveShareMetadata?.isActive) {
        return next(new Error('Interactive share is not active'));
      }
      socket.data.conversableSessionId = conversableSessionId;
      socket.data.conversableUserId = session.userId;
      return next();
    } catch (err: any) {
      return next(new Error('Conversable auth error'));
    }
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

  // Emit helper that sends events to this specific socket
  const liveEmit = (event: string, data: unknown) => socket.emit(event, data);

  // Verify the socket user owns the sessionId before allowing live operations
  function getLiveUserId(): string {
    // Conversable (iShare) socket — userId resolved at auth time
    if (socket.data.conversableUserId) {
      return socket.data.conversableUserId;
    }
    const token = socket.handshake.auth.token;
    if (!token) throw new Error('No auth token');
    const decoded = jwt.verify(token, getJwtSecret()) as {
      userId: string;
      delegateAccess?: { targetUserId: string };
    };
    return decoded.delegateAccess?.targetUserId || decoded.userId;
  }

  socket.on('live:start', async ({
    sessionId,
    toolProfile = 'default',
  }: {
    sessionId: string;
    toolProfile?: 'default' | 'onboarding';
  }) => {
    try {
      // For conversable sockets, enforce that the sessionId matches what was auth'd
      if (socket.data.conversableSessionId && socket.data.conversableSessionId !== sessionId) {
        throw new Error('Session ID mismatch for conversable socket');
      }
      const userId = getLiveUserId(); // auth check — throws if invalid
      console.log(`[liveVoice] live:start received for session ${sessionId} on socket ${socket.id}`);
      // Track which live sessions this socket owns (for disconnect cleanup)
      if (!socket.data.liveSessions) socket.data.liveSessions = new Set<string>();
      socket.data.liveSessions.add(sessionId);
      await startLiveSession(sessionId, socket.id, liveEmit, userId, toolProfile);
      console.log(`[liveVoice] live:start completed for session ${sessionId}`);
    } catch (err: any) {
      socket.data.liveSessions?.delete(sessionId);
      console.error(`[liveVoice] live:start error for session ${sessionId}:`, err?.message);
      socket.emit('live:error', { sessionId, error: err?.message ?? 'Failed to start live session' });
    }
  });

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

  socket.on('live:close', ({ sessionId }: { sessionId: string }) => {
    closeLiveSession(sessionId, socket.id);
    socket.data.liveSessions?.delete(sessionId);
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
      const userId = getLiveUserId();
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
  socket.on('message', async (data: {
    sessionId: string;
    message: string;
    currentUrl?: string;
    pageContent?: string;
    portal?: 'customer' | 'partner';
  }) => {
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
      const usageStatus = await checkTokenUsage(userId);
      if (!usageStatus.allowed) {
        socket.emit('error', {
          message: 'Monthly token limit reached. Please contact support or upgrade your plan.',
          code: 'TOKEN_LIMIT_EXCEEDED',
          tokenUsage: usageStatus,
        });
        return;
      }

      const portalType = data.portal || 'partner';
      const orgRole = portalType === 'customer' ? (await userDb.getUserById(userId))?.orgRole : undefined;
      const response = await generateChatResponse(
        data.sessionId,
        data.message,
        { currentUrl: data.currentUrl, pageContent: data.pageContent, portalType, userId, socketId: socket.id, isDelegatedAdmin, orgRole }
      );

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
  });

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

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Register force-exit FIRST so it's always set, even if an await below hangs.
  // Force-exit buffer = drain ceiling + 3 min.
  // EB Timeout: 900 s (15 min) sits above this so EB never force-kills first.
  setTimeout(() => {
    console.error('[gracefulShutdown] Force-exiting after drain ceiling');
    process.exit(1);
  }, DRAIN_CEILING_MS + 3 * 60 * 1000).unref();

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

  // 3. Stop accepting new HTTP connections
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }
  });

  // 4. Disconnect all Socket.IO clients (they auto-reconnect to the new instance)
  io.close((err) => {
    if (err) {
      console.error('Error closing Socket.IO:', err);
    } else {
      console.log('Socket.IO connections closed');
    }
  });

  // 5. Drain the LLM worker (scheduled chats / EMMA runs) and every other
  //    in-flight cron job (LinkedIn sync, drip worker, meta token refresh,
  //    etc. — see cronJobRegistry) concurrently, up to the same ceiling, so
  //    the total wait is the max of the two rather than their sum.
  const [, cronDrain] = await Promise.all([
    generateMarketingResponseWorkerService.shutdown(),
    cronJobRegistry.drain(),
  ]);
  if (!cronDrain.drained) {
    console.warn(
      `[gracefulShutdown] Cron drain ceiling reached — ${cronDrain.stuckCount} job(s) still in-flight:`,
      cronDrain.stuckJobs
    );
  }

  // 6. Close parent MCP clients after the drain (child has its own MCP instance)
  await agentModeService.shutdown();

  // 6.5. Flush OTel spans (ENG-141) — best-effort, never rejects, no-op when
  //      tracing is off. Deploy-killed runs are exactly the traces we need.
  await (await import('./observability/tracing')).flushTelemetry();

  // 7. Clean exit
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

  server.listen(port, async () => {
    console.log(`Server is running on port ${port}`);
    console.log(`WebSocket server is ready`);
    console.log(`Test account email: ${process.env.TEST_EMAIL}`);

    // Self-heal the telemetry/loop tables if missing — fire-and-forget, non-fatal.
    // Prevents the silent-no-op class of bug where a writer swallows
    // ResourceNotFound and a whole loop subsystem runs against a table that
    // was never provisioned (see services/ensureCriticalTables.ts).
    void import('./services/ensureCriticalTables')
      .then(({ ensureCriticalTables }) => ensureCriticalTables())
      .catch((err) => console.error('[startup] ensureCriticalTables failed (non-fatal):', err?.message || err));

    // Proactively refresh OAuth tokens for outbound MCP servers before they expire.
    import('./mcp/client/mcpOAuthRefreshService')
      .then(({ startMcpOAuthRefreshScheduler }) => startMcpOAuthRefreshScheduler())
      .catch((error) => console.error('Failed to start MCP OAuth refresh scheduler:', error));

    // Initialize Agent Mode tools in background - don't block server startup
    // This prevents health check timeouts during deployment (e.g. Elastic Beanstalk)
    console.log('Initializing Agent Mode Tools (non-blocking)...');
    agentModeService.initialize()
      .then(() => {
        console.log('Agent Mode Tools initialized successfully');
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
      // touches the chat path. Gated by AGENT_RELIABILITY_SNAPSHOT_ENABLED.
      if (process.env.AGENT_RELIABILITY_SNAPSHOT_ENABLED === 'true') {
        try {
          const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
          const { runAgentReliabilitySnapshot } = await import('./cron/agentReliabilitySnapshotCron');

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
        console.log('[AgentReliabilitySnapshot] Disabled (set AGENT_RELIABILITY_SNAPSHOT_ENABLED=true to enable)');
      }

      // Weekly Engineering Scoreboard — read-only backend replacement for the
      // laptop launchd job. Runs Mondays at 09:00 UTC, gated by
      // ENGINEERING_SCOREBOARD_LOOP_ENABLED=true. It reads Linear + Weave,
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
