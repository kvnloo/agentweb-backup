import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

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
      throw error;
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
      const { taskDb } = require('../services/db');
      
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

      // If sendHtmlReportOnly is enabled, try to find HTML content and send only that
      if (task.sendHtmlReportOnly) {
        if (!execution.result_files || execution.result_files.length === 0) {
          // No result files available, don't send email
          console.log(`sendHtmlReportOnly enabled but no result files available for task ${task.taskId}, skipping email to ${toEmail}`);
          return;
        }
        
        let htmlContentFromFile = '';
        
        // Look for HTML files in result_files
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
                    ${fetchedHtmlContent}
                  </div>
                `;
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
          const simplifiedHtml = `
            <html>
            <head>
              <style>
                body { font-family: sans-serif; margin: 0; padding: 0; }
                .container { padding: 20px; }
                .footer { margin-top: 25px; font-size: 0.9em; padding: 20px; }
                a { text-decoration: none; }
                a:hover { text-decoration: underline; }
              </style>
            </head>
            <body>
              <div class="container">
                ${htmlContentFromFile}
                <div class="footer">
                  <p>Manage task and history at: <a href="${customerFrontendUrl}/tasks/${task.taskId}">${customerFrontendUrl}/tasks/${task.taskId}</a></p>
                  <hr>
                  <p><small>This is an automated message from AgentWeb. You are receiving this email because you are subscribed to updates for this task.</small></p>
                  <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${task.taskId}&email=${encodeURIComponent(toEmail)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
                </div>
              </div>
            </body></html>
          `;

          const subject = `${task.name} - ${currentDate}`;
          const text = `Task Report: ${task.name}\n\nView the HTML report in the email body.\n\nManage task and history at: ${customerFrontendUrl}/tasks/${task.taskId}`;
          
          await this.sendEmail(toEmail, subject, text, simplifiedHtml);
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
            <p>Manage task and history at: <a href="${customerFrontendUrl}/tasks/${task.taskId}">${customerFrontendUrl}/tasks/${task.taskId}</a></p>
            <hr>
            <p><small>This is an automated message from AgentWeb. You are receiving this email because you are subscribed to updates for this task.</small></p>
            <p><small><a href="${customerFrontendUrl}/unsubscribe?taskId=${task.taskId}&email=${encodeURIComponent(toEmail)}" style="color: #e74c3c;">Unsubscribe from future updates</a></small></p>
          </div>
        </div>
      </body></html>
    `;

    const subject = `AgentWeb - Task Run Results: ${task.name}`;
    const text = `Task: ${task.name}\nStatus: ${execution.status.toUpperCase()}\nManage task and history at: ${customerFrontendUrl}/tasks/${task.taskId}`;
    
    await this.sendEmail(toEmail, subject, text, html);
    } catch (error) {
      console.error(`Error sending task execution email to ${toEmail}:`, error);
      throw error;
    }
  }
}; 