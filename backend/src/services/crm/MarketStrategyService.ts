
import { userDb } from '../db';
import { ToolService } from '../../tools/ServiceRegistry';

/**
 * Market Strategy Service
 * Manages market strategy - reading and updating.
 */

export interface Competitor {
  name: string;
  description?: string;
  [key: string]: any;
}

export interface ICP {
  title: string;
  description?: string;
  valueProposition?: string;
  buyerPersonas?: string[];
  [key: string]: any;
}

export interface MarketData {
  businessOverview?: string;
  competitors?: Competitor[];
  icp?: ICP[];
  [key: string]: any;
}

export interface MarketStrategyResult {
  exists: boolean;
  marketData?: MarketData;
  message?: string;
  error?: string;
  success?: boolean;
  formattedContent?: string;
  [key: string]: any;
}

export class MarketStrategyService implements ToolService {
  readonly serviceName = 'market_strategy';

  /**
   * Read market strategy for a user
   */
  async readMarketStrategy(userId: string): Promise<MarketStrategyResult> {
    try {
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          exists: false,
          error: 'User not found'
        };
      }

      const marketStrategy = user.marketStrategy;
      if (!marketStrategy) {
        return {
          success: true,
          exists: false,
          message: 'No market strategy found',
          marketData: {}
        };
      }

      // Format for LLM
      const formattedContent = this.formatMarketStrategy({
        exists: true,
        marketData: marketStrategy
      });

