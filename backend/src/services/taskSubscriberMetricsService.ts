import { taskDb } from './db';
import { userDb } from './db';
import { subscriberDb } from './db';

export interface TaskSubscriberMetrics {
  subscribers: any[];
  events: any[];
  metrics: {
    timeline: Array<{
      date: string;
      events: { [eventType: string]: number };
      total: number;
      clickedEmails: string[];
    }>;
    totalEvents: number;
    eventTypes: { [eventType: string]: number };
    subjectMetrics: {
      [subject: string]: {
        sent: number;
        delivered: number;
        opened: number;
        clicked: number;
        bounced: number;
        failed: number;
        openRate: number;
        clickThroughRate: number;
        engagedEmails: string[];
      };
    };
  };
}

export interface TaskSubscriberEngagementEvents {
  taskId: string;
  emailSubject: string;
  events: Array<{
    eventId: string;
    emailId: string;
    emailDomain: string;
    eventType: string;
    createdAt: string;
    data: any;
    processedAt: string;
  }>;
  count: number;
}

export class TaskSubscriberMetricsService {
  /**
   * Get comprehensive task subscriber metrics for a given task
   * This is the common function used by both the UI and Agent Mode function calls
   */
  static async getTaskSubscriberMetrics(taskId: string, userId: string): Promise<TaskSubscriberMetrics> {
    try {
      // Get task to verify ownership
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Verify task belongs to user or user is admin
      const user = await userDb.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.isAdmin && task.userId !== userId) {
        throw new Error('Access denied');
      }

      // Get all subscribers for this task
      const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
      
      if (!subscribers || subscribers.length === 0) {
        return {
          subscribers: [],
          events: [],
          metrics: {
            timeline: [],
            totalEvents: 0,
            eventTypes: {},
            subjectMetrics: {}
          }
        };
      }

      // Get email domain from user
      const emailDomain = user.emailDomain;
      
      if (!emailDomain) {
        return {
          subscribers,
          events: [],
          metrics: {
            timeline: [],
            totalEvents: 0,
            eventTypes: {},
            subjectMetrics: {}
          }
        };
      }

      // Get all email events for this domain
      const { emailEventsDb } = await import('./emailEventsDb');
      const allEvents = await emailEventsDb.getEventsByEmailDomain(emailDomain);

      // Collect all emailIds from subscribers' email history
      const taskEmailIds = new Set<string>();
      subscribers.forEach(subscriber => {
        if (subscriber.emailHistory) {
          subscriber.emailHistory.forEach((email: any) => {
            if (email.senderType === 'resend' && email.emailId) {
              taskEmailIds.add(email.emailId);
            }
          });
        }
      });

      // Filter events to only include those with emailIds that match task subscribers' email history
      // Only process Resend events since SMTP emails don't have webhook events
      const taskEvents = allEvents.filter(event => taskEmailIds.has(event.emailId));

      // Process events into metrics data
      const eventTypes: { [eventType: string]: number } = {};
      const dateMap: { [date: string]: { [eventType: string]: number } } = {};
      const clickedEmailsByDate: { [date: string]: string[] } = {};
      // Track unique recipients by subject for delivered, opened, clicked
      const subjectDeliveredRecipients: { [subject: string]: Set<string> } = {};
      const subjectOpenedRecipients: { [subject: string]: Set<string> } = {};
      const subjectClickedRecipients: { [subject: string]: Set<string> } = {};
      
      // Group metrics by email subject
      const subjectMetrics: { [subject: string]: {
        sent: number;
        delivered: number;
        opened: number;
        clicked: number;
        bounced: number;
        failed: number;
        openRate: number;
        clickThroughRate: number;
        engagedEmails: string[];
      } } = {};
      
      // Create a map of emailId to subject for quick lookup
      const emailIdToSubject: { [emailId: string]: string } = {};
      subscribers.forEach(subscriber => {
        if (subscriber.emailHistory) {
          subscriber.emailHistory.forEach((email: any) => {
            if (email.emailId && email.subject) {
              emailIdToSubject[email.emailId] = email.subject;
            }
          });
        }
      });
      
      taskEvents.forEach(event => {
        const eventType = event.eventType;
        const date = new Date(event.createdAt).toISOString().split('T')[0];
        const subject = emailIdToSubject[event.emailId] || 'Unknown Subject';
        
        // Initialize subject metrics if not exists
        if (!subjectMetrics[subject]) {
          subjectMetrics[subject] = {
            sent: 0,
            delivered: 0,
            opened: 0,
            clicked: 0,
            bounced: 0,
            failed: 0,
            openRate: 0,
            clickThroughRate: 0,
            engagedEmails: []
          };
        }
        
        // Count by event type
        eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;
        
        // Count by date
        if (!dateMap[date]) {
          dateMap[date] = {};
        }
        dateMap[date][eventType] = (dateMap[date][eventType] || 0) + 1;
        
        // Count by subject
        if (eventType === 'email.delivered') {
          // Unique delivered recipients per subject
          if (event.data && event.data.to) {
            const emails = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
            if (!subjectDeliveredRecipients[subject]) subjectDeliveredRecipients[subject] = new Set<string>();
            emails.forEach(email => subjectDeliveredRecipients[subject].add(email));
          }
        } else if (eventType === 'email.opened') {
          // Unique opened recipients per subject
          if (event.data && event.data.to) {
            const emails = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
            if (!subjectOpenedRecipients[subject]) subjectOpenedRecipients[subject] = new Set<string>();
            emails.forEach(email => subjectOpenedRecipients[subject].add(email));
          }
          // Add email to engaged list if not already present
          if (event.data && event.data.to) {
            const emails = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
            emails.forEach(email => {
              if (!subjectMetrics[subject].engagedEmails.includes(email)) {
                subjectMetrics[subject].engagedEmails.push(email);
              }
            });
          }
        } else if (eventType === 'email.clicked') {
          // Unique clicked recipients per subject
          if (event.data && event.data.to) {
            const emails = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
            if (!subjectClickedRecipients[subject]) subjectClickedRecipients[subject] = new Set<string>();
            emails.forEach(email => subjectClickedRecipients[subject].add(email));
          }
          // Add email to engaged list if not already present
          if (event.data && event.data.to) {
            const emails = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
            emails.forEach(email => {
              if (!subjectMetrics[subject].engagedEmails.includes(email)) {
                subjectMetrics[subject].engagedEmails.push(email);
              }
            });
          }
        } else if (eventType === 'email.bounced') {
          subjectMetrics[subject].bounced++;
        } else if (eventType === 'email.complained') {
          subjectMetrics[subject].failed++;
        }
        
        // Collect clicked email addresses by date
        if (eventType === 'email.clicked' && event.data && event.data.to) {
          if (!clickedEmailsByDate[date]) {
            clickedEmailsByDate[date] = [];
          }
          const emails = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
          clickedEmailsByDate[date].push(...emails);
        }
      });
      
      // After processing events, set unique counts per subject for delivered/opened/clicked
      Object.keys(subjectMetrics).forEach(subject => {
        const deliveredCount = subjectDeliveredRecipients[subject]?.size || 0;
        const openedCount = subjectOpenedRecipients[subject]?.size || 0;
        const clickedCount = subjectClickedRecipients[subject]?.size || 0;
        subjectMetrics[subject].delivered = deliveredCount;
        subjectMetrics[subject].opened = openedCount;
        subjectMetrics[subject].clicked = clickedCount;
      });

      // Calculate sent emails by subject (from email history)
      subscribers.forEach(subscriber => {
        if (subscriber.emailHistory) {
          subscriber.emailHistory.forEach((email: any) => {
            if (email.subject) {
              if (!subjectMetrics[email.subject]) {
                subjectMetrics[email.subject] = {
                  sent: 0,
                  delivered: 0,
                  opened: 0,
                  clicked: 0,
                  bounced: 0,
                  failed: 0,
                  openRate: 0,
                  clickThroughRate: 0,
                  engagedEmails: []
                };
              }
              subjectMetrics[email.subject].sent++;
            }
          });
        }
      });

      // Calculate rates for each subject using unique recipients
      Object.keys(subjectMetrics).forEach(subject => {
        const metrics = subjectMetrics[subject];
        metrics.openRate = metrics.delivered > 0 ? (metrics.opened / metrics.delivered) * 100 : 0;
        metrics.clickThroughRate = metrics.delivered > 0 ? (metrics.clicked / metrics.delivered) * 100 : 0;
      });
      
      // Convert to timeline array
      const timeline = Object.entries(dateMap)
        .map(([date, events]) => {
          // Get unique clicked emails for this date
          const clickedEmails = clickedEmailsByDate[date] 
            ? [...new Set(clickedEmailsByDate[date])] // Remove duplicates
            : [];
          
          return {
            date,
            events,
            total: Object.values(events).reduce((sum, count) => sum + count, 0),
            clickedEmails
          };
        })
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        subscribers,
        events: taskEvents,
        metrics: {
          timeline,
          totalEvents: taskEvents.length,
          eventTypes,
          subjectMetrics
        }
      };
    } catch (error: any) {
      console.error('Error fetching task subscriber metrics:', error);
      throw error;
    }
  }

  /**
   * Get email engagement events for a specific task and email subject
   * This is the common function used by both the UI and Agent Mode function calls
   */
  static async getTaskSubscriberEngagementEvents(taskId: string, emailSubject: string, userId: string): Promise<TaskSubscriberEngagementEvents> {
    try {
      // Get task to verify ownership
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      // Verify task belongs to user or user is admin
      const user = await userDb.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.isAdmin && task.userId !== userId) {
        throw new Error('Access denied');
      }

      // Get all subscribers for this task
      const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
      
      if (!subscribers || subscribers.length === 0) {
        return {
          taskId,
          emailSubject,
          events: [],
          count: 0
        };
      }

      // Get email domain from user
      const emailDomain = user.emailDomain;
      
      if (!emailDomain) {
        return {
          taskId,
          emailSubject,
          events: [],
          count: 0
        };
      }

      // Collect all Resend email IDs from subscribers' email history that match the subject
      const matchingEmailIds = new Set<string>();
      subscribers.forEach(subscriber => {
        if (subscriber.emailHistory) {
          subscriber.emailHistory.forEach((email: any) => {
            if (email.senderType === 'resend' && email.emailId && email.subject === emailSubject) {
              matchingEmailIds.add(email.emailId);
            }
          });
        }
      });

      if (matchingEmailIds.size === 0) {
        return {
          taskId,
          emailSubject,
          events: [],
          count: 0
        };
      }

      // Import emailEventsDb here to avoid circular dependency
      const { emailEventsDb } = await import('./emailEventsDb');
      
      // Fetch events for each matching email ID
      const allEvents = [];
      for (const emailId of matchingEmailIds) {
        const events = await emailEventsDb.getEventsByEmailId(emailId);
        allEvents.push(...events);
      }

      // Sort events by creation time (newest first)
      allEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      return {
        taskId,
        emailSubject,
        events: allEvents,
        count: allEvents.length
      };
    } catch (error: any) {
      console.error('Error fetching task subscriber engagement events:', error);
      throw error;
    }
  }
}
