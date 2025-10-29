// Test setup file
// This file runs before all tests

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Set test environment variables
process.env.AWS_REGION = 'us-west-2';
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
// Ensure server-based tests bind to an ephemeral port to avoid conflicts
process.env.PORT = process.env.PORT || '0';

// Suppress console.log during tests unless explicitly needed
const originalConsoleLog = console.log;
console.log = (...args) => {
  // Only log if it's not the environment variables debug message
  if (!args[0]?.includes('Environment variables loaded:')) {
    originalConsoleLog(...args);
  }
};
