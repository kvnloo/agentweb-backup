import { BetaAnalyticsDataClient } from "@google-analytics/data";

/**
 * Default funnel stages for user journey analysis using GA4 events
 * These stages can be customized per user via funnelConfig in User record
 *
 * This example demonstrates a typical lead generation funnel:
 * 1. Homepage visit
 * 2. Form link click
 * 3. Form submission
 */
export const DEFAULT_FUNNEL_STAGES = [
  {
    name: "Homepage",
    eventName: "page_view",
    filterExpression: "pagePath=~^/$",
    color: "#4285F4"
  },
  {
    name: "Form Click",
    eventName: "click",
    filterExpression: "linkUrl=~forms.withsurface.com",
    color: "#34A853"
  },
  {
    name: "Form Submit",
    eventName: "form_submit",
    color: "#FBBC04"
  },
];

export interface FunnelStage {
  name: string;
  eventName: string; // GA4 event name (e.g., "page_view", "button_click", "form_submit")
  filterExpression?: string; // GA4 filter expression (e.g., "pagePath=~/pricing")
  color: string;
}

export interface FunnelStageResult extends FunnelStage {
  users: number;
  dropoffRate?: number;
  conversionRate?: number;
}

export interface FunnelMetrics {
  stages: FunnelStageResult[];
  totalSessions: number;
  completionRate: number;
  dateRange: { startDate: string; endDate: string };
  error?: string;
}

interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Parse filter expression to extract field name and pattern
 * Format: "fieldName=~pattern" (regex pattern without delimiters)
 *
 * Converts snake_case to camelCase for GA4 compatibility
 */
function parseFilterExpression(filterExpr: string): { fieldName: string; pattern: string } | null {
  const match = filterExpr.match(/^(\w+)=~(.+)$/);
  if (match) {
    let fieldName = match[1];

    // Convert snake_case to camelCase for GA4
    // link_url -> linkUrl, link_text -> linkText, etc.
    if (fieldName.includes('_')) {
      fieldName = fieldName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    }

    return { fieldName, pattern: match[2] };
  }
  return null;
}

/**
 * Calculate user journey funnel metrics using GA4 Data API
 *
 * This implementation uses runReport to track user progression through funnel stages.
 * For page_view events, it filters by pagePath. For custom events, it tracks event occurrences.
 *
 * @param gaClient - Google Analytics Data API client
 * @param propertyId - GA4 property ID (without "properties/" prefix)
 * @param dateRange - Date range for the funnel analysis
 * @param stages - Array of funnel stages with event names and filters
 * @returns FunnelMetrics object with stage progression and drop-off rates
 */
