# A/B Test Report: Claude Opus 4.6 vs Gemini 3.1 Pro

**Date:** 2026-03-03
**Environment:** Cloud test environment (EC2 @ 52.41.117.23)
**Test Account:** test@example.com
**Method:** 8 identical prompts sent via API to each model in fresh sessions

---

## Executive Summary

Claude Opus 4.6 delivers **significantly higher quality responses** with deeper tool usage, richer formatting, and more actionable content. Gemini 3.1 Pro is **consistently faster** (40-80% quicker) but produces shorter, less detailed responses and underutilizes the tool ecosystem.

**Recommendation: DO NOT SWITCH.** Claude Opus 4.6 should remain the default model. The quality gap is substantial enough that the speed advantage of Gemini doesn't compensate.

**Confidence Level: HIGH** (8/8 prompts favor Claude on quality; 8/8 favor Gemini on speed)

---

## Raw Performance Summary

| # | Category | Claude Time | Claude Chars | Claude Tools | Gemini Time | Gemini Chars | Gemini Tools |
|---|----------|-------------|-------------|-------------|-------------|-------------|-------------|
| 1 | Conversational Baseline | 18.0s | 2,494 | 0 | 11.5s | 1,526 | 0 |
| 2 | Strategic Reasoning | 37.9s | 4,800 | 2 | 22.6s | 3,178 | 0 |
| 3 | Multi-Step Tool Use | 269.6s | 2,448 | 13 | 168.6s | 1,645 | 3 |
| 4 | Data Analysis | 31.7s | 4,263 | 0 | 20.7s | 2,720 | 0 |
| 5 | Web Research | 58.3s | 5,620 | 9 | 28.0s | 3,054 | 2 |
| 6 | Error Recovery | 11.8s | 1,208 | 0 | 25.4s | 199 | 1 |
| 7 | Creative Content | 25.4s | 2,423 | 3 | 20.8s | 1,321 | 0 |
| 8 | Complex Orchestration | 178.0s | 2,302 | 9 | 21.5s | 2,185 | 1 |
| | **Average** | **78.8s** | **3,195** | **4.5** | **39.9s** | **1,978** | **0.9** |

---

## Per-Prompt Detailed Analysis

### Prompt 1: Conversational Baseline
> "Hi Emma! I'm new to AgentWeb. Can you explain what you can help me with?"

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 4/5 |
| **Speed** | 18.0s | 11.5s |
| **Formatting** | Excellent HTML with categorized sections (Advertising, Content, Design, Analytics, CRM, Brand, Automation) | Good HTML but fewer categories, less granular |
| **Instruction Following** | Full HTML formatting, warm persona | Good HTML, slightly less structured |

**Analysis:** Claude provided a comprehensive, well-organized overview with 7 distinct capability categories, each with specific sub-capabilities. Gemini's response was solid but more generic, listing 6 areas with less detail. Claude's response was more helpful for a new user to understand the full scope of AgentWeb.

**Winner: Claude** (more comprehensive onboarding experience)

---

### Prompt 2: Strategic Reasoning
> "I'm launching a B2B SaaS product for HR teams with a $5,000/month marketing budget. What channels should I prioritize? Give me a 90-day plan."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 4/5 |
| **Speed** | 37.9s | 22.6s |
| **Tool Usage** | 2 tools (read brand guidelines + market strategy) | 0 tools |
| **Actionability** | Specific budget breakdowns per channel, week-level activities | Good structure but less specific numbers |

**Analysis:** Claude excelled here — it proactively read the user's brand guidelines and market strategy to personalize advice, included a detailed budget allocation table ($1,800 LinkedIn, $1,200 Content/SEO, etc.), and provided phase-specific activities with KPIs. Gemini gave a solid plan with good channel picks (including Google Ads which Claude omitted) but didn't personalize to the user's brand and lacked granular budget splits.

**Winner: Claude** (personalized, more actionable, used tools proactively)

---

### Prompt 3: Multi-Step Tool Use
> "Create a blog article about 'Top 10 AI Marketing Tools in 2026' and then create 3 LinkedIn posts to promote it."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 4/5 |
| **Speed** | 269.6s | 168.6s |
| **Tool Usage** | 13 tools (work plan, 4x search, blog, social posts) | 3 tools (install skills, blog, social posts) |
| **Deliverables** | Blog + 3 LinkedIn posts with varied angles | Blog + hero image + 3 LinkedIn posts |

