
import { userDb } from '../db';
import { ToolService } from '../../tools/ServiceRegistry';

/**
 * Brand Service
 * Manages brand guidelines - reading and updating.
 */

/**
 * Brand data structure
 */
export interface BrandData {
  brandName?: string;
  tagline?: string;
  primaryColor?: string;
  primaryColorEnd?: string;
  secondaryColor?: string;
  fontFamily?: string;
  toneOfVoice?: string;
  brandPersonality?: string;
  targetAudience?: string;
  keyMessages?: string[];
  brandValues?: string[];
  isGradient?: boolean;
  founders?: Array<{
    name: string;
    jobTitle?: string;
    styleTone?: string;
    signaturePosts?: string;
  }>;
}

/**
 * Brand asset structure
 */
export interface BrandAsset {
  type: 'logo' | 'secondaryLogo' | 'brandGuide' | 'additionalAsset';
  url: string;
  filename?: string;
}

/**
 * Brand guidelines result
 */
export interface BrandGuidelinesResult {
  exists: boolean;
  brandData?: BrandData;
  brandAssets?: BrandAsset[];
  message?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  formattedContent?: string;
  success?: boolean;
  attachments?: BrandAsset[]; // Alias for brandAssets for compatibility
  [key: string]: any;
}

/**
 * Brand Service - manages brand guidelines
 */
export class BrandService implements ToolService {
  readonly serviceName = 'brand';

