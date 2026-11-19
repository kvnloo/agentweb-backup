/**
 * ENG-3156 — static, versioned industry CPA benchmarks for zoma_industry_benchmark (and, later,
 * ENG-3155's zoma_measurement_report via getIndustryBenchmark).
 *
 * Every row is a figure read from the published source page while ENG-3156 was built
 * (2026-11-18); the exact table cell is quoted in the comment above it. Nothing here is estimated,
 * interpolated or carried across categories: a missing (industry, platform, kpi) is simply absent,
 * and callers report "Industry benchmark: N/A". Public published figures, used with attribution
 * (licensing cleared by the founders).
 *
 * KPI coverage: every source below publishes a cost-per-LEAD table only (Meta: Leads-objective
 * campaigns; Google: search ads). None publishes a purchase/ecommerce CPA or a registration CPA,
 * so there are no 'purchase' or 'registration' rows. Do not map a lead figure to another KPI.
 *
 * Sources:
 *  - LOCALIQ_META_2026  LocaliQ, "Facebook Advertising Benchmarks for 2026" (Last Updated September 23, 2026).
 *      "The average cost per lead in Facebook ads for the leads objective across industries is $27.39"
 *      Table "Business Category | Average CPL". Fetched directly.
 *  - WORDSTREAM_META_2025  WordStream, "Facebook Ads Benchmarks 2025" (Last Updated September 14, 2026; over 1,000 campaigns).
 *      "The average cost per lead in Facebook ads for leads campaigns across all industries is $27.66."
 *      Used only for industries LocaliQ 2026 does not list. wordstream.com returned 403 to automated
 *      fetches; read from https://web.archive.org/web/20261108133201/https://www.wordstream.com/blog/facebook-ads-benchmarks-2025
 *  - WORDSTREAM_GOOGLE_2025  WordStream, "Google Ads Benchmarks 2025" (Last Updated May 18, 2026; over 16,000
 *      campaigns, April 2024 – March 2025). "The average cost per lead in Google Ads in 2025 is $70.11."
 *      Read from https://web.archive.org/web/20261111114638/https://www.wordstream.com/blog/2025-google-ads-benchmarks
 *  Not used: LocaliQ "Search Advertising Benchmarks [2026 Data]" — its overall CPL/CPC repeat the prior year's
 *  figures and several industry cells repeat, so its Google figures were not trusted.
 *
 * Bump INDUSTRY_BENCHMARK_TABLE_VERSION whenever a row, source or industry changes.
 */
export const INDUSTRY_BENCHMARK_TABLE_VERSION = '2026-11-18.1';

/** Fixed industry list (the union of the sources' categories, plus "other" for none of them). */
export const BENCHMARK_INDUSTRIES = [
  'animals_pets', // Animals & Pets
  'apparel_fashion_jewelry', // Apparel / Fashion & Jewelry
  'arts_entertainment', // Arts & Entertainment
  'attorneys_legal', // Attorneys & Legal Services
  'automotive_sales', // Automotive — For Sale
  'automotive_repair', // Automotive — Repair, Service & Parts
  'beauty_personal_care', // Beauty & Personal Care
  'business_services', // Business Services
  'career_employment', // Career & Employment
  'dentists_dental', // Dentists & Dental Services
  'education', // Education & Instruction
  'finance_insurance', // Finance & Insurance
  'furniture', // Furniture
  'health_fitness', // Health & Fitness
  'home_improvement', // Home & Home Improvement
  'industrial_commercial', // Industrial & Commercial
  'personal_services', // Personal Services
  'physicians_surgeons', // Physicians & Surgeons
  'real_estate', // Real Estate
  'restaurants_food', // Restaurants & Food
  'shopping_gifts', // Shopping, Collectibles & Gifts
  'sports_recreation', // Sports & Recreation
  'travel', // Travel
  'other', // none of the above: always N/A
] as const;
export type BenchmarkIndustry = (typeof BENCHMARK_INDUSTRIES)[number];
export const isBenchmarkIndustry = (v: unknown): v is BenchmarkIndustry =>
  typeof v === 'string' && (BENCHMARK_INDUSTRIES as readonly string[]).includes(v);

export const BENCHMARK_PLATFORMS = ['meta', 'google'] as const;
export type BenchmarkPlatform = (typeof BENCHMARK_PLATFORMS)[number];
export type BenchmarkKpi = 'purchase' | 'lead' | 'registration';

export interface IndustryBenchmarkRow {
  industry: BenchmarkIndustry;
  platform: BenchmarkPlatform;
  kpi: BenchmarkKpi;
  /** Cost per acquisition of the KPI, in USD, exactly as published. */
  cpa: number;
  currency: 'USD';
  /** The metric as the source names it. */
  metric: string;
  sourceName: string;
  /** The data year the source labels its figures with. */
  year: number;
  url: string;
}

