import express from 'express';
import cors from 'cors';
import passport from 'passport';
import authRoutes from './routes/auth';
import taskRoutes from './routes/tasks';
import waitlistRoutes from './routes/waitlist';
import scheduleRoutes from './routes/schedules';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(passport.initialize());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/schedules', scheduleRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

export default app; 