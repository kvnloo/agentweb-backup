import { taskDb } from './db';
import { userDb } from './db';
import { subscriberDb } from './db';

export interface TaskSubscriberMetrics {
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
        opened?: number;
        clicked: number;
        bounced: number;
        failed: number;
        openRate?: number;
        clickThroughRate: number;
        engagedEmails: string[];
      };
    };
  };
}

export interface TaskSubscriberEngagementEvents {
  taskId: string;
  emailSubject: string;
  eventsByUser: Array<{
    userEmail: string;
    events: Array<{
      eventType: 'email.delivered' | 'email.opened' | 'email.clicked';
      createdAt: string;
    }>;
  }>;
  totalEngagedUsers: number;
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
        openRate?: number;
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
      const processedSubjectMetrics: { [subject: string]: any } = {};
      Object.keys(subjectMetrics).forEach(subject => {
        const metrics = subjectMetrics[subject];
        metrics.clickThroughRate = metrics.delivered > 0 ? (metrics.clicked / metrics.delivered) * 100 : 0;
        
        // Only include opened and openRate if opened > 0 (opened tracking is enabled)
        if (metrics.opened > 0) {
          metrics.openRate = metrics.delivered > 0 ? (metrics.opened / metrics.delivered) * 100 : 0;
          processedSubjectMetrics[subject] = metrics;
        } else {
          // Remove opened and openRate when opened is 0 (opened tracking disabled)
          const { opened, openRate, ...metricsWithoutOpened } = metrics;
          processedSubjectMetrics[subject] = metricsWithoutOpened;
        }
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
        metrics: {
          timeline,
          totalEvents: taskEvents.length,
          eventTypes,
          subjectMetrics: processedSubjectMetrics
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
          eventsByUser: [],
          totalEngagedUsers: 0
        };
      }

      // Get email domain from user
      const emailDomain = user.emailDomain;
      
      if (!emailDomain) {
        return {
          taskId,
          emailSubject,
          eventsByUser: [],
          totalEngagedUsers: 0
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
          eventsByUser: [],
          totalEngagedUsers: 0
        };
      }

      // Import emailEventsDb here to avoid circular dependency
      const { emailEventsDb } = await import('./emailEventsDb');
      
      // Fetch events for each matching email ID and filter for delivered/clicked/opened events
      const allEvents = [];
      for (const emailId of matchingEmailIds) {
        const events = await emailEventsDb.getEventsByEmailId(emailId);
        // Filter for delivered, clicked and opened events
        const filteredEvents = events.filter(event => 
          event.eventType === 'email.delivered' || 
          event.eventType === 'email.clicked' || 
          event.eventType === 'email.opened'
        );
        allEvents.push(...filteredEvents);
      }

      // Group events by user email
      const eventsByUserMap = new Map<string, Array<{eventType: 'email.delivered' | 'email.opened' | 'email.clicked', createdAt: string}>>();
      
      allEvents.forEach(event => {
        // Handle both string and array formats for the 'to' field
        const toField = event.data?.to;
        const userEmail = Array.isArray(toField) ? toField[0] : toField || 'unknown';
        
        if (!eventsByUserMap.has(userEmail)) {
          eventsByUserMap.set(userEmail, []);
        }
        eventsByUserMap.get(userEmail)!.push({
          eventType: event.eventType as 'email.delivered' | 'email.opened' | 'email.clicked',
          createdAt: event.createdAt
        });
      });

      // Convert map to array and sort events by createdAt for each user
      let eventsByUser = Array.from(eventsByUserMap.entries()).map(([userEmail, events]) => ({
        userEmail,
        events: events.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      }));

      // Filter out users who only have delivered events (no engagement)
      eventsByUser = eventsByUser.filter(user => {
        const hasOpenedOrClicked = user.events.some(event => 
          event.eventType === 'email.opened' || event.eventType === 'email.clicked'
        );
        return hasOpenedOrClicked;
      });

      // Sort users by the createdAt of their first event (chronological order)
      eventsByUser.sort((a, b) => {
        const aFirstEvent = a.events[0]?.createdAt;
        const bFirstEvent = b.events[0]?.createdAt;
        if (!aFirstEvent || !bFirstEvent) return 0;
        return new Date(aFirstEvent).getTime() - new Date(bFirstEvent).getTime();
      });
      
      return {
        taskId,
        emailSubject,
        eventsByUser,
        totalEngagedUsers: eventsByUser.length
      };
    } catch (error: any) {
      console.error('Error fetching task subscriber engagement events:', error);
      throw error;
    }
  }
}