      return {
        success: true,
        message: 'Market strategy retrieved successfully',
        exists: true,
        marketData: marketStrategy,
        formattedContent
      };

    } catch (error: any) {
      console.error('MarketStrategyService: Error reading market strategy:', error);
      return {
        success: false,
        exists: false,
        message: 'Failed to read market strategy',
        error: error.message
      };
    }
  }

  /**
   * Update market strategy for a user
   */
  async updateMarketStrategy(
    updateData: any,
    userId: string
  ): Promise<{ success: boolean; message: string; error?: string }> {
    try {
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      const existingMarketStrategy = user.marketStrategy || {};
      
      const { businessOverview, competitors, icp, ...otherFields } = updateData;

      // Merge competitors
      let mergedCompetitors = [...(existingMarketStrategy.competitors || [])];
      let updatedEntries: string[] = [];
      let addedEntries: string[] = [];

      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach((newCompetitor: any) => {
          const existingIndex = mergedCompetitors.findIndex(existing => existing.name === newCompetitor.name);
          if (existingIndex >= 0) {
            mergedCompetitors[existingIndex] = { ...mergedCompetitors[existingIndex], ...newCompetitor };
            updatedEntries.push(`Competitor: ${newCompetitor.name}`);
          } else {
            mergedCompetitors.push(newCompetitor);
            addedEntries.push(`Competitor: ${newCompetitor.name}`);
          }
        });
      }

      // Merge ICPs
      let mergedICP = [...(existingMarketStrategy.icp || [])];
      
      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach((newICP: any) => {
          const existingIndex = mergedICP.findIndex(existing => existing.title === newICP.title);
          if (existingIndex >= 0) {
            mergedICP[existingIndex] = { ...mergedICP[existingIndex], ...newICP };
            updatedEntries.push(`ICP: ${newICP.title}`);
          } else {
            mergedICP.push(newICP);
            addedEntries.push(`ICP: ${newICP.title}`);
          }
        });
      }

      const updatedMarketStrategy = {
        ...existingMarketStrategy,
        ...otherFields,
        businessOverview: businessOverview !== undefined ? businessOverview : existingMarketStrategy.businessOverview,
        competitors: mergedCompetitors,
        icp: mergedICP,
        updatedAt: new Date().toISOString()
      };

      await userDb.updateUser(userId, {
        marketStrategy: updatedMarketStrategy
      });

      const updatedFields = Object.keys(updateData);
      
      const formattedContent = this.formatMarketStrategyUpdate({
        success: true,
        updatedFields,
        marketData: updatedMarketStrategy,
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length
      });

      return {
        success: true,
        message: 'Market strategy updated successfully',
        formattedContent
      } as any;

    } catch (error: any) {
      console.error('MarketStrategyService: Error updating market strategy:', error);
      return {
        success: false,
        message: 'Failed to update market strategy',
        error: error.message
      };
    }
  }

  // Formatting helpers

  private formatMarketStrategy(marketResult: any): string {
    if (!marketResult.exists) {
      return `<strong>📊 Market Strategy</strong><br>No market strategy is currently configured. You can help the user set up their market strategy by asking about their business overview, competitors, and ideal customer profiles.`;
    }

    const { marketData } = marketResult;
    let formattedSummary = `<strong>📊 Market Strategy Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your market strategy. Here's what I found:<br><br>`;

    formattedSummary += `<strong>🏢 Business Overview</strong><br>`;
    if (marketData.businessOverview) {
      formattedSummary += `${marketData.businessOverview}<br><br>`;
    } else {
      formattedSummary += `No business overview provided yet.<br><br>`;
    }

    formattedSummary += `<strong>🏆 Competitors</strong><br>`;
    if (marketData.competitors && marketData.competitors.length > 0) {
      marketData.competitors.forEach((competitor: any) => {
        if (typeof competitor === 'object' && competitor.name) {
          formattedSummary += `• <strong>${competitor.name}:</strong> ${competitor.description || 'No description provided'}<br>`;
        } else {
          formattedSummary += `• ${competitor}<br>`;
        }
      });
    } else {
      formattedSummary += `• No competitors identified yet<br>`;
    }
    formattedSummary += `<br>`;

    formattedSummary += `<strong>🎯 Ideal Customer Profile (ICP)</strong><br>`;
    if (marketData.icp && marketData.icp.length > 0) {
      marketData.icp.forEach((icp: any) => {
        if (typeof icp === 'object' && icp.title) {
          formattedSummary += `• <strong>${icp.title}:</strong> ${icp.description || 'No description provided'}<br>`;
          if (icp.valueProposition) formattedSummary += `  <em>Value Proposition:</em> ${icp.valueProposition}<br>`;
          if (icp.buyerPersonas && Array.isArray(icp.buyerPersonas) && icp.buyerPersonas.length > 0) {
            formattedSummary += `  <em>Buyer Personas:</em> ${icp.buyerPersonas.join(', ')}<br>`;
          }
        } else {
          formattedSummary += `• ${icp}<br>`;
        }
      });
    } else {
      formattedSummary += `• No ideal customer profiles defined yet<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this market strategy information to inform marketing campaigns, content strategy, and business development decisions.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This market strategy data is current and complete. Please do not call read_market_strategy again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  private formatMarketStrategyUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Market Strategy Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating market strategy.'}`;
    }

    const { updatedFields, updatedEntries, addedEntries, totalCompetitors, totalICPs } = updateResult;
    let formattedSummary = `<strong>✅ Market Strategy Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        if (field === 'businessOverview') {
          formattedSummary += `• <strong>Business Overview:</strong> Updated<br>`;
        } else if (field === 'competitors') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          formattedSummary += `• <strong>Competitors:</strong> ${updatedCount} updated, ${addedCount} added (${totalCompetitors} total)<br>`;
        } else if (field === 'icp') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          formattedSummary += `• <strong>Ideal Customer Profiles:</strong> ${updatedCount} updated, ${addedCount} added (${totalICPs} total)<br>`;
        }
      });
    }

    if (updatedEntries && updatedEntries.length > 0) {
      formattedSummary += `<br><strong>🔄 Updated Entries:</strong><br>`;
      updatedEntries.forEach((entry: string) => formattedSummary += `• ${entry}<br>`);
    }

    if (addedEntries && addedEntries.length > 0) {
      formattedSummary += `<br><strong>➕ Added Entries:</strong><br>`;
      addedEntries.forEach((entry: string) => formattedSummary += `• ${entry}<br>`);
    }

    formattedSummary += `<br><em>💡 You can view the latest market strategy at the <a href="/market-strategy">Market Strategy page</a>.</em>`;
    return formattedSummary;
  }
}

// Singleton instance
export const marketStrategyService = new MarketStrategyService();
