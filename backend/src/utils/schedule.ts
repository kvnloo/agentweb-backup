import { addDays, addWeeks, addMonths, setHours, setMinutes, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

export function calculateNextRunTime(frequency: string, timezone: string = 'UTC'): string {
  const now = new Date();
  const zonedNow = toZonedTime(now, timezone);
  let nextRun: Date;

  // Set default run time to 9:00 AM
  const defaultHour = 9;
  const defaultMinute = 0;

  switch (frequency) {
    case 'daily':
      nextRun = addDays(zonedNow, 1);
      break;
    case 'weekly':
      nextRun = addWeeks(zonedNow, 1);
      break;
    case 'monthly':
      nextRun = addMonths(zonedNow, 1);
      break;
    default:
      // For custom cron expressions, we'll need a cron parser library
      // For now, default to daily
      nextRun = addDays(zonedNow, 1);
  }

  // Set the time to the default run time
  nextRun = setHours(nextRun, defaultHour);
  nextRun = setMinutes(nextRun, defaultMinute);

  return format(nextRun, "yyyy-MM-dd'T'HH:mm:ssXXX");
}
