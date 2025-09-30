import { Request, Response } from 'express';
import { benchmarkTestDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';
import { BenchmarkTest, CreateBenchmarkTestRequest, RunBenchmarkTestRequest } from '../types/benchmark';
import { v4 as uuidv4 } from 'uuid';

// Create a new benchmark test from a session
export async function createBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { sessionId, testName, description, expectedOutput }: CreateBenchmarkTestRequest = req.body;
    const adminUserId = req.user.userId;

    // Check if user is admin (required for creating benchmark tests)
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can create benchmark tests' 
      });
    }

    // Get the session to extract conversation history
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ 
        message: 'Session not found' 
      });
    }

    // Create the benchmark test
    const testId = uuidv4();
    const benchmarkTest: BenchmarkTest = {
      testId,
      createdBy: adminUserId,
      sessionId,
      userId: session.userId,
      testName,
      description,
      conversationHistory: {
        messages: session.messages || []
      },
      expectedOutput,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
      successCount: 0,
      failureCount: 0
    };

    await benchmarkTestDb.createBenchmarkTest(benchmarkTest);

    res.status(201).json({
      message: 'Benchmark test created successfully',
      testId,
      benchmarkTest
    });
  } catch (error) {
    console.error('Error creating benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to create benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get all benchmark tests (admin only)
export async function getAllBenchmarkTests(req: AuthenticatedRequest, res: Response) {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can view all benchmark tests' 
      });
    }

    const limit = parseInt(req.query.limit as string) || 100;
    const tests = await benchmarkTestDb.getAllBenchmarkTests(limit);

    res.json({
      tests,
      count: tests.length
    });
  } catch (error) {
    console.error('Error getting benchmark tests:', error);
    res.status(500).json({ 
      message: 'Failed to get benchmark tests',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get benchmark tests created by current admin
export async function getMyBenchmarkTests(req: AuthenticatedRequest, res: Response) {
  try {
    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can view benchmark tests' 
      });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const tests = await benchmarkTestDb.getBenchmarkTestsByCreator(req.user.userId, limit);

    res.json({
      tests,
      count: tests.length
    });
  } catch (error) {
    console.error('Error getting my benchmark tests:', error);
    res.status(500).json({ 
      message: 'Failed to get benchmark tests',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get a specific benchmark test
export async function getBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;

    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can view benchmark tests' 
      });
    }

    const test = await benchmarkTestDb.getBenchmarkTest(testId);
    if (!test) {
      return res.status(404).json({ 
        message: 'Benchmark test not found' 
      });
    }

    res.json(test);
  } catch (error) {
    console.error('Error getting benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to get benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Update a benchmark test
export async function updateBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;
    const updates = req.body;

    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can update benchmark tests' 
      });
    }

    // Remove fields that shouldn't be updated
    delete updates.testId;
    delete updates.createdBy;
    delete updates.createdAt;
    delete updates.runCount;
    delete updates.successCount;
    delete updates.failureCount;

    const updatedTest = await benchmarkTestDb.updateBenchmarkTest(testId, updates);

    res.json({
      message: 'Benchmark test updated successfully',
      test: updatedTest
    });
  } catch (error) {
    console.error('Error updating benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to update benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Delete a benchmark test
export async function deleteBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;

    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can delete benchmark tests' 
      });
    }

    await benchmarkTestDb.deleteBenchmarkTest(testId);

    res.json({
      message: 'Benchmark test deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to delete benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Run a benchmark test
export async function runBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;
    const { llmName }: RunBenchmarkTestRequest = req.body;

    // Check if user is admin
    if (!req.user.isAdmin) {
      return res.status(403).json({ 
        message: 'Only admin users can run benchmark tests' 
      });
    }

    // Get the benchmark test
    const test = await benchmarkTestDb.getBenchmarkTest(testId);
    if (!test) {
      return res.status(404).json({ 
        message: 'Benchmark test not found' 
      });
    }

    if (test.status !== 'active') {
      return res.status(400).json({ 
        message: 'Benchmark test must be active to run' 
      });
    }

    // TODO: Implement actual benchmark test execution
    // This would involve:
    // 1. Running the conversation through the agent
    // 2. Analyzing the response against expected criteria
    // 3. Calculating a score
    // 4. Storing the results
    // 5. Updating the test statistics

    const runId = uuidv4();
    const startTime = Date.now();

    // For now, return a mock result
    const mockResult = {
      testId,
      runId,
      status: 'success' as const,
      score: 85,
      actualResponse: 'Mock response from agent',
      actualFunctionCalls: ['create_task_from_prompt'],
      keywordMatches: ['marketing', 'strategy'],
      keywordMisses: ['budget'],
      functionCallMatches: ['create_task_from_prompt'],
      functionCallMisses: [],
      executionTime: Date.now() - startTime,
      createdAt: new Date().toISOString()
    };

    // Update test statistics
    await benchmarkTestDb.incrementRunCount(testId, mockResult.status === 'success');

    res.json({
      message: 'Benchmark test executed successfully',
      result: mockResult
    });
  } catch (error) {
    console.error('Error running benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to run benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
