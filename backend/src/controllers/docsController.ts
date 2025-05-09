import { Request, Response } from 'express';
import { userReleaseNotes } from '../docs/user-release'; // Import from the new file

// The UserReleaseNote interface is now defined in user-release.ts
// const userReleaseNotes data is now imported

export const getUserReleaseNotes = (req: Request, res: Response) => {
  try {
    res.status(200).json(userReleaseNotes);
  } catch (error) {
    console.error('Error fetching user release notes:', error);
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    res.status(500).json({ message: 'Error fetching user release notes', details: message });
  }
}; 