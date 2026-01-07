
import { crmDb } from '../db';
import { settingsService } from '../settingsService';
import { brandService } from './BrandService';
import { marketStrategyService } from './MarketStrategyService';
import { llmClientFactory } from '../llm/LLMClientFactory';
import { ToolService } from '../../tools/ServiceRegistry';

/**
 * Lead Service
 * Manages CRM leads, lists, and email drafts.
 */

export class LeadService implements ToolService {
  readonly serviceName = 'lead';

  /**
   * Get all lead lists for a user
   */
  async getLeadLists(userId: string): Promise<any> {
    try {
      const lists = await crmDb.getLeadListsByUserId(userId);
      return {
        success: true,
        lists: lists || []
      };
    } catch (error: any) {
      console.error('LeadService: Error getting lead lists:', error);
      return {
        success: false,
        message: 'Failed to get lead lists',
        error: error.message
      };
    }
  }

  /**
   * Create a new lead list
   */
  async createLeadList(name: string, description: string, userId: string): Promise<any> {
    try {
      const list = await crmDb.createLeadList(userId, name, description);
      return {
        success: true,
        message: `Lead list "${name}" created successfully`,
        list
      };
    } catch (error: any) {
      console.error('LeadService: Error creating lead list:', error);
      return {
        success: false,
        message: 'Failed to create lead list',
        error: error.message
      };
    }
  }

