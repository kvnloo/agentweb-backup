import express, { RequestHandler } from 'express';
import { authenticateToken } from '../middleware/auth';
import {
  createBenchmarkTest,
  getAllBenchmarkTests,
  getMyBenchmarkTests,
  getBenchmarkTest,
  updateBenchmarkTest,
  deleteBenchmarkTest,
  runBenchmarkTest
} from '../controllers/benchmark';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Create a new benchmark test from a session
router.post('/', createBenchmarkTest as unknown as RequestHandler);

// Get all benchmark tests (admin only)
router.get('/', getAllBenchmarkTests as unknown as RequestHandler);

// Get benchmark tests created by current admin
router.get('/my', getMyBenchmarkTests as unknown as RequestHandler);

// Get a specific benchmark test
router.get('/:testId', getBenchmarkTest as unknown as RequestHandler);

// Update a benchmark test
router.put('/:testId', updateBenchmarkTest as unknown as RequestHandler);

// Delete a benchmark test
router.delete('/:testId', deleteBenchmarkTest as unknown as RequestHandler);

// Run a benchmark test
router.post('/:testId/run', runBenchmarkTest as unknown as RequestHandler);

export default router;
