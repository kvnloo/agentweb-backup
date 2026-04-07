import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { resendService } from './resendService';
import { chatbotDb } from './chatbotService';
import { settingsService } from './settingsService';

dotenv.config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Env var ONCALL_EMAIL_LIST takes highest priority for oncall alerts.
async function getAlertEmails(settingKey: string, fallback: string[]): Promise<string[]> {
  if (settingKey === 'oncall_emails' && process.env.ONCALL_EMAIL_LIST) {
    return process.env.ONCALL_EMAIL_LIST.split(',').filter(Boolean);
  }
  return settingsService.getJsonArraySetting(settingKey, fallback);
}

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

  async sendEmail(to: string | string[], subject: string, text: string, html: string, cc?: string | string[]) {
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
      const toList = Array.isArray(to) ? to.join(', ') : to;
      const ccList = cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : '';
      console.log('Email sent successfully to:', toList, cc ? `CC: ${ccList}` : '');
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

  async sendWelcomeEmail(email: string, temporaryPassword?: string) {
    const isUpgrade = !temporaryPassword;
    
    const welcomeHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
          <p style="color: #666; margin: 5px 0;">Customer Portal</p>
        </div>
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1B2549; margin-top: 0;">Welcome to AgentWeb!</h2>
          <p style="color: #333; line-height: 1.6;">
            ${isUpgrade 
              ? 'Great news! Your account has been upgraded and you now have access to our premium features.'
              : 'Your account has been created successfully. You can now access the AgentWeb Customer Portal.'
            }
          </p>
          ${isUpgrade ? `
          <p style="color: #333; line-height: 1.6;">
            Since you already have an account, you can log in directly using your existing credentials.
          </p>
          ` : ''}
          
          ${temporaryPassword ? `
          <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
            <h3 style="color: #1B2549; margin-top: 0;">Your Login Credentials</h3>
            <p style="margin: 10px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 10px 0;"><strong>Temporary Password:</strong> <code style="background: #f0f0f0; padding: 2px 6px; border-radius: 3px;">${temporaryPassword}</code></p>
          </div>
          ` : ''}
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/login" 
               style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); 
                      color: white; 
                      padding: 12px 30px; 
                      text-decoration: none; 
                      border-radius: 6px; 
                      display: inline-block;
                      font-weight: bold;">
              Sign In Now
            </a>
          </div>
          
          ${isUpgrade ? `
                 <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
                   <h3 style="color: #1B2549; margin-top: 0;">What's New with Your Upgrade</h3>
                   <p style="margin: 10px 0; color: #333; line-height: 1.6;">
                     You now have access to our full suite of AI-powered marketing automation tools, including Emma AI Assistant, advanced content creation, Meta Ads integration, and comprehensive analytics. Transform your marketing workflow with intelligent automation and data-driven insights.
                   </p>
                 </div>
          ` : ''}
          
          <p style="color: #666; font-size: 14px; margin-top: 20px;">
            ${temporaryPassword 
              ? '<strong>Important:</strong> Please change your password after your first login for security reasons.'
              : ''
            }
          </p>
          
          <div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
            <h3 style="color: #1B2549; margin-top: 0;">Getting Started with AgentWeb</h3>
            <p style="margin: 10px 0; color: #333; line-height: 1.6;">Check out these resources to help you get the most out of AgentWeb:</p>
            <ul style="margin: 10px 0; padding-left: 20px; color: #333;">
              <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/changelog" style="color: #643B7E; text-decoration: none;">Release Notes</a> - Learn about our latest features and updates</li>
              <li><a href="${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/guide" style="color: #643B7E; text-decoration: none;">User Guide</a> - Detailed instructions on how to create and manage your web automation tasks</li>
            </ul>
          </div>
        </div>
        
        <div style="text-align: center; color: #666; font-size: 12px;">
          <p>If you have any questions, please contact our support team.</p>
        </div>
      </div>
    `;

    const welcomeText = `
AgentWeb Customer Portal - Welcome!

${isUpgrade 
  ? 'Great news! Your account has been upgraded and you now have access to our premium features.\n\nSince you already have an account, you can log in directly using your existing credentials.'
  : 'Your account has been created successfully. You can now access the AgentWeb Customer Portal.'
}

${temporaryPassword ? `
Your Login Credentials:
Email: ${email}
Temporary Password: ${temporaryPassword}
` : ''}

Sign in at: ${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/login

${isUpgrade ? `
What's New with Your Upgrade:
You now have access to our full suite of AI-powered marketing automation tools, including Emma AI Assistant, advanced content creation, Meta Ads integration, and comprehensive analytics. Transform your marketing workflow with intelligent automation and data-driven insights.
` : ''}

${temporaryPassword 
  ? 'Important: Please change your password after your first login for security reasons.'
  : ''
}

Getting Started with AgentWeb:
Check out these resources to help you get the most out of AgentWeb:
- Release Notes: ${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/changelog - Learn about our latest features and updates
- User Guide: ${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/guide - Detailed instructions on how to create and manage your web automation tasks

If you have any questions, please contact our support team.

Best regards,
The AgentWeb Team
    `;

    try {
      await this.sendEmail(
        email,
        isUpgrade ? 'Welcome to AgentWeb - Your Account is Upgraded!' : 'Welcome to AgentWeb - Your Account is Ready!',
        welcomeText,
        welcomeHtml
      );
      console.log(`Welcome email sent successfully to: ${email}`);
    } catch (error) {
      console.error("Error sending welcome email:", error);
      throw error;
    }
  },

  async sendSubscriberWelcomeEmail(email: string, taskId: string) {
    try {
      // Import required services
      const { taskDb, userDb } = require('../services/db');
      
      // Get environment variables
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      
      // Fetch task data
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // Fetch user data for account-level email configuration
      const user = await userDb.getUserById(task.userId);
      if (!user) {
        throw new Error(`User not found: ${task.userId}`);
      }

      const taskName = task.name || 'this task';
      
      const welcomeHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Thank you for subscribing!</h2>
            <p style="color: #333; line-height: 1.6;">
              You've successfully subscribed to updates for <strong>${this.escapeHtml(taskName)}</strong>.
            </p>
            <p style="color: #333; line-height: 1.6;">
              You'll now receive updates and notifications about this topic. We'll keep you informed about important developments.
            </p>
          </div>
          
          <div class="footer" style="margin-top: 25px; font-size: 0.9em; padding: 20px;">
            <hr>
            <p><small>You're receiving this automated email because you're subscribed to the email updates</small></p>
            <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${taskId}&email=${encodeURIComponent(email)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
          </div>
        </div>
      `;

      const welcomeText = `Thank you for subscribing!

You've successfully subscribed to updates for ${taskName}.

You'll now receive updates and notifications about this topic. We'll keep you informed about important developments.

You're receiving this automated email because you're subscribed to the email updates.

Unsubscribe from future updates: ${customerFrontendUrl}/unsubscribe?taskId=${taskId}&email=${encodeURIComponent(email)}`;

      const subject = `Welcome! You've subscribed to ${taskName}`;
      
      // Determine email sender configuration with fallback to account-level (same as sendTaskExecutionEmail)
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
          to: email,
          subject,
          html: welcomeHtml,
          text: welcomeText
        });
        console.log(`Subscriber welcome email sent via Resend to: ${email} from: ${from}`, resendResult?.id ? `(ID: ${resendResult.id})` : '');
      } else {
        // Use default SMTP service
        await this.sendEmail(email, subject, welcomeText, welcomeHtml);
        console.log(`Subscriber welcome email sent via SMTP to: ${email}`);
      }
    } catch (error) {
      console.error("Error sending subscriber welcome email:", error);
      // Don't throw - just log the error so subscription still succeeds
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

  async sendScheduledChatErrorEmail(
    toEmails: string | string[],
    scheduleName: string,
    disallowedFunctions: string[],
    scheduleId: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      
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
            .header { background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 20px; }
            .error-section { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
            .error-section h3 { margin-top: 0; color: #856404; }
            .function-list { background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; }
            .function-list ul { margin: 0; padding-left: 20px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
            .button:hover { background-color: #1565c0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>❌ Scheduled Chat Error</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">${scheduleName}</p>
            </div>
            
            <div class="content">
              <div class="error-section">
                <h3>⚠️ Scheduled Chat Cannot Run</h3>
                <p style="margin: 0; line-height: 1.6;">
                  Your scheduled chat <strong>"${scheduleName}"</strong> was scheduled to run at <strong>${currentDate}</strong>, 
                  but it cannot execute because the following required function calls are not allowed by your subscription:
                </p>
                <div class="function-list">
                  <ul>
                    ${disallowedFunctions.map(func => `<li><strong>${func}</strong></li>`).join('')}
                  </ul>
                </div>
                <p style="margin: 10px 0 0 0; line-height: 1.6;">
                  Please contact your administrator to update your subscription type or modify the scheduled chat 
                  to only use function calls that are allowed by your current subscription.
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
Scheduled Chat Error: ${scheduleName}

Your scheduled chat "${scheduleName}" was scheduled to run at ${currentDate}, but it cannot execute because the following required function calls are not allowed by your subscription:

${disallowedFunctions.map(func => `- ${func}`).join('\n')}

Please contact your administrator to update your subscription type or modify the scheduled chat to only use function calls that are allowed by your current subscription.

---
This is an automated email from your scheduled chat.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `❌ Scheduled Chat Error: ${scheduleName} - Function Calls Not Allowed`;
      
      // Normalize to array for consistent handling
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      
      // Send ONE email to all recipients
      await this.sendEmail(emailList, subject, text, html);
      
      console.log(`Scheduled chat error email sent to recipients: ${emailList.join(', ')}`);
      
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat error emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  async sendScheduledChatVariableRequestEmail(
    toEmails: string | string[],
    scheduleName: string,
    scheduleId: string,
    variables: Array<{ name: string; description?: string }>,
    variableInputUrl?: string,
    expiresAt?: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const manageUrl = `${customerFrontendUrl}/agent-mode`;
      const inputUrl = variableInputUrl || manageUrl;
      const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      const expirationDate = expiresAt
        ? new Date(expiresAt).toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
          })
        : null;

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 760px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
            .header { background-color: #1976d2; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { padding: 20px; }
            .var-list { margin: 12px 0 0 0; padding-left: 18px; }
            .var-list li { margin: 8px 0; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 10px 18px; text-decoration: none; border-radius: 4px; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2 style="margin: 0;">Variable Values Required</h2>
              <p style="margin: 6px 0 0 0; opacity: 0.92;">${scheduleName}</p>
            </div>
            <div class="content">
              <p>
                A scheduled chat run was due at <strong>${currentDate}</strong>, but it is waiting for variable values.
              </p>
              <p>Please provide values for:</p>
              <ul class="var-list">
                ${variables.map(variable => `<li><strong>{{${variable.name}}}</strong>${variable.description ? ` - ${variable.description}` : ''}</li>`).join('')}
              </ul>
              ${expirationDate ? `<p><strong>This request expires at ${expirationDate}.</strong></p>` : ''}
              <p>After values are provided, the scheduled run will start automatically.</p>
              <a href="${inputUrl}" class="button">Provide Variable Values</a>
              <p style="margin-top: 12px; font-size: 12px; color: #6c757d;">
                This link can only be used once and cannot be used after it expires.
              </p>
            </div>
            <div class="footer">
              <p style="margin: 0; color: #6c757d; font-size: 12px;">
                Schedule ID: ${scheduleId}
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Scheduled Chat Waiting For Variables: ${scheduleName}

A scheduled chat run was due at ${currentDate}, but it is waiting for variable values.

Please provide values for:
${variables.map(variable => `- {{${variable.name}}}${variable.description ? `: ${variable.description}` : ''}`).join('\n')}

${expirationDate ? `This request expires at ${expirationDate}.\n` : ''}

After values are provided, the scheduled run will start automatically.

Provide variable values: ${inputUrl}
This link can only be used once and cannot be used after it expires.

Manage scheduled chats: ${manageUrl}
Schedule ID: ${scheduleId}
      `;

      const subject = `🟡 Scheduled Chat Waiting for Variables: ${scheduleName}`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Scheduled chat variable request email sent to recipients: ${emailList.join(', ')}`);
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat variable request emails to ${emailList.join(', ')}:`, error);
    }
  },

  async sendScheduledChatResultEmail(
    toEmails: string | string[],
    scheduleName: string,
    result: {
      passed: boolean;
      actualResponse: string;
      keywordMatches: string[];
      keywordMisses: string[];
      functionCallMatches: string[];
      functionCallMisses: string[];
      functionCallDetails?: { [functionName: string]: { actual: number; required: number } };
      executionTime: number;
      sessionId: string;
      attempt: number;
      createdAt: string;
    },
    scheduleId: string,
    summary?: string
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      
      // Create an interactive share for the session so user can access without login
      let sessionUrl = `${customerFrontendUrl}/agent-mode/${result.sessionId}`;
      try {
        // Use the common function to create or reuse interactive share
        sessionUrl = await chatbotDb.createOrReuseInteractiveShare(result.sessionId);
        
        console.log(`Created or reused interactive share for scheduled chat session ${result.sessionId}`);
      } catch (shareError) {
        console.error('Error creating interactive share for scheduled chat:', shareError);
        // Fall back to regular agent-mode URL if share creation fails
      }
      
      const statusColor = result.passed ? '#28a745' : '#dc3545';
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
              
              ${result.functionCallDetails && Object.keys(result.functionCallDetails).length > 0 ? `
              <div class="section">
                <h3>🔧 Function Call Details</h3>
                <div class="criteria">
                  ${Object.entries(result.functionCallDetails).map(([funcName, details]) => `
                    <div class="criteria-item">
                      <h4>${funcName}</h4>
                      <p>
                        <span class="${details.actual >= details.required ? 'matches' : 'misses'}">
                          ${details.actual}/${details.required} calls
                        </span>
                        ${details.actual >= details.required ? '✅' : '❌'}
                      </p>
                    </div>
                  `).join('')}
                </div>
              </div>
              ` : ''}
              
              <div class="section">
                <h3>💬 AI Response</h3>
                <div class="response">${result.actualResponse}</div>
              </div>
              
              <div class="section">
                <h3>🔗 Continue the Conversation</h3>
                <p>Click the button below to view the complete conversation and continue chatting with the AI.</p>
                <a href="${sessionUrl}" class="button">Continue Chatting</a>
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

${result.functionCallDetails && Object.keys(result.functionCallDetails).length > 0 ? `
Function Call Details:
${Object.entries(result.functionCallDetails).map(([funcName, details]) => 
  `- ${funcName}: ${details.actual}/${details.required} calls ${details.actual >= details.required ? '✅' : '❌'}`
).join('\n')}

` : ''}AI Response:
${result.actualResponse}

Continue the conversation: ${sessionUrl}

---
This is an automated email from your scheduled chat.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `${statusIcon} Scheduled Chat: ${scheduleName}${summary ? ` — ${summary}` : ''}`;
      
      // Normalize to array for consistent handling
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      
      // Send ONE email to all recipients
      await this.sendEmail(emailList, subject, text, html);
      
      console.log(`Scheduled chat result email sent to recipients: ${emailList.join(', ')}`);
      
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending scheduled chat result emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  async sendDailyDigestEmail(
    toEmails: string | string[],
    scheduleName: string,
    todaysResults: any[],
    scheduleId: string,
    customDate?: Date
  ) {
    try {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      
      const displayDate = customDate || new Date();
      const currentDate = displayDate.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric'
      });
      
      // Determine if this is for today or a different date
      const isToday = !customDate || displayDate.toDateString() === new Date().toDateString();
      const dateLabel = isToday ? "Today's Summary" : `${currentDate} Summary`;

      // Calculate summary statistics
      const totalRuns = todaysResults.length;
      const successfulRuns = todaysResults.filter(result => result.passed).length;
      const failedRuns = totalRuns - successfulRuns;
      const averageExecutionTime = Math.round(
        todaysResults.reduce((sum, result) => sum + result.executionTime, 0) / totalRuns / 1000
      );

      // Create interactive shares for all sessions
      const sessionUrls: { [sessionId: string]: string } = {};
      for (const result of todaysResults) {
        if (result.sessionId) {
          try {
            // Use the common function to create or reuse interactive share
            sessionUrls[result.sessionId] = await chatbotDb.createOrReuseInteractiveShare(result.sessionId);
          } catch (shareError) {
            console.error('Error creating interactive share for daily digest:', shareError);
            // Fall back to regular agent-mode URL if share creation fails
            sessionUrls[result.sessionId] = `${customerFrontendUrl}/agent-mode/${result.sessionId}`;
          }
        }
      }

      // Generate results HTML
      const resultsHtml = todaysResults.map((result, index) => {
        const statusIcon = result.passed ? '✅' : '❌';
        const statusColor = result.passed ? '#28a745' : '#dc3545';
        const runTime = new Date(result.createdAt).toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        const sessionUrl = result.sessionId ? sessionUrls[result.sessionId] : '#';
        
        return `
          <div class="result-item" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin: 10px 0; background-color: ${result.passed ? '#f8fff8' : '#fff8f8'};">
            <div class="result-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <div class="result-info">
                <span class="status-badge" style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background-color: ${statusColor}; color: white;">
                  ${statusIcon} ${result.passed ? 'PASSED' : 'FAILED'}
                </span>
                <span style="margin-left: 15px; color: #6c757d; font-size: 14px;">Run ${index + 1} at ${runTime}</span>
              </div>
              <div class="result-stats" style="font-size: 12px; color: #6c757d; text-align: right; min-width: 120px;">
                <div style="margin-bottom: 2px;">${Math.round(result.executionTime / 1000)}s</div>
                <div>Attempt ${result.attempt || 1}</div>
              </div>
            </div>
            <div class="result-content">
              <div class="response-preview" style="background-color: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; font-size: 14px; line-height: 1.4; max-height: 100px; overflow: hidden; position: relative;">
                ${this.escapeHtml(result.actualResponse.length > 200 ? result.actualResponse.substring(0, 200) + '...' : result.actualResponse)}
              </div>
              ${result.sessionId ? `
                <a href="${sessionUrl}" class="view-conversation-btn" style="display: inline-block; background-color: #1976d2; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-size: 12px; margin-top: 8px;">
                  View Full Conversation
                </a>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 900px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #1976d2, #1565c0); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; font-weight: 300; }
            .header p { margin: 10px 0 0 0; opacity: 0.9; font-size: 16px; }
            .content { padding: 30px; }
            .summary { background: linear-gradient(135deg, #f8f9fa, #e9ecef); padding: 20px; border-radius: 8px; margin: 20px 0; }
            .summary h2 { margin: 0 0 15px 0; color: #495057; font-size: 20px; }
            .stats-container { display: table; width: 100%; padding: 20px 0; margin: 15px 0; }
            .stat-item { display: table-cell; text-align: center; width: 25%; vertical-align: middle; }
            .stat-value { font-size: 28px; font-weight: bold; color: #1976d2; margin-bottom: 5px; }
            .stat-label { font-size: 13px; color: #6c757d; font-weight: 500; }
            .results-section { margin: 30px 0; }
            .results-section h2 { color: #495057; border-bottom: 2px solid #e9ecef; padding-bottom: 10px; margin-bottom: 20px; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin: 10px 0; font-weight: 500; }
            .button:hover { background-color: #1565c0; }
            .view-conversation-btn:hover { background-color: #1565c0 !important; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📊 Daily Digest</h1>
              <p>${scheduleName} - ${currentDate}</p>
            </div>
            
            <div class="content">
              <div class="summary">
                <h2>📈 ${dateLabel}</h2>
                <p style="margin: 0 0 15px 0; color: #6c757d; font-size: 16px;">
                  Your scheduled chat ran <strong>${totalRuns} times</strong> on <strong>${currentDate}</strong> with a <strong>${Math.round((successfulRuns / totalRuns) * 100)}%</strong> success rate.
                </p>
                <div class="stats-container">
                  <div class="stat-item">
                    <div class="stat-value">${totalRuns}</div>
                    <div class="stat-label">Total Runs</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value" style="color: #28a745;">${successfulRuns}</div>
                    <div class="stat-label">Successful</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value" style="color: #dc3545;">${failedRuns}</div>
                    <div class="stat-label">Failed</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value">${averageExecutionTime}s</div>
                    <div class="stat-label">Avg Runtime</div>
                  </div>
                </div>
              </div>
              
              <div class="results-section">
                <h2>🔍 Individual Run Results</h2>
                <p style="color: #6c757d; margin-bottom: 20px;">
                  Click on any "View Full Conversation" button to continue chatting with the AI about that specific run.
                </p>
                ${resultsHtml}
              </div>
            </div>
            
            <div class="footer">
              <p style="margin-top: 15px; font-size: 12px; color: #6c757d;">
                This is your daily digest for scheduled chat "${scheduleName}". 
                <a href="${customerFrontendUrl}/agent-mode" style="color: #1976d2;">Manage your schedules</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `
Daily Digest: ${scheduleName} - ${currentDate}

${dateLabel}:
- Total Runs: ${totalRuns}
- Successful: ${successfulRuns}
- Failed: ${failedRuns}
- Average Runtime: ${averageExecutionTime} seconds
- Success Rate: ${Math.round((successfulRuns / totalRuns) * 100)}%

Individual Run Results:
${todaysResults.map((result, index) => {
  const runTime = new Date(result.createdAt).toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  const sessionUrl = result.sessionId ? sessionUrls[result.sessionId] : 'N/A';
  return `
Run ${index + 1} at ${runTime} - ${result.passed ? 'PASSED' : 'FAILED'}
Response: ${result.actualResponse.substring(0, 100)}${result.actualResponse.length > 100 ? '...' : ''}
View Conversation: ${sessionUrl}
`;
}).join('\n')}

---
This is your daily digest for scheduled chat "${scheduleName}" for ${currentDate}.
Manage your schedules: ${customerFrontendUrl}/agent-mode
      `;

      const subject = `📊 Daily Digest: ${scheduleName} - ${currentDate} - ${totalRuns} runs (${Math.round((successfulRuns / totalRuns) * 100)}% success)`;
      
      // Normalize to array for consistent handling
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      
      // Send ONE email to all recipients
      await this.sendEmail(emailList, subject, text, html);
      
      console.log(`Daily digest email sent to recipients: ${emailList.join(', ')}`);
      
    } catch (error) {
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      console.error(`Error sending daily digest emails to ${emailList.join(', ')}:`, error);
      // Don't throw error - email failure shouldn't break the scheduled chat execution
    }
  },

  async sendSlackTriggeredSessionEmail(
    toEmails: string | string[],
    params: {
      sessionId: string;
      userEmail: string;
      channelName: string;
      originalMessage: string;
      emmaResponse: string;
      receivedAt: string;
    }
  ) {
    try {
      const { sessionId, userEmail, channelName, originalMessage, emmaResponse, receivedAt } = params;
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

      let sessionUrl = `${customerFrontendUrl}/agent-mode/${sessionId}`;
      try {
        const { chatbotDb } = await import('./chatbotService');
        sessionUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);
      } catch (shareError) {
        console.error('Error creating interactive share for slack triggered session:', shareError);
      }

      const formattedDate = new Date(receivedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const html = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
            .container { max-width: 800px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #611f69; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; }
            .header p { margin: 5px 0 0 0; opacity: 0.9; font-size: 14px; }
            .content { padding: 20px; }
            .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
            .meta-item { padding: 10px 15px; background-color: #f8f9fa; border-radius: 6px; border-left: 3px solid #611f69; }
            .meta-item .label { font-size: 11px; text-transform: uppercase; color: #6c757d; margin-bottom: 4px; }
            .meta-item .value { font-size: 14px; color: #212529; font-weight: 500; }
            .section { margin: 20px 0; }
            .section-title { font-size: 14px; font-weight: bold; text-transform: uppercase; color: #6c757d; margin-bottom: 8px; letter-spacing: 0.5px; }
            .message-box { background-color: #f8f9fa; padding: 15px; border-radius: 6px; border-left: 4px solid #611f69; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.6; }
            .response-box { background-color: #f0f7ff; padding: 15px; border-radius: 6px; border-left: 4px solid #1976d2; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.6; }
            .footer { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; border-top: 1px solid #e9ecef; }
            .button { display: inline-block; background-color: #1976d2; color: white !important; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>💬 New Client Question from Slack</h1>
              <p>Emma has prepared a draft response for your review</p>
            </div>
            <div class="content">
              <div class="meta">
                <div class="meta-item">
                  <div class="label">Client Account</div>
                  <div class="value">${this.escapeHtml(userEmail)}</div>
                </div>
                <div class="meta-item">
                  <div class="label">Slack Channel</div>
                  <div class="value">#${this.escapeHtml(channelName)}</div>
                </div>
                <div class="meta-item">
                  <div class="label">Received At</div>
                  <div class="value">${formattedDate}</div>
                </div>
              </div>

              <div class="section">
                <div class="section-title">Original Message</div>
                <div class="message-box">${this.escapeHtml(originalMessage)}</div>
              </div>

              <div class="section">
                <div class="section-title">Emma's Draft Response</div>
                <div class="response-box">${this.escapeHtml(emmaResponse)}</div>
              </div>
            </div>
            <div class="footer">
              <a href="${sessionUrl}" class="button">View Full Session</a>
              <p style="margin: 15px 0 0 0; color: #6c757d; font-size: 12px;">
                Open the session to review the conversation, edit Emma's response, or continue the chat.
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      const text = `New Client Question from Slack

Client: ${userEmail}
Channel: #${channelName}
Received: ${formattedDate}

Original Message:
${originalMessage}

Emma's Draft Response:
${emmaResponse}

View Session: ${sessionUrl}`;

      const subject = `💬 Client question from #${channelName} (${userEmail})`;
      const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
      await this.sendEmail(emailList, subject, text, html);
      console.log(`Slack triggered session email sent to: ${emailList.join(', ')} for session ${sessionId}`);
    } catch (error) {
      console.error('Error sending slack triggered session email:', error);
      // Non-blocking: email failure should not interrupt the session flow
    }
  },

  async sendOncallAlert(
    subject: string,
    message: string,
    context?: Record<string, any>,
    notionUrl?: string
  ) {
    try {
      const oncallEmails = await getAlertEmails('oncall_emails', ['ruiw@agentweb.pro']);
      const env = process.env.NODE_ENV || 'unknown';
      const envLabel = env === 'production' ? 'PROD' : env.toUpperCase();

      // Attempt to create a Notion oncall item if no URL was provided
      let resolvedNotionUrl = notionUrl || null;
      if (!resolvedNotionUrl) {
        try {
          const { createOncallItem } = await import('./notionService');
          const result = await createOncallItem({
            title: subject,
            description: message,
            context,
          });
          resolvedNotionUrl = result.notionUrl;
          console.log(`Oncall Notion item created: ${resolvedNotionUrl}`);
        } catch (notionError) {
          console.error('Failed to create Notion oncall item, falling back to full email:', notionError);
        }
      }

      let html: string;
      let text: string;

      if (resolvedNotionUrl) {
        // Slim email with Notion link
        html = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
          <div style="background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">⚠️ [${envLabel}] Oncall Alert</h1>
          </div>
          <div style="background-color: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #dc3545; margin-top: 0;">${this.escapeHtml(subject)}</h2>
            <div style="margin: 20px 0;">
              <a href="${this.escapeHtml(resolvedNotionUrl)}" style="display: inline-block; padding: 12px 24px; background-color: #dc3545; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">View in Notion</a>
            </div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 12px;">
              <p>Full details available in the Notion item above.</p>
            </div>
          </div>
        </div>
        `;

        text = `⚠️ [${envLabel}] Oncall Alert\n\n${subject}\n\nNotion: ${resolvedNotionUrl}`;
      } else {
        // Full detail email (fallback when Notion creation failed)
        const contextHtml = context
          ? Object.entries(context)
              .map(([key, value]) => {
                const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                return `<tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background-color: #f8f9fa;">${this.escapeHtml(key)}</td><td style="padding: 8px; border: 1px solid #ddd; white-space: pre-wrap; word-wrap: break-word;">${this.escapeHtml(displayValue)}</td></tr>`;
              })
              .join('')
          : '';

        html = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
          <div style="background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">⚠️ [${envLabel}] Oncall Alert</h1>
          </div>
          <div style="background-color: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #dc3545; margin-top: 0;">${this.escapeHtml(subject)}</h2>
            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${this.escapeHtml(message)}</p>
            </div>
            ${contextHtml ? `
            <h3 style="color: #495057; margin-top: 30px;">Additional Context:</h3>
            <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
              ${contextHtml}
            </table>
            ` : ''}
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 12px;">
              <p>This is an automated alert that requires immediate attention.</p>
            </div>
          </div>
        </div>
        `;

        text = `
⚠️ [${envLabel}] Oncall Alert

${subject}

${message}

${context ? Object.entries(context).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`).join('\n') : ''}
        `.trim();
      }

      await this.sendEmail(oncallEmails, `[${envLabel}] ${subject}`, text, html);
      console.log(`Oncall alert sent to: ${oncallEmails.join(', ')}`);
    } catch (error) {
      console.error('Error sending oncall alert:', error);
      // Don't throw - alert failure shouldn't break the main flow
    }
  }
}; 
