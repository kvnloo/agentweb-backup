import express from 'express';
import cors from 'cors';
import passport from 'passport';
import authRoutes from './routes/auth';
import taskRoutes from './routes/tasks';
import waitlistRoutes from './routes/waitlist';
import scheduleRoutes from './routes/schedules';
import adminRoutes from './routes/admin';
import configRouter from './routes/config';
import workflowRoutes from './routes/workflows';
import templateRoutes from './routes/templates';
import chatbotRoutes from './routes/chatbot';

const app = express();

// CORS configuration
const corsOptions = {
  origin: [
    'https://agentweb.pro',
    'http://localhost:5173', // Keep local development
    process.env.FRONTEND_URL || 'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(passport.initialize());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRouter);
app.use('/api/workflows', workflowRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/chatbot', chatbotRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

export default app; 