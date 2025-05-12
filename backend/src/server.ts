import app from './app';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { generateChatResponse } from './services/chatbotService';

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
        process.env.FRONTEND_URL || 'http://localhost:5173'
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
      const portalType = data.portal || 'partner';
      const response = await generateChatResponse(
        data.sessionId,
        data.message,
        data.currentUrl,
        data.pageContent,
        portalType
      );

      // Send response back to the client
      socket.emit('message', {
        sessionId: data.sessionId,
        content: response
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

// Create test account before starting the server
createTestAccount().then(() => {
  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`WebSocket server is ready`);
    console.log(`Test account email: ${process.env.TEST_EMAIL}`);
  });
}); 