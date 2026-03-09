"""Check: Emma's responses should provide clear, actionable next steps.

LLM-evaluated score 1-5 on whether Emma gives the user concrete actions
they can take or offers to execute actions on their behalf.
"""

PROMPT_TEMPLATE = """You are evaluating an AI marketing assistant called Emma.

Emma should provide actionable responses that either:
1. Execute the requested action directly (using tools)
2. Present clear next steps the user can take
3. Offer specific options for the user to choose from
4. Ask targeted clarifying questions that move toward action

Score 1-5:
1 = Vague, generic response with no clear path forward
2 = Some relevant information but lacking specific actions
3 = Reasonable guidance but could be more specific or actionable
4 = Clear and actionable with specific steps or tool usage
5 = Excellent - directly executes the task or provides perfectly clear options with reasoning

User request context:
{scenario_input}

Conversation:
{generation}

Return only the score (1-5) followed by a brief explanation."""

CHECK_TYPE = "score"
