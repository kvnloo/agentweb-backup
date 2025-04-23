import { Router } from 'express';
import { createMarketResearch, getMarketResearchById, getAllMarketResearch } from '../controllers/marketResearch';
import verifyToken from '../middleware/authMiddleware';

const router = Router();

// Apply auth middleware to all routes
router.use(verifyToken);

// Create a new market research task
router.post('/', createMarketResearch);

// Get market research by ID
router.get('/:id', getMarketResearchById);

// Get all market research tasks
router.get('/', getAllMarketResearch);

export default router; 