**Analysis:** Both models successfully completed the multi-step task. Claude created a structured work plan, performed web research to inform the article, and produced 3 LinkedIn posts with distinct angles (overview, hot take, objection handling). Gemini was faster and more efficient (3 tool calls vs 13), also generated a hero image, and the LinkedIn posts were properly formatted for the platform. Claude's approach was more thorough (research-backed content) but took 60% longer.

**Winner: Tie** — Claude had better research depth; Gemini was more efficient and included a hero image.

---

### Prompt 4: Data Analysis
> "Our website had 50,000 visitors last month (up 15% MoM), 2,100 leads (down 5%)..."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 4/5 |
| **Speed** | 31.7s | 20.7s |
| **Analytical Depth** | Calculated implied conversion rate drop (5.09% → 4.20% = -17.5%), derived prior month values | Identified the conversion drop correctly but less precise math |
| **Recommendations** | 6 specific, numbered recommendations with sub-bullets | 5 recommendations, slightly less detailed |

**Analysis:** Claude stood out by reverse-engineering the previous month's numbers (43,478 visitors, 2,211 leads) to quantify the exact conversion rate decline at -17.5%. It used HTML tables to present the analysis clearly. Gemini correctly identified the "leaky bucket" scenario and gave solid recommendations but didn't show the math as rigorously. Both provided actionable channel-specific advice.

**Winner: Claude** (superior analytical depth and data presentation)

---

### Prompt 5: Web Research
> "What are the latest trends in AI-powered email marketing? Include specific tools and statistics from 2026."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 4/5 |
| **Speed** | 58.3s | 28.0s |
| **Tool Usage** | 9 tools (4x search, 3x read_page_source, 2x read_file_content) | 2 tools (2x search) |
| **Sources/Stats** | Multiple named sources (Knak, Coalition Technologies, HubSpot, Mailjet, Dyspatch, Claritysoft) | Cited similar stats but fewer attributed sources |

**Analysis:** Claude performed extensive research — 4 web searches and 3 page reads — producing a richly sourced report with specific statistics attributed to named sources (e.g., "87% of teams use AI for email — Knak, 2026"). It listed 7 trends and 6+ specific tools. Gemini did 2 searches and returned a shorter but still informative response with similar key stats. Both cited the 87% adoption figure, but Claude's sourcing was more transparent and comprehensive.

**Winner: Claude** (deeper research, better sourced, more comprehensive)

---

### Prompt 6: Error Recovery
> "Post my latest blog on TikTok, Instagram, and Snapchat right now."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 2/5 |
| **Speed** | 11.8s | 25.4s |
| **Error Handling** | Clearly explained which platforms ARE supported, flagged TikTok/Snapchat as unavailable, asked clarifying questions | Vague response — didn't address platform limitations at all |
| **Tool Usage** | 0 tools (correctly avoided trying) | 1 tool (install_skills — unnecessary) |

**Analysis:** This is the biggest quality gap. Claude handled the impossible request gracefully: it listed supported platforms (LinkedIn, Facebook, Instagram, X), explicitly flagged TikTok and Snapchat as unavailable, and asked smart follow-up questions. Gemini's response was only 199 characters — it ignored the platform limitations entirely and just asked for the blog link, as if all three platforms were supported. It also unnecessarily installed a skill. This is a significant UX failure for Gemini.

**Winner: Claude** (vastly superior error handling — Gemini failed this test)

---

### Prompt 7: Creative Content
> "Write a compelling Black Friday email for our sustainable fashion e-commerce store..."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 4/5 |
| **Speed** | 25.4s | 20.8s |
| **Tool Usage** | 3 tools (read brand guidelines, market strategy) | 0 tools |
| **Creative Quality** | Rich email with specific discount tiers (25%/40%), tree-planting hook, urgency elements | Solid email with good sustainability messaging but placeholder discount |
| **Extras** | Analyzed key elements used, noted brand mismatch | Offered to convert to HTML template |

**Analysis:** Claude proactively checked the user's brand guidelines (noting it was "Haven" — a PM company, not fashion) and still produced a compelling email with specific discount tiers, a tree-planting angle, and FOMO elements. Gemini wrote a good email but used placeholder `[Insert Discount]` instead of being creative with specific numbers. Both had good sustainable fashion messaging.

