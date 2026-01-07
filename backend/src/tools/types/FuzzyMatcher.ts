/**
 * Fuzzy Matching Utilities
 * 
 * Provides fuzzy string matching for intent detection.
 * Handles typos in user messages when selecting tool categories.
 */

/**
 * Calculate Levenshtein distance between two strings
 * This measures the minimum number of edits (insertions, deletions, substitutions)
 * needed to transform one string into another.
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Early returns for empty strings
  if (m === 0) return n;
  if (n === 0) return m;

  // Create distance matrix
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill in the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1].toLowerCase() === str2[j - 1].toLowerCase() ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Find the best fuzzy match for a word from a list of targets
 * Returns the matching target if within threshold, otherwise null
 */
export function fuzzyMatch(
  word: string,
  targets: string[],
  threshold: number = 2
): string | null {
  const normalizedWord = word.toLowerCase().trim();
  
  // Skip very short words (likely not meaningful)
  if (normalizedWord.length < 3) return null;

  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const target of targets) {
    const distance = levenshteinDistance(normalizedWord, target.toLowerCase());
    
    // Dynamic threshold based on word length
    // Shorter words get stricter threshold
    const dynamicThreshold = Math.min(threshold, Math.floor(target.length / 3));
    
    if (distance <= dynamicThreshold && distance < bestDistance) {
      bestMatch = target;
      bestDistance = distance;
    }
  }

  return bestMatch;
}

/**
 * Extract words from a message for fuzzy matching
 */
export function extractWords(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Remove punctuation
    .split(/\s+/)
    .filter(word => word.length >= 3);  // Only words with 3+ chars
}

/**
 * Keywords for each category (used for fuzzy matching)
 */
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  content: [
    'blog', 'article', 'write', 'writing', 'post', 'image', 'video',
    'creative', 'social', 'media', 'generate', 'photo', 'picture',
    'linkedin', 'facebook', 'tweet', 'instagram', 'publish'
  ],
  research: [
    'search', 'find', 'research', 'analyze', 'analysis', 'knowledge',
    'investigate', 'lookup', 'explore', 'discover', 'data'
  ],
  crm: [
    'lead', 'leads', 'brand', 'branding', 'strategy', 'customer',
    'guideline', 'marketing', 'target', 'audience', 'competitor',
    'icp', 'ideal', 'persona'
  ],
  gtm: [
    'gtm', 'market', 'launch', 'entry', 'expansion', 'gomarket'
  ],
  analytics: [
    'metrics', 'performance', 'ads', 'campaign', 'stats', 'meta',
    'analytics', 'engagement', 'impressions', 'clicks', 'ctr',
    'roi', 'conversion', 'tracking'
  ],
  automation: [
    'task', 'template', 'work', 'plan', 'schedule', 'revision',
    'automate', 'automation', 'workflow', 'process'
  ],
  books: [
    'book', 'whitepaper', 'white', 'paper', 'chapter', 'outline',
    'ebook', 'publication', 'manuscript', 'document'
  ],
  templates: [
    'html', 'template', 'email', 'newsletter', 'layout'
  ]
};

/**
 * Detect categories from message using fuzzy matching
 * Returns categories that match any word in the message (with typo tolerance)
 */
export function detectCategoriesWithFuzzyMatching(message: string): string[] {
  const words = extractWords(message);
  const detectedCategories = new Set<string>();

  for (const word of words) {
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      // First try exact match
      if (keywords.some(k => k === word)) {
        detectedCategories.add(category);
        continue;
      }
      
      // Then try fuzzy match
      const match = fuzzyMatch(word, keywords, 2);
      if (match) {
        detectedCategories.add(category);
      }
    }
  }

  return Array.from(detectedCategories);
}
