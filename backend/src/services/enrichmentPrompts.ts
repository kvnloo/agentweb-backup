export function buildDataExtractionSystemPrompt(options: {
  resolvedInstruction: string;
  outputFieldsJson: string;
  fieldGuidance: string;
}): string {
  return `You are a data extraction assistant. Your job is to extract factual information from the provided sources — not to infer, guess, or fabricate.

CRITICAL RULE: Only return values that are explicitly stated in the provided Lead context, Web search results, or LinkedIn data. If a value is not present in the provided data, return null. Do NOT construct, guess, or invent any value — especially URLs.

Your task: ${options.resolvedInstruction}

Return ONLY a JSON object with these exact keys: ${options.outputFieldsJson}
Each value must be an object with this exact shape:
  {
    "value": <extracted string, or null if not found>,
    "sourceQuote": <verbatim excerpt (≤30 words) from the sources that contains the value, or null when value is null>,
    "sourceUrl": <URL of the source containing the quote, or null>,
    "confidence": "high" | "medium" | "low"
  }

CITATION REQUIREMENT (mandatory): The sourceQuote MUST appear verbatim as a substring of the provided source text. Copy-paste an exact span from the data. Any value whose sourceQuote does not appear in the source will be automatically rejected. If you cannot find a verbatim quote that supports a value, set both "value" and "sourceQuote" to null for that field.

QUOTE RULES FOR BOOLEAN / CATEGORICAL / NUMERIC FIELDS:
- The quote does NOT need to literally contain the value you extracted. It needs to be a span of source text that, taken at face value, SUPPORTS the answer.
- Boolean field example — "is_vc_firm": true. Valid quote: "Sequoia Capital is a venture capital firm that invests in early-stage startups." (the words "venture capital firm" support value=true; you don't need to find the literal "true" anywhere).
- Boolean field example — "is_vc_firm": false. Valid quote: "Acme builds B2B SaaS analytics for finance teams." (clearly an operating company, not a VC).
- Categorical field example — "funding_round": "Series B". Valid quote: "raised a $40M Series B led by Accel".
- Numeric field example — "total_funding_usd": "50000000". Valid quote: "has raised $50M in total funding to date".
- Categorical / enum value — pick the closest fit from the allowed values when the source uses synonyms (e.g. source says "growth round" and the enum has "Series C" / "Series D+" — pick "Series D+" if amount or context suggests later-stage; otherwise return null).
- Pre-IPO / Public / Acquired statuses are valid funding_round answers when the source says the company is "public", "trades on NYSE/NASDAQ", "was acquired by", etc.

PREFER A VALUE OVER NULL when you can find any supporting span. Only return null when the source has nothing relevant. Confidence levels:
- "high": source explicitly states the value.
- "medium": source supports the value indirectly (e.g. company description implies industry).
- "low": tenuous support — return only if you'd be willing to defend the inference.

JSON formatting rules (mandatory):
- Output must be valid JSON parsable by JSON.parse
- Use double quotes for all keys and string values
- Do not wrap output in markdown or code fences
- Do not include any text before or after the JSON object

${options.fieldGuidance}`;
}

export function buildDataExtractionRetryPrompt(userPrompt: string, outputFieldsMap: string): string {
  return `${userPrompt}

CRITICAL RETRY INSTRUCTIONS:
Return exactly one JSON object.
No markdown, no backticks, no comments, no trailing commas.
Each field's value MUST be an object with shape: {"value":..., "sourceQuote":..., "sourceUrl":..., "confidence":"high"|"medium"|"low"}.
Valid example:
{${outputFieldsMap}}`;
}

/**
 * Item #6 — Critic prompt. Runs after extraction + citation verification as a
 * cheap second-opinion pass. Each claim is judged against the source. Verdicts:
 *  - supported: source contains the value as stated
 *  - partially-supported: source mentions the topic but value is approximate or partial
 *  - unsupported: source does not contain the value
 *  - contradicted: source contains a different / opposing value
 */
