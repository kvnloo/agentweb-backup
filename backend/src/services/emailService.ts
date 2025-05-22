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
  }
}; 