type Source = Pick<IndustryBenchmarkRow, 'currency' | 'metric' | 'sourceName' | 'year' | 'url'>;

const LOCALIQ_META_2026: Source = {
  currency: 'USD',
  metric: 'Average cost per lead (CPL), Facebook Leads-objective campaigns',
  sourceName: 'LocaliQ — Facebook Advertising Benchmarks for 2026',
  year: 2026,
  url: 'https://localiq.com/blog/facebook-advertising-benchmarks/',
};

const WORDSTREAM_META_2025: Source = {
  currency: 'USD',
  metric: 'Average cost per lead (CPL), Facebook leads campaigns',
  sourceName: 'WordStream — Facebook Ads Benchmarks 2025',
  year: 2025,
  url: 'https://www.wordstream.com/blog/facebook-ads-benchmarks-2025',
};

const WORDSTREAM_GOOGLE_2025: Source = {
  currency: 'USD',
  metric: 'Average cost per lead (CPL), search ads (Google Ads and Microsoft Ads)',
  sourceName: 'WordStream — Google Ads Benchmarks 2025',
  year: 2025,
  url: 'https://www.wordstream.com/blog/2025-google-ads-benchmarks',
};

export const INDUSTRY_BENCHMARKS: readonly IndustryBenchmarkRow[] = [
  // --- Meta, LocaliQ 2026 ("Business Category | Average CPL") ---
  // "Arts & Entertainment | $14.59"
  { industry: 'arts_entertainment', platform: 'meta', kpi: 'lead', cpa: 14.59, ...LOCALIQ_META_2026 },
  // "Automotive–For Sale | $35.52"
  { industry: 'automotive_sales', platform: 'meta', kpi: 'lead', cpa: 35.52, ...LOCALIQ_META_2026 },
  // "Beauty & Personal Care | $50.91"
  { industry: 'beauty_personal_care', platform: 'meta', kpi: 'lead', cpa: 50.91, ...LOCALIQ_META_2026 },
  // "Career & Employment | $12.30"
  { industry: 'career_employment', platform: 'meta', kpi: 'lead', cpa: 12.30, ...LOCALIQ_META_2026 },
  // "Dentists & Dental Services | $61.56"
  { industry: 'dentists_dental', platform: 'meta', kpi: 'lead', cpa: 61.56, ...LOCALIQ_META_2026 },
  // "Education & Instruction | $26.31"
  { industry: 'education', platform: 'meta', kpi: 'lead', cpa: 26.31, ...LOCALIQ_META_2026 },
  // "Furniture | $39.25"
  { industry: 'furniture', platform: 'meta', kpi: 'lead', cpa: 39.25, ...LOCALIQ_META_2026 },
  // "Health & Fitness | $27.11"
  { industry: 'health_fitness', platform: 'meta', kpi: 'lead', cpa: 27.11, ...LOCALIQ_META_2026 },
  // "Home & Home Improvement | $42.95"
  { industry: 'home_improvement', platform: 'meta', kpi: 'lead', cpa: 42.95, ...LOCALIQ_META_2026 },
  // "Industrial & Commercial | $35.87"
  { industry: 'industrial_commercial', platform: 'meta', kpi: 'lead', cpa: 35.87, ...LOCALIQ_META_2026 },
  // "Personal Services | $38.09"
  { industry: 'personal_services', platform: 'meta', kpi: 'lead', cpa: 38.09, ...LOCALIQ_META_2026 },
  // "Physicians & Surgeons | $32.14"
  { industry: 'physicians_surgeons', platform: 'meta', kpi: 'lead', cpa: 32.14, ...LOCALIQ_META_2026 },
  // "Real Estate | $13.74"
  { industry: 'real_estate', platform: 'meta', kpi: 'lead', cpa: 13.74, ...LOCALIQ_META_2026 },
  // "Sports & Recreation | $15.49"
  { industry: 'sports_recreation', platform: 'meta', kpi: 'lead', cpa: 15.49, ...LOCALIQ_META_2026 },
  // --- Meta, WordStream 2025: only industries absent from LocaliQ 2026 ---
  // "Attorneys & Legal Services | $18.17"
  { industry: 'attorneys_legal', platform: 'meta', kpi: 'lead', cpa: 18.17, ...WORDSTREAM_META_2025 },
  // "Restaurants & Food | $3.16"
  { industry: 'restaurants_food', platform: 'meta', kpi: 'lead', cpa: 3.16, ...WORDSTREAM_META_2025 },
  // --- Google, WordStream 2025 ("Business Category | Average CPL") ---
  // "Animals & Pets | $31.82"
  { industry: 'animals_pets', platform: 'google', kpi: 'lead', cpa: 31.82, ...WORDSTREAM_GOOGLE_2025 },
  // "Apparel / Fashion & Jewelry | $101.49"
  { industry: 'apparel_fashion_jewelry', platform: 'google', kpi: 'lead', cpa: 101.49, ...WORDSTREAM_GOOGLE_2025 },
  // "Arts & Entertainment | $30.27"
  { industry: 'arts_entertainment', platform: 'google', kpi: 'lead', cpa: 30.27, ...WORDSTREAM_GOOGLE_2025 },
  // "Attorneys & Legal Services | $131.63"
  { industry: 'attorneys_legal', platform: 'google', kpi: 'lead', cpa: 131.63, ...WORDSTREAM_GOOGLE_2025 },
  // "Automotive — For Sale | $38.86"
  { industry: 'automotive_sales', platform: 'google', kpi: 'lead', cpa: 38.86, ...WORDSTREAM_GOOGLE_2025 },
  // "Automotive — Repair, Service & Parts | $28.50"
  { industry: 'automotive_repair', platform: 'google', kpi: 'lead', cpa: 28.50, ...WORDSTREAM_GOOGLE_2025 },
  // "Beauty & Personal Care | $60.34"
  { industry: 'beauty_personal_care', platform: 'google', kpi: 'lead', cpa: 60.34, ...WORDSTREAM_GOOGLE_2025 },
  // "Business Services | $103.54"
  { industry: 'business_services', platform: 'google', kpi: 'lead', cpa: 103.54, ...WORDSTREAM_GOOGLE_2025 },
  // "Career & Employment | $62.80"
  { industry: 'career_employment', platform: 'google', kpi: 'lead', cpa: 62.80, ...WORDSTREAM_GOOGLE_2025 },
  // "Dentists & Dental Services | $83.93"
  { industry: 'dentists_dental', platform: 'google', kpi: 'lead', cpa: 83.93, ...WORDSTREAM_GOOGLE_2025 },
  // "Education & Instruction | $90.02"
  { industry: 'education', platform: 'google', kpi: 'lead', cpa: 90.02, ...WORDSTREAM_GOOGLE_2025 },
  // "Finance & Insurance | $83.93"
  { industry: 'finance_insurance', platform: 'google', kpi: 'lead', cpa: 83.93, ...WORDSTREAM_GOOGLE_2025 },
  // "Furniture | $121.51"
  { industry: 'furniture', platform: 'google', kpi: 'lead', cpa: 121.51, ...WORDSTREAM_GOOGLE_2025 },
  // "Health & Fitness | $62.80"
  { industry: 'health_fitness', platform: 'google', kpi: 'lead', cpa: 62.80, ...WORDSTREAM_GOOGLE_2025 },
  // "Home & Home Improvement | $90.92"
  { industry: 'home_improvement', platform: 'google', kpi: 'lead', cpa: 90.92, ...WORDSTREAM_GOOGLE_2025 },
  // "Industrial & Commercial | $85.63"
  { industry: 'industrial_commercial', platform: 'google', kpi: 'lead', cpa: 85.63, ...WORDSTREAM_GOOGLE_2025 },
  // "Personal Services | $53.52"
  { industry: 'personal_services', platform: 'google', kpi: 'lead', cpa: 53.52, ...WORDSTREAM_GOOGLE_2025 },
  // "Physicians & Surgeons | $56.83"
  { industry: 'physicians_surgeons', platform: 'google', kpi: 'lead', cpa: 56.83, ...WORDSTREAM_GOOGLE_2025 },
  // "Real Estate | $100.48"
  { industry: 'real_estate', platform: 'google', kpi: 'lead', cpa: 100.48, ...WORDSTREAM_GOOGLE_2025 },
  // "Restaurants & Food | $30.27"
  { industry: 'restaurants_food', platform: 'google', kpi: 'lead', cpa: 30.27, ...WORDSTREAM_GOOGLE_2025 },
  // "Shopping, Collectibles & Gifts | $47.94"
  { industry: 'shopping_gifts', platform: 'google', kpi: 'lead', cpa: 47.94, ...WORDSTREAM_GOOGLE_2025 },
  // "Sports & Recreation | $47.47"
  { industry: 'sports_recreation', platform: 'google', kpi: 'lead', cpa: 47.47, ...WORDSTREAM_GOOGLE_2025 },
  // "Travel | $73.70"
  { industry: 'travel', platform: 'google', kpi: 'lead', cpa: 73.70, ...WORDSTREAM_GOOGLE_2025 },
];

/**
 * The published benchmark for exactly this industry, platform and KPI, or null when no source
 * publishes one. Callers must show null as "Industry benchmark: N/A" and never substitute.
 */
export function getIndustryBenchmark(industry: BenchmarkIndustry, platform: BenchmarkPlatform, kpi: BenchmarkKpi): IndustryBenchmarkRow | null {
  return INDUSTRY_BENCHMARKS.find((r) => r.industry === industry && r.platform === platform && r.kpi === kpi) ?? null;
}