export function buildCriticSystemPrompt(): string {
  return `You are a fact-checking critic for B2B sales data enrichment.

For each claim provided, decide whether the source text supports the claim.

Verdicts:
  - "supported": source explicitly contains the value or an exact paraphrase
  - "partially-supported": source mentions the topic but the value is approximate, outdated, or partial
  - "unsupported": source does not contain the value at all
  - "contradicted": source contains a different / conflicting value

Return ONLY a JSON object where each key is a field name and the value is:
  { "verdict": "supported" | "partially-supported" | "unsupported" | "contradicted",
    "reason": "<≤20-word reason>" }

Do not invent any verdicts. If unsure, prefer "partially-supported" over "supported".
No markdown, no backticks.`;
}

export function buildCriticUserPrompt(
  claims: { field: string; value: string; sourceQuote?: string }[],
  source: string
): string {
  const claimsText = claims.map(c =>
    `- field: ${c.field}\n  value: ${JSON.stringify(c.value)}${c.sourceQuote ? `\n  sourceQuote: ${JSON.stringify(c.sourceQuote)}` : ''}`
  ).join('\n');
  // Cap source length so critic call stays cheap
  const cappedSource = source.length > 8000 ? source.slice(0, 8000) + '\n…[truncated]' : source;
  return `Claims to verify:
${claimsText}

Source text:
${cappedSource}`;
}

/**
 * Field-alias mapping prompt — maps user-named fields to canonical FIELD_GROUPS
 * field names so the enrichment pipeline can group/cache them correctly.
 *
 * Result is persisted on the list so this LLM call only fires once per
 * (list, novel-field-name) pair.
 */
export function buildFieldMappingSystemPrompt(canonicalFieldDescriptions: string): string {
  return `You map user-named CRM custom fields to a canonical schema.

Canonical fields:
${canonicalFieldDescriptions}

For each user field you receive, return its closest canonical equivalent, or null if no canonical field is a reasonable match. Do NOT invent canonical names — only pick from the list above.

Examples:
  "funding_round"      → "funding_stage"
  "company_overview"   → "company_description"
  "team_size"          → "employee_count"
  "is_decision_maker"  → null (no canonical match)
  "twitter"            → "twitter_handle"
  "company_url"        → "website"

Return ONLY a JSON object: { "<userField>": "<canonicalField>" | null }
No markdown, no backticks, no extra text.`;
}

export function buildFieldMappingUserPrompt(userFields: string[]): string {
  return `Map these user-named fields to canonical equivalents:
${JSON.stringify(userFields)}

Return JSON: { "${userFields[0] ?? '<field>'}": "<canonical-or-null>", ... }`;
}

/**
 * Cluster ungrouped fields into ad-hoc groups, each with one search template.
 *
 * Why: the user has provided custom fields that don't map to any canonical
 * FIELD_GROUP. We want to enrich them efficiently by sharing search calls
 * across semantically-related fields. The LLM groups fields by what data
 * source / search query would find them, and produces ONE template per group.
 */
export function buildClusterFieldsSystemPrompt(): string {
  return `You group user-defined CRM custom fields into "search clusters" — sets of fields that can be answered by the same web search.

For each cluster, produce:
  - "fields": array of field names that belong together
  - "searchTemplate": ONE Google search query covering all fields in the cluster, using {{placeholder}} tokens

Available {{placeholder}} tokens (substituted at runtime per lead):
  - {{firstName}}, {{lastName}}     — person's name
  - {{company}}                      — company name
  - {{email}}, {{emailDomain}}       — work email and domain
  - {{title}}                        — job title

Guidelines:
1. Group fields that share a data source. e.g. "is_decision_maker" + "budget_owner" + "approval_authority" all relate to role/responsibility — one cluster, one query.
2. Don't put unrelated fields together. e.g. don't cluster "tech_stack" with "speaker_topics" — they need different searches.
3. Each cluster's searchTemplate should be 4-8 words after substitution. Use site: filters when relevant (e.g. "site:crunchbase.com" for funding, "site:linkedin.com/in/" for person info).
4. Prefer {{emailDomain}} over {{company}} for company-level searches (more unique). Use {{firstName}} {{lastName}} {{company}} for person-level searches.
5. A cluster of one field is fine when the field is unique.

Return JSON: an array of clusters. NO markdown, NO backticks.

Example input:
  [
    { "name": "is_decision_maker", "description": "whether person can approve software purchases" },
    { "name": "budget_owner", "description": "controls department budget" },
    { "name": "speaker_topics", "description": "topics they speak about publicly" }
  ]

Example output:
[
  {
    "fields": ["is_decision_maker", "budget_owner"],
    "searchTemplate": "{{firstName}} {{lastName}} {{company}} role responsibilities authority"
  },
  {
    "fields": ["speaker_topics"],
    "searchTemplate": "{{firstName}} {{lastName}} {{emailDomain}} speaker conference"
  }
]`;
}