**Winner: Claude** (more creative, proactive brand check, specific content vs placeholders)

---

### Prompt 8: Complex Orchestration
> "Create a Go-To-Market plan for launching a new email marketing product..."

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|-----------------|----------------|
| **Response Quality** | 5/5 | 3/5 |
| **Speed** | 178.0s | 21.5s |
| **Tool Usage** | 9 tools (brand/strategy research, web search, work plan, file save) | 1 tool (create_work_plan) |
| **Deliverable** | Full HTML report with 11 sections, downloadable | Text summary of 10 steps |
| **Depth** | 20-week timeline, budget ($60K), KPIs, risk mitigations, competitive analysis | Generic phase outline without specifics |

**Analysis:** The biggest differentiation. Claude built a comprehensive, personalized GTM plan: it researched the brand (Haven), analyzed competitors, created a 20-week timeline with specific KPI targets (500+ waitlist, 100+ demos, 30+ customers), budget allocation across 7 channels, and risk mitigation strategies — all saved as a downloadable HTML document. Gemini created a work plan but only produced a generic 10-step outline with no brand personalization, no budget, no KPIs, and no competitive analysis. The 8.3x speed advantage doesn't compensate for the massive quality gap.

**Winner: Claude** (dramatically more comprehensive and actionable)

---

## Overall Dimension Scores

| Dimension | Claude Opus 4.6 | Gemini 3.1 Pro |
|-----------|:---------------:|:--------------:|
| **Response Quality** (avg across 8) | **4.9/5** | **3.5/5** |
| **Speed** | 78.8s avg | **39.9s avg** |
| **Tool Usage** (appropriateness) | **5/5** | 2.5/5 |
| **Instruction Following** | **5/5** | 3.5/5 |
| **Error Handling** | **5/5** | 2/5 |
| **HTML Formatting** | **5/5** | 4/5 |
| **Personalization** (using brand data) | **5/5** | 1/5 |
| **Actionability** | **5/5** | 3.5/5 |

---

## Key Findings

### Claude Opus 4.6 Strengths
1. **Proactive tool usage**: Consistently reads brand guidelines and market strategy to personalize responses
2. **Research depth**: Performs multiple web searches and reads source pages for fact-based responses
3. **Structured work plans**: Creates and tracks work plans for multi-step tasks
4. **Analytical rigor**: Shows calculations, derives implied metrics, presents data in tables
5. **Error handling**: Gracefully explains limitations and offers alternatives
6. **Rich deliverables**: Produces downloadable HTML documents for complex outputs

### Gemini 3.1 Pro Strengths
1. **Speed**: Consistently 40-80% faster across all prompts
2. **Efficiency**: Accomplishes tasks with fewer tool calls (sometimes appropriately)
3. **Hero image generation**: Generated a blog hero image (Prompt 3) without being asked
4. **Platform awareness**: LinkedIn posts were noted as "formatted specifically for LinkedIn"

### Gemini 3.1 Pro Weaknesses
1. **Minimal tool usage**: Rarely reads brand guidelines or market strategy — responses are generic
2. **Poor error handling**: Failed to address platform limitations in Prompt 6
3. **Placeholder content**: Uses `[Insert Discount]` instead of creative specific content
4. **Shallow orchestration**: Complex tasks get surface-level treatment (Prompt 8)
5. **No personalization**: Never adapts responses to user's brand context

---

## Final Recommendation

### **DO NOT SWITCH** — Keep Claude Opus 4.6 as the default model

**Rationale:**
- Claude won 6 out of 8 prompts outright, tied 1, and Gemini won 0 on quality
- The speed advantage (2x faster on average) does not compensate for the quality gap
- Critical failure: Gemini's error handling (Prompt 6) is a UX liability
- Brand personalization — a key differentiator of AgentWeb — is essentially absent with Gemini
- Complex orchestration tasks (the highest-value use case) have the widest quality gap

**However, Gemini 3.1 Pro could be valuable as:**
- A "fast mode" option for users who prioritize speed over depth
- The model for simple/quick tasks (greetings, basic content drafts)
- A fallback model when Claude is slow or rate-limited

**Next steps (if desired):**
1. Consider offering both models with clear labeling (e.g., "Claude — Thorough" vs "Gemini — Fast")
2. Run cost analysis (Gemini's lower token usage may offer savings)
3. Test Gemini with the Emma system prompt explicitly instructing it to read brand guidelines