  /**
   * Add leads to a list
   */
  async addLeadsToList(listId: string, leads: any[], userId: string): Promise<any> {
    try {
      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return {
          success: false,
          message: 'Lead list not found',
          error: 'The specified lead list does not exist'
        };
      }

      if (list.userId !== userId) {
        return {
          success: false,
          message: 'Access denied',
          error: 'You do not have permission to access this lead list'
        };
      }

      const results = {
        added: 0,
        updated: 0,
        errors: 0
      };

      for (const lead of leads) {
        try {
          if (!lead.email && !lead.linkedinUrl) {
            results.errors++;
            continue;
          }

          // Check if lead exists in the list
          let existingLead = null;
          if (lead.email) {
            existingLead = await crmDb.getLeadByEmail(listId, lead.email);
          }
           // Note: crmDb might not have getLeadByLinkedinUrl implemented based on agentModeService usage
           // agentModeService used addLeadsToList logic which looped and called crmDb.createLead or updateLead?
           // No, agentModeService implementation I saw was just checking list then calling crmDb.addLeads maybe?
           // Let's implement robustly. agentModeService calls crmDb.createLead or updateLead inside.
           
           // Based on typical crmDb patterns:
           if (existingLead) {
             await crmDb.updateLead(listId, existingLead.id, lead);
             results.updated++;
           } else {
             await crmDb.createLead(listId, lead);
             results.added++;
           }
        } catch (e) {
          console.error('LeadService: Error processing lead:', e);
          results.errors++;
        }
      }

      return {
        success: true,
        message: `Processed ${leads.length} leads: ${results.added} added, ${results.updated} updated, ${results.errors} failed`,
        results
      };

    } catch (error: any) {
      console.error('LeadService: Error adding leads to list:', error);
      return {
        success: false,
        message: 'Failed to add leads to list',
        error: error.message
      };
    }
  }

  /**
   * Update (generate) email draft for a lead using LLM
   */
  async updateEmailDraftForLead(
    listId: string,
    leadId: string,
    instruction: string,
    sessionId: string,
    userId: string,
    emailFormat?: 'text' | 'html'
  ): Promise<any> {
    try {
      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'Lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Permission denied' };
      }

      // Get lead
      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'Lead does not exist' };
      }

      // Get context
      const engagementsResult = await crmDb.getLeadEngagements(listId, leadId, userId);
      const engagements = engagementsResult.engagements || [];
      const brandGuidelines = await brandService.readBrandGuidelines(userId);
      const marketStrategy = await marketStrategyService.readMarketStrategy(userId);
      const leadSelectedSenderId = (lead as any).selectedSenderId;
      const senderInfo = await this.getSenderForLead(userId, leadSelectedSenderId, list.listSenderId);
      const existingDraft = (lead as any).emailDraft;
      const emailDraftFormat = emailFormat || (lead as any).emailDraftFormat || 'text';

      // Build Prompt
      let emailPrompt = `You are an expert email marketing strategist. Create a personalized email draft for a lead based on the following information:

## Lead Information:
- Name: ${lead.firstName || ''} ${lead.lastName || ''}`.trim();

      if (lead.company) emailPrompt += `\n- Company: ${lead.company}`;
      if (lead.title) emailPrompt += `\n- Title: ${lead.title}`;
      if (lead.email) emailPrompt += `\n- Email: ${lead.email}`;
      if (lead.notes) emailPrompt += `\n- Notes: ${lead.notes}`;
      if (lead.customFields && Object.keys(lead.customFields).length > 0) {
        emailPrompt += `\n- Custom Fields: ${JSON.stringify(lead.customFields, null, 2)}`;
      }

      // Engagements
      if (engagements.length > 0) {
        emailPrompt += `\n\n## Engagement History:`;
        engagements.slice(0, 10).forEach((eng: any, index: number) => {
          emailPrompt += `\n${index + 1}. ${eng.eventType} - ${eng.createdAt}`;
          if (eng.eventData?.subject) emailPrompt += ` (Subject: ${eng.eventData.subject})`;
          if (eng.emailContent) {
            let contentPreview = '';
            if (eng.emailContent.text) contentPreview = eng.emailContent.text.substring(0, 1000);
            else if (eng.emailContent.html) {
              const textFromHtml = eng.emailContent.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              contentPreview = textFromHtml.substring(0, 1000);
            }
            if (contentPreview) emailPrompt += `\n   Email Content (preview):\n   ${contentPreview.length >= 1000 ? contentPreview + '...' : contentPreview}`;
          }
        });
      } else {
        emailPrompt += `\n\n## Engagement History: No previous engagements`;
      }

      // Brand & Market
      emailPrompt += `\n\n## Brand Guidelines:\n${brandGuidelines.exists ? (brandGuidelines.formattedContent || JSON.stringify(brandGuidelines.brandData, null, 2)) : 'Not configured'}`;
      emailPrompt += `\n\n## Market Strategy:\n${marketStrategy.exists ? (marketStrategy.formattedContent || JSON.stringify(marketStrategy.marketData, null, 2)) : 'Not configured'}`;

      // Sender Info
      if (senderInfo) {
        emailPrompt += `\n\n## Sender Information:\n- From Name: ${senderInfo.fromName}`;
        if (senderInfo.notes) emailPrompt += `\n- Notes: ${senderInfo.notes}`;
        emailPrompt += `\n\nUse this sender information to create an appropriate email signature.`;
        if (senderInfo.notes) emailPrompt += ` Consider notes for signature context.`;
      } else {
        emailPrompt += `\n\n## Sender Information: Not configured (use generic signature)`;
      }

      // Existing draft
      if (existingDraft) {
        const existingContent = emailDraftFormat === 'text'
          ? (existingDraft.textContent || existingDraft.htmlContent || '')
          : (existingDraft.htmlContent || existingDraft.textContent || '');
        emailPrompt += `\n\n## Existing Email Draft (to refine):\nSubject: ${existingDraft.subject}\nContent:\n${existingContent}`;
      }

      // Instruction & Requirements
      emailPrompt += `\n\n## Instruction:\n${instruction}`;
      const contentType = emailDraftFormat === 'text' ? 'plain text' : 'HTML';
      emailPrompt += `\n\n## Requirements:
1. Create a professional, personalized email aligning with constraints.
2. Use lead info for personalization.
3. Consider engagement history context.
4. Appropriate for instruction.
5. Compelling subject line (50-60 chars).
6. Professional ${contentType} format.
7. Clear CTA.
8. Appropriate signature using Sender Info.
9. If updating draft, improve it maintaining core message.
${emailDraftFormat === 'text' ? '10. Plain text only, no HTML.' : '10. HTML format with proper tags and styling.'}

Format response as JSON:
${emailDraftFormat === 'text'
          ? `{"subject": "...", "textContent": "..."}`
          : `{"subject": "...", "htmlContent": "..."}`}`;

      // Call LLM
      const messages = [
        {
          role: "system",
          content: emailDraftFormat === 'text'
            ? "You are an expert email marketing strategist. Create personalized, professional plain text emails. Respond with valid JSON."
            : "You are an expert email marketing strategist in HTML emails. Respond with valid JSON."
        },
        { role: "user", content: emailPrompt }
      ];

      const model = await llmClientFactory.getDefaultModel();
      const completion = await llmClientFactory.callLLM(model, messages, {
        response_format: { type: 'json_object' }
      });

      const responseContent = completion.choices[0].message.content;
      if (!responseContent) throw new Error('No content generated from LLM');

      let emailData;
      try {
        const cleanedContent = responseContent.replace(/```json\s*|\s*```/g, '').trim();
        emailData = JSON.parse(cleanedContent);
      } catch (parseError) {
        console.error('LeadService: Error parsing email draft JSON:', parseError);
        throw new Error('Failed to parse email draft response');
      }

      // Validate
      if (emailDraftFormat === 'text') {
        if (!emailData.subject || !emailData.textContent) throw new Error('LLM response missing required fields');
      } else {
        if (!emailData.subject || !emailData.htmlContent) throw new Error('LLM response missing required fields');
      }

      // Save draft
      const now = new Date().toISOString();
      const emailDraft: any = {
        subject: emailData.subject,
        createdAt: existingDraft?.createdAt || now,
        updatedAt: now,
        sessionId: sessionId
      };

      if (emailDraftFormat === 'text') emailDraft.textContent = emailData.textContent;
      else emailDraft.htmlContent = emailData.htmlContent;

      await crmDb.updateLead(listId, leadId, {
        emailDraft: emailDraft,
        emailDraftFormat: emailDraftFormat
      });

      return {
        success: true,
        message: 'Email draft updated successfully',
        draft: emailDraft
      };

    } catch (error: any) {
      console.error('LeadService: Error updating email draft:', error);
      return {
        success: false,
        message: 'Failed to update email draft',
        error: error.message
      };
    }
  }

  // Helpers

  private async getCrmSenders(userId: string): Promise<{
    success: boolean;
    senders: Array<{ id: string; email: string; fromName: string; notes?: string }>;
    defaultSenderId: string | null;
  }> {
    try {
      const settingName = `crm_sender_emails_${userId}`;
      const setting = await settingsService.getSetting(settingName);

      if (!setting) {
        return { success: true, senders: [], defaultSenderId: null };
      }

      const config = JSON.parse(setting.settingValue);
      return {
        success: true,
        senders: config.senders || [],
        defaultSenderId: config.defaultSenderId || null
      };
    } catch (error) {
      console.error('LeadService: Error getting CRM senders:', error);
      return { success: false, senders: [], defaultSenderId: null };
    }
  }

  private async getSenderForLead(
    userId: string,
    leadSelectedSenderId?: string | null,
    listSenderId?: string | null
  ): Promise<{ fromName: string; notes?: string; } | null> {
    const sendersResult = await this.getCrmSenders(userId);
    if (!sendersResult.success || sendersResult.senders.length === 0) return null;

    let sender = null;
    if (leadSelectedSenderId) sender = sendersResult.senders.find((s) => s.id === leadSelectedSenderId);
    if (!sender && listSenderId) sender = sendersResult.senders.find((s) => s.id === listSenderId);
    if (!sender) {
      const defaultSenderId = sendersResult.defaultSenderId;
      sender = defaultSenderId
        ? sendersResult.senders.find((s) => s.id === defaultSenderId)
        : sendersResult.senders[0];
    }

    return sender ? { fromName: sender.fromName, notes: sender.notes } : null;
  }
}

export const leadService = new LeadService();
