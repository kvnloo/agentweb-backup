import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import taskRoutes from './routes/tasks';
import waitlistRoutes from './routes/waitlist';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/waitlist', waitlistRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

export default app; 