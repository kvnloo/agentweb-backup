import bcrypt from 'bcryptjs';
import { userDb } from '../services/db';
import dotenv from 'dotenv';

dotenv.config();

async function createAdminUser() {
  try {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;

    if (!email || !password) {
      console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
      process.exit(1);
    }

    // Check if admin user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      console.log('Admin user already exists');
      process.exit(0);
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = Date.now().toString();

    await userDb.createUser(email, userId, hashedPassword, false, true);
    console.log('Admin user created successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createAdminUser(); 