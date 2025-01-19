import app from './app';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const port = process.env.PORT || 3001;

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

// Create test account before starting the server
createTestAccount().then(() => {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`Test account email: ${process.env.TEST_EMAIL}`);
  });
}); 