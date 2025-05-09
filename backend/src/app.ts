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
import docsRoutes from './routes/docs';

// Import the new controller
import { viewExternalFile } from './controllers/filesController';

const app = express();

// CORS configuration
const corsOptions = {
  origin: [
    'https://agentweb.pro', // Main Production Partner URL
    process.env.FRONTEND_URL || 'http://localhost:5173', // Partner Portal (Deployed or Local)
    process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174' // Customer Portal (Deployed or Local)
    // Hardcoded 'https://app.agentweb.pro' and explicit localhost URLs previously listed
    // are now covered by the environment variables and their fallbacks.
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(passport.initialize());

// Create a new router for file-related routes
const fileRoutes = express.Router();
fileRoutes.get('/view-external', viewExternalFile);

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
app.use('/api/docs', docsRoutes);
app.use('/api/files', fileRoutes); // Add the new file routes

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

export default app; 