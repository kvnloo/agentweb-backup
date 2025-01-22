import { addDays, addWeeks, addMonths, setHours, setMinutes, format } from 'date-fns';
import { zonedTimeToUtc } from 'date-fns-tz';

export function calculateNextRunTime(frequency: string, timezone?: string): string {
  const now = timezone ? zonedTimeToUtc(new Date(), timezone) : new Date();
  let nextRun: Date;

  // Set default run time to 9:00 AM
  const defaultHour = 9;
  const defaultMinute = 0;

  switch (frequency) {
    case 'daily':
      nextRun = addDays(now, 1);
      break;
    case 'weekly':
      nextRun = addWeeks(now, 1);
      break;
    case 'monthly':
      nextRun = addMonths(now, 1);
      break;
    default:
      // For custom cron expressions, we'll need a cron parser library
      // For now, default to daily
      nextRun = addDays(now, 1);
  }

  // Set the time to the default run time
  nextRun = setHours(nextRun, defaultHour);
  nextRun = setMinutes(nextRun, defaultMinute);

  // If the calculated next run time is in the past, add one more day
  if (nextRun < now) {
    nextRun = addDays(nextRun, 1);
  }

  return nextRun.toISOString();
} 