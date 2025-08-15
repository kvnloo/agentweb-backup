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
      const siteDomain = process.env.FRONTEND_URL || 'https://agentweb.pro';
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'https://agentweb.pro';
      const landingSiteUrl = process.env.LANDING_SITE_URL || 'https://agentweb.pro';
      
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
    
    const taskUrl = `${siteDomain}/tasks/${task.taskId}`;
    const executionUrl = `${customerFrontendUrl}/tasks/${task.taskId}/executions/${execution.executionId}/result`;
    
    // Create HTML content for the email
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              margin: 0;
              padding: 0;
              background-color: #fff;
            }
            .container {
              padding: 20px;
              background-color: #fdfdfd;
            }
            .header {
              background-color: #1976d2;
              color: white;
              padding: 20px;
              text-align: center;
              border-radius: 4px 4px 0 0;
            }
            .content {
              padding: 20px;
              background: #fff;
              border: 1px solid #ddd;
              border-radius: 0 0 4px 4px;
            }
            .section {
              margin-bottom: 20px;
              padding-bottom: 20px;
              border-bottom: 1px solid #eee;
            }
            .section:last-child {
              border-bottom: none;
            }
            .section h3 {
              margin-top: 0;
              color: #1976d2;
              border-bottom: 2px solid #ecf0f1;
              padding-bottom: 8px;
            }
            .details-table {
              width: 100%;
              border-collapse: collapse;
              margin-bottom: 20px;
            }
            .details-table th, .details-table td {
              padding: 8px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            .details-table th {
              background-color: #f5f5f5;
            }
            .status {
              padding: 4px 8px;
              border-radius: 4px;
              font-weight: bold;
              display: inline-block;
            }
            .status-completed {
              background-color: #e8f5e9;
              color: #2e7d32;
            }
            .status-failed {
              background-color: #ffebee;
              color: #c62828;
            }
            .status-running {
              background-color: #e3f2fd;
              color: #1565c0;
            }
            .status-pending {
              background-color: #fff8e1;
              color: #f57f17;
            }
            .pre-content {
              background-color: #f5f5f5;
              padding: 15px;
              border-radius: 4px;
              overflow-x: auto;
              white-space: pre-wrap;
              word-break: break-word;
              font-family: monospace;
              font-size: 0.9em;
            }
            .html-result {
              border: 1px solid #ddd;
              padding: 10px;
              margin-top: 15px;
              border-radius: 5px;
              overflow: auto;
            }
            .html-result h3 {
              margin-top: 0;
              font-size: 1.2em;
              border-bottom: 2px solid #ecf0f1;
              padding-bottom: 8px;
              color: #34495e;
            }
            .footer {
              text-align: center;
              margin-top: 20px;
              color: #666;
              font-size: 0.9em;
            }
            .button {
              display: inline-block;
              padding: 10px 20px;
              background-color: #1976d2;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2 style="margin:0;padding:0;font-size:24px;">Task Run Results: ${task.name}</h2>
            </div>
            <div class="content">
              <div class="section">
                <h3>Task Information</h3>
                <table class="details-table">
                  <tr>
                    <th>Task Name</th>
                    <td>${task.name}</td>
                  </tr>
                  <tr>
                    <th>Task ID</th>
                    <td>${task.taskId}</td>
                  </tr>
                  <tr>
                    <th>Execution ID</th>
                    <td>${execution.executionId}</td>
                  </tr>
                  <tr>
                    <th>Status</th>
                    <td>
                      <span class="status status-${execution.status.toLowerCase()}">${execution.status.toUpperCase()}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>Started</th>
                    <td>${startTime}</td>
                  </tr>
                  <tr>
                    <th>Completed</th>
                    <td>${completedTime}</td>
                  </tr>
                  ${execution.llmName ? `
                  <tr>
                    <th>LLM Used</th>
                    <td>${execution.llmName}</td>
                  </tr>` : ''}
                  ${durationStr ? `
                  <tr>
                    <th>Duration</th>
                    <td>${durationStr.replace(/<\/?p>|<\/?strong>/g, '')}</td>
                  </tr>` : ''}
                </table>
              </div>
              
              ${execution.result ? `
              <div class="section">
                <h3>Results Summary</h3>
                <div class="pre-content">${execution.result}</div>
              </div>
              ` : ''}
              
              ${execution.error ? `
              <div class="section">
                <h3>Error Details</h3>
                <div class="pre-content" style="color:#c62828">${execution.error}</div>
              </div>
              ` : ''}
              
              ${htmlContentFromFile ? `
              <div class="section">
                ${htmlContentFromFile}
              </div>
              ` : ''}
              
              <div class="section" style="text-align: center;">
                <a href="${executionUrl}" class="button">View Full Details</a>
              </div>
            </div>
            <div class="footer">
              <p>This email was sent from AgentWeb. You can reply directly to this email if you have any questions.</p>
              <p>View <a href="${customerFrontendUrl}/tasks/${task.taskId}">task details</a> or go to <a href="${landingSiteUrl}">AgentWeb</a>.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const subject = `AgentWeb - Task Run Results: ${task.name}`;
    const text = `Task: ${task.name}\nStatus: ${execution.status.toUpperCase()}\nView details: ${executionUrl}`;
    
    await this.sendEmail(toEmail, subject, text, html);
    } catch (error) {
      console.error(`Error sending task execution email to ${toEmail}:`, error);
      throw error;
    }
  }
}; 