// Test setup for Meta Ad Library tests
import { jest } from '@jest/globals';

// Mock console methods to reduce noise in tests
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

beforeAll(() => {
  console.error = jest.fn();
  console.log = jest.fn();
});

afterAll(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

// Mock environment variables
process.env.META_API_VERSION = 'v18.0';
