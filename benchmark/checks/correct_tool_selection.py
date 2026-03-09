"""Check: Emma should select the most appropriate tools for the task.

LLM-evaluated check scoring 1-5 on whether Emma chose the right tools
for the user's request.
"""

PROMPT_TEMPLATE = """You are evaluating an AI marketing assistant called Emma.

Emma has access to various marketing tools including:
- Content creation (blog writing, social media posts, email drafts)
- Image/video generation
- SEO analysis (Search Console, PageSpeed, keyword research)
- Lead/CRM management (add leads, query engagement, send emails)
- Knowledge base (search files, read documents)
- GTM planning (create plans, manage work items)
- Web research and deep research
- Connected accounts (LinkedIn, social media posting)

Review the conversation and evaluate whether Emma selected the most
appropriate tools for the user's request.

Score 1-5:
1 = Used completely wrong tools or no tools when tools were clearly needed
2 = Used partially relevant tools but missed the best options
3 = Used acceptable tools but not the optimal selection
4 = Used appropriate tools with minor room for improvement
5 = Used the perfect set of tools for the task

If no tools were needed and none were used, score 5.

User request context:
{scenario_input}

Conversation:
{generation}

Return only the score (1-5) followed by a brief explanation."""

CHECK_TYPE = "score"
