import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { resendService } from './resendService';

dotenv.config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export const emailService = {
  // Escape HTML content to make it safe for emails
  escapeHtml(html: string): string {
    if (!html) return '';
    
    return html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  async sendEmail(to: string, subject: string, text: string, html: string, cc?: string) {
    const mailOptions = {
      from: process.env.FROM_EMAIL,
      replyTo: 'support@agentweb.pro',
      to,
      cc,
      subject,
      text,
      html
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log('Email sent successfully to:', to, cc ? `CC: ${cc}` : '');
    } catch (error) {
      console.error('Error sending email:', error);
      // Don't throw - just log the error
    }
  },

  async sendInvitation(email: string) {
    const mailOptions = {
      from: process.env.FROM_EMAIL,
      replyTo: 'support@agentweb.pro',
      to: email,
      subject: 'Welcome to AgentWeb - Your Invitation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to AgentWeb!</h2>
          <p>We're excited to have you join our platform. Your waitlist application has been approved!</p>
          <p>To get started, please click the button below to create your account:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/register?email=${encodeURIComponent(email)}" 
               style="background-color: #1976d2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
              Create Your Account
            </a>
          </div>
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p>${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/register?email=${encodeURIComponent(email)}</p>
          
          <h3>Getting Started with AgentWeb</h3>
          <p>Check out these resources to help you get the most out of AgentWeb:</p>
          <ul>
            <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/changelog">Release Notes</a> - Learn about our latest features and updates</li>
            <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/guide">User Guide</a> - Detailed instructions on how to create and manage your web automation tasks</li>
          </ul>
          
          <p>If you have any questions or need assistance, please reply to this email or contact our support team at support@agentweb.pro.</p>
          
          <p>Best regards,<br>The AgentWeb Team</p>
        </div>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log('Invitation email sent successfully to:', email);
    } catch (error) {
      console.error('Error sending invitation email:', error);
      throw error;
    }
  },

  async sendTaskOwnershipChangeEmail(
    recipientEmail: string,
    taskName: string,
    taskId: string,
    oldOwnerEmail: string,
    newOwnerEmail: string,
    changedByEmail: string,
    siteDomain: string,
    cc?: string
  ) {
    const subject = 'Task Ownership Change Notification';
    const taskUrl = `${siteDomain}/tasks/${taskId}`;
    
    const text = `Task Ownership Change\n\n` +
      `The ownership of task "${taskName}" has been changed.\n\n` +
      `Previous Owner: ${oldOwnerEmail}\n` +
      `New Owner: ${newOwnerEmail}\n` +
      `Changed By: ${changedByEmail}\n\n` +
      `View task details: ${taskUrl}\n\n` +
      `Note: Only the new owner will have access to the task details page. The previous owner will see an "Access Denied" error when trying to access the task.\n\n` +
      `Best regards,\nAgentWeb Team`;

    const html = `
      <h2>Task Ownership Change</h2>
      <p>The ownership of task "${taskName}" has been changed.</p>
      <table style="border-collapse: collapse; margin: 10px 0;">
        <tr>
          <td style="padding: 5px; border: 1px solid #ddd;"><strong>Previous Owner:</strong></td>
          <td style="padding: 5px; border: 1px solid #ddd;">${oldOwnerEmail}</td>
        </tr>
        <tr>
          <td style="padding: 5px; border: 1px solid #ddd;"><strong>New Owner:</strong></td>
          <td style="padding: 5px; border: 1px solid #ddd;">${newOwnerEmail}</td>
        </tr>
        <tr>
          <td style="padding: 5px; border: 1px solid #ddd;"><strong>Changed By:</strong></td>
          <td style="padding: 5px; border: 1px solid #ddd;">${changedByEmail}</td>
        </tr>
      </table>
      <p>You can view the task details <a href="${taskUrl}">here</a>.</p>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 15px 0;">
        <p style="margin: 0; color: #666;"><strong>Important Note:</strong> Only the new owner will have access to the task details page. The previous owner will see an "Access Denied" error when trying to access the task.</p>
      </div>
      <p>Best regards,<br>AgentWeb Team</p>
    `;

    await this.sendEmail(recipientEmail, subject, text, html, cc);
  },

  async sendTaskExecutionEmail(
    toEmail: string,
    executionId: string
  ) {
    try {
      // Import required services
      const { taskDb, subscriberDb } = require('../services/db');
      
      // Get environment variables
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      
      // Fetch execution data
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution) {
        throw new Error(`Execution not found: ${executionId}`);
      }
      
      // Fetch task data
      const task = await taskDb.getTaskById(execution.taskId);
      if (!task) {
        throw new Error(`Task not found: ${execution.taskId}`);
      }

      // Fetch user data for account-level email configuration
      const { userDb } = require('../services/db');
      const user = await userDb.getUserById(task.userId);
      if (!user) {
        throw new Error(`User not found: ${task.userId}`);
      }
      

      // If sendHtmlReportOnly is enabled, try to find HTML content and send only that
      if (task.sendHtmlReportOnly) {
        if (!execution.result_files || execution.result_files.length === 0) {
          // No result files available, don't send email
          console.log(`sendHtmlReportOnly enabled but no result files available for task ${task.taskId}, skipping email to ${toEmail}`);
          return;
        }
        
        let htmlContentFromFile = '';
        let htmlContentUrl = '';
        
        // Look for HTML files in result_files
        for (const file of execution.result_files) {
          if ((file.is_html || file.view_type === 'html') && file.url) {
            try {
              // Import fetch
              const fetch = require('node-fetch');
              const response = await fetch(file.url);
              
              if (response.ok) {
                const fetchedHtmlContent = await response.text();
                
                if (task.sendHtmlReportOnly) {
                  // For sendHTMLReportOnly, use raw HTML content without enhancement
                  htmlContentFromFile = fetchedHtmlContent;
                } else {
                  // For regular emails, wrap with html-result div
                  htmlContentFromFile = `
                  <div class="html-result">
                    ${fetchedHtmlContent}
                  </div>
                `;
                }
                
                htmlContentUrl = file.url; // Capture the URL for email history
                console.log(`Successfully fetched HTML content from ${file.url}`);
                break; // Use the first HTML file found
              } else {
                console.error(`Failed to fetch HTML content from ${file.url}: ${response.statusText}`);
                // Don't set htmlContentFromFile for errors
              }
            } catch (error) {
              console.error(`Error fetching HTML content from ${file.url}:`, error);
              // Don't set htmlContentFromFile for errors
            }
            break; // Process only the first HTML file found
          }
        }

        // Only send email if we successfully found and fetched HTML content
        if (htmlContentFromFile) {
          const currentDate = new Date().toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
          });
          
          // Create footer content
          const footerContent = `
            <div style="margin-top: 25px; font-size: 0.9em; padding: 20px; text-align: center;">
              ${!task.sendHtmlReportOnly ? `<p>Manage task and history at: <a href="${customerFrontendUrl}/tasks/${task.taskId}">${customerFrontendUrl}/tasks/${task.taskId}</a></p>` : ''}
              ${htmlContentUrl && !task.emailFriendlyHtml ? `<p><small><strong>Note:</strong> Some visuals may not display properly in the email. <a href="${htmlContentUrl}">View full report here</a> for the complete experience.</small></p>` : ''}
              <hr>
              <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
              <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${task.taskId}&email=${encodeURIComponent(toEmail)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
            </div>
          `;
          
          // For sendHTMLReportOnly, inject footer before closing </body> tag
          // For regular emails, inject before closing </body> tag
          const simplifiedHtml = htmlContentFromFile.replace('</body>', `${footerContent}</body>`);

          const subject = `${task.name} - ${currentDate}`;
          const text = `Task Report: ${task.name}\n\nView the HTML report in the email body.${!task.sendHtmlReportOnly ? `\n\nManage task and history at: ${customerFrontendUrl}/tasks/${task.taskId}` : ''}`;
          
          // Check if task has custom email sender configured
          let resendEmailId = null;
          let senderType: 'SMTP' | 'resend' = 'SMTP';
          
          // Determine email sender configuration with fallback to account-level
          let emailSender = task.emailSender;
          let fromName = task.fromName;
          
          // If task doesn't have custom email sender, use account-level configuration
          if (!emailSender || !fromName) {
            if (user.emailDomain && user.defaultSenderUsername && user.fromName) {
              emailSender = `${user.defaultSenderUsername}@${user.emailDomain}`;
              fromName = user.fromName;
            }
          }
          
          if (emailSender && fromName) {
            // Use Resend service for custom email sender (task-level or account-level)
            const from = `${fromName} <${emailSender}>`;
            const resendResult = await resendService.sendEmail({
              from,
              to: toEmail,
              subject,
              html: simplifiedHtml,
              text
            });
            resendEmailId = resendResult?.id || null;
            senderType = 'resend';
            console.log(`HTML-only task execution email sent via Resend to: ${toEmail} from: ${from}`, resendEmailId ? `(ID: ${resendEmailId})` : '');
          } else {
            // Use default SMTP service
            await this.sendEmail(toEmail, subject, text, simplifiedHtml);
            senderType = 'SMTP';
            console.log(`HTML-only task execution email sent via SMTP to: ${toEmail}`);
          }
          
          // Add email history to subscriber
          try {
            const sentAt = new Date().toISOString();
            await subscriberDb.addEmailHistory(execution.taskId, toEmail, {
              sentAt: sentAt,
              subject: subject,
              status: 'sent',
              taskExecutionId: executionId,
              htmlContentUrl: htmlContentUrl,
              senderType: senderType,
              emailId: resendEmailId || undefined
            });
            console.log(`Added email history for subscriber: ${toEmail}`, resendEmailId ? `(Resend ID: ${resendEmailId})` : '(SMTP)');
          } catch (historyError) {
            console.error(`Failed to add email history for ${toEmail}:`, historyError);
            // Don't throw error, email was sent successfully
          }
          
          return;
        } else {
          // HTML content not available, don't send email
          console.log(`sendHtmlReportOnly enabled but no valid HTML content found for task ${task.taskId}, skipping email to ${toEmail}`);
          return;
        }
      }
      
      // Create execution start/end time strings
      const startTime = execution.startTime ? new Date(execution.startTime).toLocaleString() : 'Not available';
      const completedTime = execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'Not available';
    
    // Calculate execution duration if both start and end times are available
    let durationStr = '';
    if (execution.startTime && execution.completedAt) {
      const start = new Date(execution.startTime).getTime();
      const end = new Date(execution.completedAt).getTime();
      const durationMs = end - start;
      const durationMinutes = Math.floor(durationMs / 60000);
      const durationSeconds = Math.floor((durationMs % 60000) / 1000);
      
      if (durationMinutes > 0) {
        durationStr = `<p><strong>Duration:</strong> ${durationMinutes} minutes ${durationSeconds} seconds</p>`;
      } else {
        durationStr = `<p><strong>Duration:</strong> ${durationSeconds} seconds</p>`;
      }
    }
    
    // Fetch HTML content from result_files
    let htmlContentFromFile = '';
    let htmlContentUrl = '';
    if (execution.result_files && execution.result_files.length > 0) {
      for (const file of execution.result_files) {
        if ((file.is_html || file.view_type === 'html') && file.url) {
          try {
            // Import fetch
            const fetch = require('node-fetch');
            const response = await fetch(file.url);
            
            if (response.ok) {
              const fetchedHtmlContent = await response.text();
              htmlContentFromFile = `
                <div class="html-result">
                  <h3>HTML Result File:</h3>
                  ${fetchedHtmlContent}
                </div>
              `;
              htmlContentUrl = file.url; // Capture the URL for email history
              console.log(`Successfully fetched HTML content from ${file.url}`);
              break; // Use the first HTML file found
            } else {
              console.error(`Failed to fetch HTML content from ${file.url}: ${response.statusText}`);
              htmlContentFromFile = `
                <div class="html-result">
                  <h3>HTML Result File:</h3>
                  <p><i>Error fetching HTML content: ${response.statusText}</i></p>
                </div>
              `;
            }
          } catch (error) {
            console.error(`Error fetching HTML content from ${file.url}:`, error);
            htmlContentFromFile = `
              <div class="html-result">
                <h3>HTML Result File:</h3>
                <p><i>Error fetching HTML content</i></p>
              </div>
            `;
          }
          break; // Process only the first HTML file found, even if error
        }
      }
    }
    

    
        // Create HTML content for the email - matching agent-engine send_task_results style
    const html = `
      <html>
      <head>
        <style>
          body { font-family: sans-serif; margin: 0; padding: 0; }
          .container { padding: 0; }
          .header { font-size: 1.5em; font-weight: bold; margin-bottom: 15px; }
          .details { margin-bottom: 20px; padding: 15px; border: 1px solid #eee; border-radius: 5px; }
          .details p { margin: 5px 0; }
          .section { margin-top: 20px; }
          .section h3 { font-size: 1.2em; margin-top: 0; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; }
          pre { white-space: pre-wrap; word-wrap: break-word; padding: 15px; border-radius: 5px; font-size: 0.9em; }
          .html-result { border: 1px solid #ddd; padding: 10px; margin-top: 15px; border-radius: 5px; }
          .footer { margin-top: 25px; font-size: 0.9em; padding: 20px; }
          a { text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">Task Run Results for "${task.name}"</div>
          <div class="details">
            <p><strong>Status:</strong> ${execution.status.toUpperCase()}</p>
            <p><strong>Started:</strong> ${startTime}</p>
            <p><strong>Completed:</strong> ${completedTime}</p>
            ${execution.llmName ? `<p><strong>LLM Used:</strong> ${execution.llmName}</p>` : ''}
            ${durationStr ? `<p><strong>Duration:</strong> ${durationStr.replace(/<\/?p>|<\/?strong>/g, '')}</p>` : ''}
          </div>
          
          ${execution.result ? `
          <div class="section">
            <h3>Results Summary:</h3>
            <pre>${emailService.escapeHtml(execution.result)}</pre>
          </div>
          ` : ''}
          
          ${execution.error ? `
          <div class="section">
            <h3>Error Details:</h3>
            <pre>${emailService.escapeHtml(execution.error)}</pre>
          </div>
          ` : ''}
          
          ${htmlContentFromFile ? `
          <div class="section">
            ${htmlContentFromFile}
          </div>
          ` : ''}
          
          <div class="footer">
            ${!task.sendHtmlReportOnly ? `<p>Manage task and history at: <a href="${customerFrontendUrl}/tasks/${task.taskId}">${customerFrontendUrl}/tasks/${task.taskId}</a></p>` : ''}
            ${htmlContentUrl && !task.emailFriendlyHtml ? `<p><small><strong>Note:</strong> Some visuals may not display properly in the email. <a href="${htmlContentUrl}">View full report here</a> for the complete experience.</small></p>` : ''}
            <hr>
            <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
            <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${task.taskId}&email=${encodeURIComponent(toEmail)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
          </div>
        </div>
      </body></html>
    `;

    const subject = `AgentWeb - Task Run Results: ${task.name}`;
    const text = `Task: ${task.name}\nStatus: ${execution.status.toUpperCase()}${!task.sendHtmlReportOnly ? `\nManage task and history at: ${customerFrontendUrl}/tasks/${task.taskId}` : ''}`;
    
    // Check if task has custom email sender configured
    let resendEmailId = null;
    let senderType: 'SMTP' | 'resend' = 'SMTP';
    
    // Determine email sender configuration with fallback to account-level
    let emailSender = task.emailSender;
    let fromName = task.fromName;
    
    // If task doesn't have custom email sender, use account-level configuration
    if (!emailSender || !fromName) {
      if (user.emailDomain && user.defaultSenderUsername && user.fromName) {
        emailSender = `${user.defaultSenderUsername}@${user.emailDomain}`;
        fromName = user.fromName;
      }
    }
    
    if (emailSender && fromName) {
      // Use Resend service for custom email sender (task-level or account-level)
      const from = `${fromName} <${emailSender}>`;
      const resendResult = await resendService.sendEmail({
        from,
        to: toEmail,
        subject,
        html,
        text
      });
      resendEmailId = resendResult?.id || null;
      senderType = 'resend';
      console.log(`Task execution email sent via Resend to: ${toEmail} from: ${from}`, resendEmailId ? `(ID: ${resendEmailId})` : '');
    } else {
      // Use default SMTP service
      await this.sendEmail(toEmail, subject, text, html);
      senderType = 'SMTP';
      console.log(`Task execution email sent via SMTP to: ${toEmail}`);
    }
    
    // Add email history to subscriber
    try {
      const sentAt = new Date().toISOString();
      await subscriberDb.addEmailHistory(execution.taskId, toEmail, {
        sentAt: sentAt,
        subject: subject,
        status: 'sent',
        taskExecutionId: executionId,
        htmlContentUrl: htmlContentUrl,
        senderType: senderType,
        emailId: resendEmailId || undefined
      });
      console.log(`Added email history for subscriber: ${toEmail}`, resendEmailId ? `(Resend ID: ${resendEmailId})` : '(SMTP)');
    } catch (historyError) {
      console.error(`Failed to add email history for ${toEmail}:`, historyError);
      // Don't throw error, email was sent successfully
    }
    
    } catch (error) {
      console.error(`Error sending task execution email to ${toEmail}:`, error);
      throw error;
    }
  },

  async sendScheduledChatResultEmail(
    toEmail: string,
    scheduleName: string,
    result: {
      passed: boolean;
      actualResponse: string;
      keywordMatches: string[];
      keywordMisses: string[];
      functionCallMatches: string[];
      functionCallMisses: string[];
      executionTime: number;
      sessionId: string;
      attempt: number;
      createdAt: string;
    },
    scheduleId: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const sessionUrl = `${customerFrontendUrl}/agent-mode/${result.sessionId}`;
      
      const statusColor = result.passed ? '#28a745' : '#dc3545';
      const statusText = result.passed ? 'PASSED' : 'FAILED';
      const statusIcon = result.passed ? '✅' : '❌';
      
      const currentDate = new Date().toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #1976d2; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .status { display: inline-block; padding: 8px 16px; border-radius: 4px; font-weight: bold; margin: 10px 0; }
            .status.passed { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .status.failed { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            .section { margin: 20px 0; padding: 15px; border: 1px solid #e9ecef; border-radius: 4px; }
            .section h3 { margin-top: 0; color: #495057; border-bottom: 2px solid #e9ecef; padding-bottom: 8px; }
            .criteria { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 15px 0; }
            .criteria-item { padding: 10px; background-color: #f8f9fa; border-radius: 4px; }
            .criteria-item h4 { margin: 0 0 8px 0; color: #495057; }
            .matches { color: #28a745; font-weight: bold; }
            .misses { color: #dc3545; font-weight: bold; }
            .response { background-color: #f8f9fa; padding: 15px; border-radius: 4px; border-left: 4px solid #1976d2; white-space: pre-wrap; word-wrap: break-word; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
            .button:hover { background-color: #1565c0; }
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 15px 0; }
            .stat { text-align: center; padding: 10px; background-color: #f8f9fa; border-radius: 4px; }
            .stat-value { font-size: 24px; font-weight: bold; color: #1976d2; }
            .stat-label { font-size: 12px; color: #6c757d; text-transform: uppercase; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>${statusIcon} Scheduled Chat Results</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${scheduleName}</p>
            </div>
            
            <div class="content">
              <div class="section" style="background-color: ${result.passed ? '#e8f5e8' : '#ffeaea'}; border-left: 4px solid ${result.passed ? '#28a745' : '#dc3545'}; margin: 20px 0;">
                <p style="margin: 0; font-size: 16px; line-height: 1.5;">
                  Your scheduled chat <strong>"${scheduleName}"</strong> has been ${result.passed ? 'successfully executed' : 'executed but did not meet all criteria'} and results are ready. 
                  It ran for <strong>${Math.round(result.executionTime / 1000)} seconds</strong> 
                  and completed at <strong>${currentDate}</strong>.
                </p>
              </div>
              
              <div class="section">
                <h3>💬 AI Response</h3>
                <div class="response">${result.actualResponse}</div>
              </div>
              
              <div class="section">
                <h3>🔗 View Full Conversation</h3>
                <p>Click the button below to view the complete conversation in Agent Mode:</p>
                <a href="${sessionUrl}" class="button">Open in Agent Mode</a>
                <p style="margin-top: 10px; font-size: 14px; color: #6c757d;">
                  Or copy this link: <a href="${sessionUrl}">${sessionUrl}</a>
                </p>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                This is an automated email from your scheduled chat. 
                <a href="${customerFrontendUrl}/agent-mode" style="color: #1976d2;">Manage your schedules</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Scheduled Chat Results: ${scheduleName}

Your scheduled chat "${scheduleName}" has been ${result.passed ? 'successfully executed' : 'executed but did not meet all criteria'} and results are ready.
It ran for ${Math.round(result.executionTime / 1000)} seconds and completed at ${currentDate}.

AI Response:
${result.actualResponse}

View full conversation: ${sessionUrl}

---
This is an automated email from your scheduled chat.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `${statusIcon} Scheduled Chat: ${scheduleName} - ${statusText}`;
      
      await this.sendEmail(toEmail, subject, text, html);
      console.log(`Scheduled chat result email sent to: ${toEmail}`);
      
    } catch (error) {
      console.error(`Error sending scheduled chat result email to ${toEmail}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  }
}; 