  /**
   * Read brand guidelines for a user
   */
  async readBrandGuidelines(userId: string): Promise<BrandGuidelinesResult> {
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

      const brand = user.brandGuidelines;
      if (!brand) {
        return {
          success: true,
          exists: false,
          message: 'No brand guidelines found',
          brandData: {},
          attachments: []
        };
      }

      // Format the brand guidelines for LLM consumption
      const formattedContent = this.formatBrandGuidelines({
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || []
      });

      return {
        success: true,
        message: `Brand guidelines retrieved successfully`,
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || [],
        createdAt: brand.createdAt,
        updatedAt: brand.updatedAt,
        formattedContent
      };
    } catch (error: any) {
      console.error('BrandService: Error reading brand guidelines:', error);
      return {
        success: false,
        exists: false,
        message: 'Failed to read brand guidelines',
        error: error.message
      };
    }
  }

  /**
   * Update brand guidelines for a user
   */
  async updateBrandGuidelines(
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

      // Get existing brand guidelines
      let existingBrand = user.brandGuidelines;

      // If no existing brand guidelines, create a new structure
      if (!existingBrand) {
        const initialBrandGuidelines = {
          brandData: {
            brandName: "",
            tagline: "",
            primaryColor: "",
            primaryColorEnd: "",
            secondaryColor: "",
            fontFamily: "",
            toneOfVoice: "",
            keyMessages: [],
            brandValues: [],
            targetAudience: "",
            brandPersonality: "",
            isGradient: false,
            founders: [],
          },
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await userDb.updateUser(userId, {
          brandGuidelines: initialBrandGuidelines
        });

        existingBrand = initialBrandGuidelines;
      }

      const { brandData, brandAssets, ...otherFields } = updateData;

      // Merge brandData
      const updatedBrandData = {
        ...existingBrand.brandData,
        ...brandData
      } as any;

      // Special merge logic for founder profiles
      if (brandData && Array.isArray((brandData as any).founders)) {
        const normalize = (name: any) =>
          typeof name === 'string' ? name.trim().toLowerCase() : '';

        const existingFounders: any[] = Array.isArray((existingBrand.brandData as any)?.founders)
          ? (existingBrand.brandData as any).founders
          : [];
        const incomingFounders: any[] = (brandData as any).founders || [];

        const mergedFounders: any[] = [...existingFounders];
        for (const newFounder of incomingFounders) {
          if (!newFounder || !newFounder.name) continue;
          const key = normalize(newFounder.name);
          if (!key) continue;

          const idx = mergedFounders.findIndex(
            f => f && normalize(f.name) === key
          );
          if (idx >= 0) {
            mergedFounders[idx] = newFounder;
          } else {
            mergedFounders.push(newFounder);
          }
        }
        updatedBrandData.founders = mergedFounders;
      }

      // Handle brandAssets update
      let updatedAttachments = [...(existingBrand.attachments || [])];
      let updatedAssets: any[] = [];

      if (brandAssets !== undefined) {
        if (Array.isArray(brandAssets)) {
          brandAssets.forEach((newAsset: any) => {
            const existingIndex = updatedAttachments.findIndex((existing: any) => existing.type === newAsset.type);
            if (existingIndex >= 0) {
              updatedAttachments[existingIndex] = newAsset;
              updatedAssets.push(newAsset);
            } else {
              updatedAttachments.push(newAsset);
              updatedAssets.push(newAsset);
            }
          });
        } else if (typeof brandAssets === 'object' && brandAssets !== null) {
          const existingIndex = updatedAttachments.findIndex((existing: any) => existing.type === (brandAssets as any).type);
          if (existingIndex >= 0) {
            updatedAttachments[existingIndex] = brandAssets;
            updatedAssets.push(brandAssets);
          } else {
            updatedAttachments.push(brandAssets);
            updatedAssets.push(brandAssets);
          }
        }
      }

      // Construct final object
      const fullUpdatedBrandGuidelines = {
        ...existingBrand,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAt: new Date().toISOString()
      };

      // Save to DB
      await userDb.updateUser(userId, {
        brandGuidelines: fullUpdatedBrandGuidelines
      });

      // Format feedback
      const changedFields = Object.keys(brandData || {}).concat(brandAssets ? ['brandAssets'] : []);
      const formattedContent = this.formatBrandGuidelinesUpdate({
        success: true,
        updatedFields: changedFields,
        brandData: updatedBrandData,
        updatedAssets: updatedAssets
      });

      return {
        success: true,
        message: 'Brand guidelines updated successfully',
        formattedContent: formattedContent
      } as any;

    } catch (error: any) {
      console.error('BrandService: Error updating brand guidelines:', error);
      return {
        success: false,
        message: 'Failed to update brand guidelines',
        error: error.message
      };
    }
  }

  // Formatting helpers

  private formatBrandGuidelines(brandResult: any): string {
    if (!brandResult.exists) {
      return `<strong>🎨 Brand Guidelines</strong><br>No brand guidelines are currently configured. You can help the user set up their brand identity by asking about their brand name, colors, tone of voice, and other brand elements.`;
    }

    const { brandData, attachments } = brandResult;
    let formattedSummary = `<strong>🎨 Brand Guidelines Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your brand guidelines. Here's what I found:<br><br>`;

    formattedSummary += `<strong>💖 Brand Identity</strong><br>`;
    formattedSummary += `• <strong>Brand Name:</strong> ${brandData.brandName || 'Not set'}<br>`;
    formattedSummary += `• <strong>Tagline:</strong> ${brandData.tagline || 'Not set'}<br>`;
    formattedSummary += `• <strong>Target Audience:</strong> ${brandData.targetAudience || 'Not set'}<br><br>`;

    formattedSummary += `<strong>🎨 Brand Colors</strong><br>`;
    if (brandData.primaryColor) {
      if (brandData.isGradient && brandData.primaryColorEnd) {
        formattedSummary += `• <strong>Primary Color (Gradient):</strong> ${brandData.primaryColor} → ${brandData.primaryColorEnd}<br>`;
      } else {
        formattedSummary += `• <strong>Primary Color:</strong> ${brandData.primaryColor}<br>`;
      }
    }
    formattedSummary += `• <strong>Secondary Color:</strong> ${brandData.secondaryColor || 'Not set'}<br><br>`;

    formattedSummary += `<strong>🔤 Typography</strong><br>`;
    formattedSummary += `• <strong>Font Family:</strong> ${brandData.fontFamily || 'Not set'}<br><br>`;

    formattedSummary += `<strong>💬 Brand Voice & Messaging</strong><br>`;
    formattedSummary += `• <strong>Tone of Voice:</strong> ${brandData.toneOfVoice || 'Not set'}<br>`;
    formattedSummary += `• <strong>Brand Personality:</strong> ${brandData.brandPersonality || 'Not set'}<br><br>`;

    formattedSummary += `<strong>📝 Key Messages</strong><br>`;
    if (brandData.keyMessages && brandData.keyMessages.length > 0) {
      brandData.keyMessages.forEach((message: string, index: number) => {
        formattedSummary += `• ${index + 1}. ${message}<br>`;
      });
    } else {
      formattedSummary += `• No key messages set<br>`;
    }
    formattedSummary += `<br>`;

    formattedSummary += `<strong>💖 Brand Values</strong><br>`;
    if (brandData.brandValues && brandData.brandValues.length > 0) {
      brandData.brandValues.forEach((value: string) => {
        formattedSummary += `• ${value}<br>`;
      });
    } else {
      formattedSummary += `• No brand values set<br>`;
    }
    formattedSummary += `<br>`;

    formattedSummary += `<strong>👥 Founder Profile</strong><br>`;
    if (brandData.founders && brandData.founders.length > 0) {
      brandData.founders.forEach((founder: any, index: number) => {
        formattedSummary += `• <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
        if (founder.jobTitle) formattedSummary += `  📋 <strong>Job Title:</strong> ${founder.jobTitle}<br>`;
        if (founder.styleTone) formattedSummary += `  🎭 <strong>Style & Tone:</strong> ${founder.styleTone}<br>`;
        if (founder.signaturePosts) formattedSummary += `  ✍️ <strong>Signature Posts:</strong> ${founder.signaturePosts}<br>`;
        formattedSummary += `<br>`;
      });
    } else {
      formattedSummary += `• No founder profiles added<br>`;
    }
    formattedSummary += `<br>`;

    formattedSummary += `<strong>🖼️ Logo & Assets</strong><br>`;
    if (attachments && attachments.length > 0) {
      const logoAssets = attachments.filter((asset: any) => asset.type === 'logo' || asset.type === 'secondaryLogo');
      const brandGuideAssets = attachments.filter((asset: any) => asset.type === 'brandGuide');

      if (logoAssets.length > 0) {
        logoAssets.forEach((asset: any) => {
          const logoType = asset.type === 'logo' ? 'Primary Logo' : 'Secondary Logo';
          formattedSummary += `• <strong>${logoType}:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View ${logoType}</a><br>`;
        });
      } else {
        formattedSummary += `• No logos uploaded<br>`;
      }

      if (brandGuideAssets.length > 0) {
        brandGuideAssets.forEach((asset: any) => {
          formattedSummary += `• <strong>Brand Guide:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View Brand Guide</a><br>`;
        });
      } else {
        formattedSummary += `• No brand guide uploaded<br>`;
      }
    } else {
      formattedSummary += `• No assets uploaded<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this brand information to ensure all generated content aligns with your brand identity and guidelines.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This brand guidelines data is current and complete. Please do not call read_brand_guidelines again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  private formatBrandGuidelinesUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Brand Guidelines Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating brand guidelines.'}`;
    }

    const { updatedFields, brandData, updatedAssets } = updateResult;
    let formattedSummary = `<strong>✅ Brand Guidelines Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        let value;
        if (field === 'brandAssets') {
          value = updatedAssets;
        } else {
          value = brandData[field];
        }

        if (value !== undefined && value !== null) {
          if (field === 'brandAssets' && Array.isArray(value) && value.length > 0) {
            formattedSummary += `• <strong>Brand Assets:</strong> Updated ${value.length} asset(s)<br>`;
            value.forEach((asset: any) => {
              const assetType = asset.type === 'logo' ? 'Primary Logo' :
                asset.type === 'secondaryLogo' ? 'Secondary Logo' :
                  asset.type === 'brandGuide' ? 'Brand Guide' :
                    asset.type === 'additionalAsset' ? 'Additional Asset' : asset.type;
              formattedSummary += `  - ${assetType}: ${asset.filename}<br>`;
            });
          } else if (field === 'founders' && Array.isArray(value)) {
            formattedSummary += `• <strong>Founder Profiles:</strong> Updated ${value.length} founder(s)<br>`;
            // Truncate founder details for brevity
            value.forEach((founder: any) => formattedSummary += `  - ${founder.name}<br>`);
          } else if (Array.isArray(value)) {
            formattedSummary += `• <strong>${field}:</strong> ${value.join(', ')}<br>`;
          } else {
            formattedSummary += `• <strong>${field}:</strong> ${value}<br>`;
          }
        }
      });
    }

    formattedSummary += `<br><em>💡 You can view the latest brand guidelines at the <a href="/brand-guidelines">Brand Guidelines page</a>.</em>`;
    return formattedSummary;
  }
}

// Singleton instance
export const brandService = new BrandService();