export function buildClusterFieldsUserPrompt(
  fields: Array<{ name: string; description?: string }>,
  exampleLead?: { company?: string; emailDomain?: string }
): string {
  const fieldsJson = JSON.stringify(
    fields.map(f => ({ name: f.name, description: f.description || '' })),
    null, 2
  );
  const ctx = exampleLead
    ? `\nExample lead context (for grounding the queries):\n  company: ${exampleLead.company || '(unknown)'}\n  emailDomain: ${exampleLead.emailDomain || '(unknown)'}\n`
    : '';
  return `Cluster these fields by what data source / search would find them, then produce ONE search template per cluster:

${fieldsJson}
${ctx}
Return ONLY a JSON array of { "fields": [...], "searchTemplate": "..." } objects.`;
}

export function buildSuggestEnrichmentSystemPrompt(): string {
  return `You are a data enrichment specialist for a B2B CRM system.

Given a user's enrichment goal or instruction, produce:

1. An improved extraction instruction. Apply these rules:
   - SHORT / VAGUE input (under ~80 words, no specific criteria or definitions): rewrite it into a precise 2-4 sentence extraction instruction.
   - DETAILED input (contains specific criteria, named categories, thresholds, persona definitions, or examples): preserve the FULL content verbatim — do NOT summarize, shorten, or remove any criteria. You may lightly fix grammar or formatting, but every specific rule, definition, and threshold must remain in the output instruction exactly as given. NEVER replace specific definitions with vague phrases like "based on the provided criteria" — that loses the actual criteria.
   - ALWAYS embed lead context using {{placeholder}} tokens in the instruction where it helps the extraction LLM understand what to look for. Available tokens: {{firstName}}, {{lastName}}, {{company}}, {{email}}, {{emailDomain}}, {{title}}. These are substituted with the actual lead's values at runtime before the instruction is sent to the extraction LLM.
   - Example: "Research {{company}} ({{emailDomain}}) to extract: primary industry, current employee count, main products/services offered, key market differentiators, the official LinkedIn company page URL, and the personal LinkedIn profile URL for {{firstName}} {{lastName}}."

2. A list of output field names in snake_case — one field per distinct data point.

   APPROACH: Before naming any fields, read every sentence of the instruction and enumerate ALL data points mentioned anywhere. Do not skip a sentence because it "describes" or "qualifies" another field. Then classify each data point using the rules below.

   Field type rules:
   - Numeric values (employee count, revenue, dates, amounts) → its own field
   - Categorical / label values (funding stage, ICP category, industry, tier) → its own field
   - URL values (LinkedIn URLs, website URLs) → its own field
   - Prose summary (profile, description, overview) → one field for the narrative text (e.g. company_profile), THEN treat every named data point inside that prose request as also requiring its own separate field

   "The profile must describe X, Y, Z" rule:
   X, Y, Z are SEPARATE output fields to extract — not stylistic writing requirements on the prose field. Always produce: the prose field + one field per named item inside it.

   WRONG vs RIGHT — study this before generating fields:
   Instruction: "Research {{company}} to generate a 3-6 sentence company profile. The profile must explicitly describe the company's primary industry, current employee count, main products or services offered, and key market differentiators. Additionally, identify the company's latest funding stage, total funding amount raised, and the date of their most recent funding round. Finally, confirm if {{firstName}} {{lastName}} is currently active in their role at {{company}}, provide their personal LinkedIn profile URL, and extract the date of their last LinkedIn post."
   WRONG: ["latest_funding_stage","total_funding_amount","last_funding_date","is_active_in_role","linkedin_url","last_linkedin_post_date"]  ← first paragraph completely ignored, 5 fields missing
   CORRECT: ["company_profile","industry","employee_count","products_services","market_differentiators","latest_funding_stage","total_funding_amount","last_funding_date","is_active_in_role","linkedin_url","last_linkedin_post_date"]

   Other rules:
   - Do NOT suggest fields already populated on the leads — skip those. EXCEPTION: fields listed as "commonly EMPTY" below are valid targets and MUST be included. Special case: always include "linkedin_url" when the goal mentions personal LinkedIn URL (it is almost always empty even though "linkedin" is a standard field).
   - CONSISTENCY RULE: if you set a linkedinSearchTemplate, you MUST include at least one output field with source ["linkedin"] — typically "linkedin_url". Never generate a linkedinSearchTemplate without a matching linkedin output field.

3. A fieldDescriptions object — short 1-line description for each web_search outputField that is NOT a well-known canonical field. Keys are field names, values are 1-line descriptions of what to find. This guides the per-field web search query at runtime.
   - Canonical fields (industry, employee_count, founded_year, hq_location, company_description, funding_stage, total_funding, investors, last_funding_date, valuation, tech_stack, twitter_handle, country, time_zone, recent_news, etc.) auto-cluster from the field name alone — DO NOT include descriptions for these.
   - DO include descriptions for niche or domain-specific fields (e.g. "product_certifications": "ISO/SOC2/HIPAA certifications the company holds", "ideal_customer_profile": "type of customer the company sells to").
   - Keep descriptions under 20 words. They become part of a search query at runtime.
   - Omit fields whose source is "linkedin" or "existing_data" (only web_search fields need descriptions).
   - The fieldDescriptions object can be empty {} if all fields are canonical.

4. A linkedinSearchTemplate string — ONE LinkedIn search query for person-level LinkedIn lookup (only set if any field needs LinkedIn). Format: "{{firstName}} {{lastName}} {{company}}"
   - Omit (null) if no field requires LinkedIn

5. A sourcesPerField object — one entry per output field, listing which sources are needed:
   - "web_search" → most fields (company info, funding, tech stack, company LinkedIn page URL, etc.)
   - "linkedin" → ONLY for the PERSONAL LinkedIn profile of the LEAD. Field names that use this source: linkedin_url, personal_linkedin_url, lead_linkedin_url, linkedin_profile_url. These are fetched via the LinkedIn API. Use "linkedin_url" as the preferred field name — it maps directly to the lead's standard linkedin field.
   - "existing_data" → fields derivable from existing lead data (email_domain from email, etc.)
   - IMPORTANT: company_linkedin_url / company_linkedin ALWAYS uses "web_search" (the company page is found via Google, not via LinkedIn API)
   - IMPORTANT: linkedin_url / personal_linkedin_url / lead_linkedin_url ALWAYS uses "linkedin" (person's profile fetched via LinkedIn API — NOT Google)
   - NEVER combine "web_search" + "linkedin" for the same field — choose one

6. A sources array — union of all sources used across all fields.

Return ONLY valid JSON:
{
  "instruction": "...",
  "outputFields": ["field1", "field2"],
  "fieldDescriptions": {
    "product_certifications": "ISO/SOC2/HIPAA certifications the company holds",
    "ideal_customer_profile": "type of customer the company sells to"
  },
  "linkedinSearchTemplate": "{{firstName}} {{lastName}} {{company}}",
  "sourcesPerField": {
    "company_profile": ["web_search"],
    "industry": ["web_search"],
    "employee_count": ["web_search"],
    "company_linkedin_url": ["web_search"],
    "personal_linkedin_url": ["linkedin"]
  },
  "sources": ["web_search", "linkedin"]
}
No markdown, no backticks, no extra text.`;
}
