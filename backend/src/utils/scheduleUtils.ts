import { addDays, addWeeks, addMonths, setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';

export type Frequency = 'daily' | 'weekly' | 'monthly';

export function calculateNextRunTime(frequency: Frequency): string {
  // Start with current date
  let now = new Date();
  
  // Set the time to 9:00 AM for the next run
  let nextRun = setHours(now, 9);
  nextRun = setMinutes(nextRun, 0);
  nextRun = setSeconds(nextRun, 0);
  nextRun = setMilliseconds(nextRun, 0);

  // If it's past 9 AM today, move to next occurrence
  if (now > nextRun) {
    nextRun = addDays(nextRun, 1);
  }

  // Calculate next run based on frequency
  switch (frequency) {
    case 'daily':
      // Already handled above
      break;
    case 'weekly':
      nextRun = addWeeks(nextRun, 1);
      break;
    case 'monthly':
      nextRun = addMonths(nextRun, 1);
      break;
    default:
      throw new Error('Invalid frequency');
  }

  return nextRun.toISOString();
}

export function isValidFrequency(frequency: string): frequency is Frequency {
  return ['daily', 'weekly', 'monthly'].includes(frequency);
}

export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (e) {
    return false;
  }
} 