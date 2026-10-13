/**
 * Emailing a task's subscribers when its asset is approved.
 *
 * Moved out of the Slack `approve_asset` handler (ENG-273) so that an approval given on
 * WhatsApp has the same consequence as one given on Slack. It used to live inline in
 * routes/slack.ts, which made "approved" mean two different things depending on which
 * button was pressed. The logic, log lines and limits are unchanged; only the parameter
 * is now typed on its own rather than read off the surrounding handler.
 *
 * Never throws: an approval that has been recorded must not be failed by a mail problem.
 */
import { taskDb, subscriberDb } from './db';
import { emailService } from './emailService';

export async function notifySubscribersOfApproval(
  approval: { executionId?: string } | null | undefined,
): Promise<void> {
  try {
    if (approval && approval.executionId) {
      console.log(`🔍 Looking up execution details for executionId: ${approval.executionId}`);

      // Get task information from the execution
      const execution = await taskDb.getTaskExecutionById(approval.executionId);
      if (execution) {
        console.log(`✅ Found execution for taskId: ${execution.taskId}`);

        // Get task details
        const task = await taskDb.getTaskById(execution.taskId);
        if (task) {
          console.log(`✅ Found task: ${task.name}`);

          // Get task subscribers
          const subscribers = await subscriberDb.getTaskSubscribers(execution.taskId);
          const activeSubscribers = subscribers ? subscribers.filter((sub: any) => !sub.unsubscribed) : [];
          const subscriberEmails = activeSubscribers.map((sub: any) => sub.email);

          // Apply subscriber email limit
          const emailLimit = parseInt(process.env.SUBSCRIBER_EMAIL_LIMIT || '1000');
          const limitedSubscriberEmails = subscriberEmails.slice(0, emailLimit);

          console.log(`📧 Found ${subscriberEmails.length} active subscribers for task: ${execution.taskId}`);
          if (subscriberEmails.length > emailLimit) {
            console.log(`⚠️ Subscriber count (${subscriberEmails.length}) exceeds limit (${emailLimit}). Sending to first ${emailLimit} subscribers only.`);
          }

          if (limitedSubscriberEmails.length > 0) {
            // Send task results to subscribers using common function
            for (const email of limitedSubscriberEmails) {
              try {
                await emailService.sendTaskExecutionEmail(email, approval.executionId);
                console.log(`📧 Task results sent to subscriber: ${email}`);
              } catch (error) {
                console.error(`Failed to send task results to ${email}:`, error);
                // Continue with other subscribers even if one fails
              }
            }
            console.log(`📧 Task results sent to ${limitedSubscriberEmails.length} subscribers for task: ${execution.taskId}`);
          } else {
            console.log(`No subscribers to notify for task: ${execution.taskId}`);
          }
        } else {
          console.log(`❌ Task not found for taskId: ${execution.taskId}`);
        }
      } else {
        console.log(`❌ Execution not found for executionId: ${approval.executionId}`);
      }
    } else {
      console.log(`❌ No executionId found in approval:`, approval);
    }
  } catch (error) {
    console.error('Error sending approval notifications to subscribers:', error);
    // Don't fail the approval if email notifications fail
  }
}
