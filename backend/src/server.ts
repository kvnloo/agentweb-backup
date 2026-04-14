import app from './app';
import { agentModeService } from './services/agentModeService';
import { generateMarketingResponseWorkerService } from './services/generateMarketingResponseWorkerService';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { generateChatResponse } from './services/chatbotService';
import { checkTokenUsage } from './services/tokenUsageService';

dotenv.config();

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

// Middleware to authenticate WebSocket connections
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    socket.data.user = decoded;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

// WebSocket connection handling
io.on('connection', (socket: Socket) => {
  console.log('Client connected:', socket.id);

  // Auto-join user-specific room for targeted broadcasts
  try {
    const token = socket.handshake.auth.token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || '') as { userId: string };
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

      const decoded = jwt.verify(token, process.env.JWT_SECRET || '') as { userId: string; isAdmin?: boolean; delegateAccess?: { adminUserId: string; adminEmail: string; targetUserId: string; targetEmail: string } };
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
      const response = await generateChatResponse(
        data.sessionId,
        data.message,
        { currentUrl: data.currentUrl, pageContent: data.pageContent, portalType, userId, socketId: socket.id, isDelegatedAdmin }
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

  // Shutdown Agent Mode services (closes MCP clients)
  await agentModeService.shutdown();

  // Shutdown worker service
  await generateMarketingResponseWorkerService.shutdown();

  // Close Socket.IO connections
  io.close((err) => {
    if (err) {
      console.error('Error closing Socket.IO:', err);
    } else {
      console.log('Socket.IO connections closed');
    }
  });

  // Close HTTP server (stops accepting new connections)
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }

    // Exit after cleanup
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 5000);
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

  server.listen(port, async () => {
    console.log(`Server is running on port ${port}`);
    console.log(`WebSocket server is ready`);
    console.log(`Test account email: ${process.env.TEST_EMAIL}`);

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
            executor.processQueue().catch(e => console.error('[SocialEngagement] Direct executor error:', e));
          }, delayMs);
        });

        console.log('[SocialEngagement] Scanner initialized — running first pass...');
        scanner.runScanner().catch(e => console.error('[SocialEngagement] Scanner error:', e));

        setInterval(() => {
          scanner.runScanner().catch(e => console.error('[SocialEngagement] Scanner error:', e));
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
          runActivationAnalysis().catch(e => console.error('[ActivationCron] Error:', e));
          setInterval(() => {
            runActivationAnalysis().catch(e => console.error('[ActivationCron] Error:', e));
          }, ACTIVATION_INTERVAL_MS);
        }, msUntilNextRun);
      } catch (error) {
        console.error('[ActivationCron] Failed to initialize:', error);
      }

    }, 30000); // Delay 30s after startup to allow Agent Mode to boot first
  });
}); 