export async function calculateFunnelMetrics(
  gaClient: BetaAnalyticsDataClient,
  propertyId: string,
  dateRange: DateRange,
  stages: FunnelStage[]
): Promise<FunnelMetrics> {
  try {
    const { startDate, endDate } = dateRange;

    // First, get total sessions count for context
    const [sessionsResponse] = await gaClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: "sessions" }],
    });

    const totalSessions = sessionsResponse.rows?.[0]?.metricValues?.[0]?.value
      ? parseInt(sessionsResponse.rows[0].metricValues[0].value)
      : 0;

    // Check if we have enough data
    if (totalSessions < 100) {
      return {
        stages: [],
        totalSessions,
        completionRate: 0,
        dateRange: { startDate, endDate },
        error: "Insufficient data for funnel analysis. Need at least 100 sessions in selected time period.",
      };
    }

    // Calculate users for each funnel stage
    const funnelStages: FunnelStageResult[] = [];
    let previousStageUsers = 0;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];

      // Build dimension filters based on stage configuration
      const dimensionFilter: any = {
        filter: {
          fieldName: "eventName",
          stringFilter: {
            matchType: "EXACT",
            value: stage.eventName,
          },
        },
      };

      // Add pagePath or other dimension filters if specified
      let additionalFilter: any = null;
      if (stage.filterExpression) {
        const parsed = parseFilterExpression(stage.filterExpression);
        if (parsed) {
          additionalFilter = {
            filter: {
              fieldName: parsed.fieldName,
              stringFilter: {
                matchType: "PARTIAL_REGEXP",
                value: parsed.pattern,
              },
            },
          };
        }
      }

      // Build dimension filter (AND condition if we have additional filter)
      const finalDimensionFilter = additionalFilter
        ? {
            andGroup: {
              expressions: [dimensionFilter, additionalFilter],
            },
          }
        : dimensionFilter;

      // Query GA4 for users who triggered this event
      console.log(`[Funnel Debug] Stage ${i + 1}: ${stage.name}`);
      console.log(`[Funnel Debug] Event: ${stage.eventName}`);
      console.log(`[Funnel Debug] Filter: ${stage.filterExpression || 'none'}`);
      console.log(`[Funnel Debug] Parsed filter:`, additionalFilter ? JSON.stringify(additionalFilter, null, 2) : 'none');

      const [stageResponse] = await gaClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: "activeUsers" }],
        dimensionFilter: finalDimensionFilter,
      });

      const stageUsers = stageResponse.rows?.[0]?.metricValues?.[0]?.value
        ? parseInt(stageResponse.rows[0].metricValues[0].value)
        : 0;

      // Calculate conversion rate from total sessions entering funnel
      const firstStageUsers = i === 0 ? stageUsers : (funnelStages[0]?.users || stageUsers);
      const conversionRate = firstStageUsers > 0 ? (stageUsers / firstStageUsers) * 100 : 0;

      // Calculate drop-off rate from previous stage
      let dropoffRate = 0;
      if (i > 0 && previousStageUsers > 0) {
        dropoffRate = ((previousStageUsers - stageUsers) / previousStageUsers) * 100;
      }

      funnelStages.push({
        ...stage,
        users: stageUsers,
        conversionRate: Math.round(conversionRate * 100) / 100,
        dropoffRate: i > 0 ? Math.round(dropoffRate * 100) / 100 : undefined,
      });

      previousStageUsers = stageUsers;
    }

    // If no funnel data, return empty result
    if (funnelStages.length === 0 || funnelStages[0].users === 0) {
      return {
        stages: [],
        totalSessions,
        completionRate: 0,
        dateRange: { startDate, endDate },
        error: "No funnel data available. Ensure events are tracked in GA4.",
      };
    }

    // Calculate overall completion rate
    const finalStageUsers = funnelStages[funnelStages.length - 1]?.users || 0;
    const firstStageUsers = funnelStages[0]?.users || 1;
    const completionRate = firstStageUsers > 0
      ? Math.round((finalStageUsers / firstStageUsers) * 100 * 100) / 100
      : 0;

    return {
      stages: funnelStages,
      totalSessions,
      completionRate,
      dateRange: { startDate, endDate },
    };
  } catch (error: any) {
    console.error("Error calculating funnel metrics:", error);
    return {
      stages: [],
      totalSessions: 0,
      completionRate: 0,
      dateRange: { startDate: dateRange.startDate, endDate: dateRange.endDate },
      error: error.message || "Failed to calculate funnel metrics",
    };
  }
}

/**
 * Validate funnel stage configuration
 *
 * @param stages - Array of funnel stages to validate
 * @returns Array of validation errors (empty if all valid)
 */
export function validateFunnelStages(stages: FunnelStage[]): string[] {
  const errors: string[] = [];

  if (!stages || stages.length === 0) {
    errors.push("At least one funnel stage is required");
    return errors;
  }

  if (stages.length > 10) {
    errors.push("Maximum 10 funnel stages allowed");
  }

  stages.forEach((stage, index) => {
    if (!stage.name || stage.name.trim() === "") {
      errors.push(`Stage ${index + 1}: Name is required`);
    }

    if (!stage.eventName || stage.eventName.trim() === "") {
      errors.push(`Stage ${index + 1}: Event name is required`);
    }

    if (stage.filterExpression) {
      // Validate filter expression format: fieldName=~pattern
      const isValid = /^\w+=~.+$/.test(stage.filterExpression);
      if (!isValid) {
        // Provide helpful error message based on common mistakes
        if (stage.filterExpression.includes('=') && !stage.filterExpression.includes('=~')) {
          errors.push(`Stage ${index + 1}: Invalid filter expression "${stage.filterExpression}". Use format: "fieldName=~pattern" (e.g., "link_url=~pricing" or "pagePath=~^/$")`);
        } else {
          errors.push(`Stage ${index + 1}: Invalid filter expression format. Use: "fieldName=~pattern" (e.g., "pagePath=~pricing")`);
        }
      }
    }

    if (!stage.color || !/^#[0-9A-Fa-f]{6}$/.test(stage.color)) {
      errors.push(`Stage ${index + 1}: Invalid color format (must be hex color like #4285F4)`);
    }
  });

  return errors;
}
