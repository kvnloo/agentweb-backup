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
  async sendEmail(to: string, subject: string, text: string, html: string) {
    const mailOptions = {
      from: process.env.FROM_EMAIL || 'AgentWeb team',
      to,
      subject,
      text,
      html
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log('Email sent successfully to:', to);
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  },

  async sendInvitation(email: string) {
    const mailOptions = {
      from: process.env.FROM_EMAIL || 'AgentWeb team',
      to: email,
      subject: 'Welcome to AgentWeb - Your Invitation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to AgentWeb!</h2>
          <p>We're excited to have you join our platform. Your waitlist application has been approved!</p>
          <p>To get started, please click the button below to create your account:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/register?email=${encodeURIComponent(email)}" 
               style="background-color: #1976d2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
              Create Your Account
            </a>
          </div>
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p>${process.env.FRONTEND_URL}/register?email=${encodeURIComponent(email)}</p>
          
          <h3>Getting Started with AgentWeb</h3>
          <p>Check out these resources to help you get the most out of AgentWeb:</p>
          <ul>
            <li><a href="${process.env.FRONTEND_URL}/release">Release Notes</a> - Learn about our latest features and updates</li>
            <li><a href="${process.env.FRONTEND_URL}/guide">User Guide</a> - Detailed instructions on how to create and manage your web automation tasks</li>
          </ul>
          
          <p>Your feedback is invaluable as we continue to improve our platform. Please reply to this email with any questions, suggestions, or insights about your experience with AgentWeb.</p>
          
          <p>Best regards,<br>Rui Wang<br>CTO, AgentWeb</p>
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
  }
}; 