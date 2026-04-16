import { scoreSession } from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

describe('SessionScoring - Content Formatting vs Chat Response Formatting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should NOT penalize assistant for using HTML in chat responses when generating plain text content', async () => {
    // Mock LLM response - should score high because Emma correctly generated plain text LinkedIn post
    mockCallLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 5,
              reason: 'Assistant correctly generated a plain text LinkedIn post as requested. The HTML formatting in the chat response was for presentation purposes only and is appropriate.',
            }),
          },
        },
      ],
    } as any);

    const messages = [
      {
        role: 'user',
        content: 'Create a LinkedIn post about AI trends with no markdown and plain text only formatting',
      },
      {
        role: 'assistant',
        content: `<strong>Here's your LinkedIn post:</strong>

<p>AI is transforming industries at an unprecedented pace. From healthcare to finance, machine learning algorithms are revolutionizing how we work and live.</p>

<p>Three key trends to watch:</p>
<ul>
<li>Generative AI tools becoming mainstream</li>
<li>AI ethics and governance frameworks</li>
<li>Edge AI for real-time processing</li>
</ul>

<p>The post content (without HTML tags):</p>

<pre>AI is transforming industries at an unprecedented pace. From healthcare to finance, machine learning algorithms are revolutionizing how we work and live.

Three key trends to watch:

• Generative AI tools becoming mainstream
• AI ethics and governance frameworks
• Edge AI for real-time processing</pre>`,
      },
    ];

    const result = await scoreSession(messages as ChatMessage[], 2);

    // Verify the scoring system was called with the correct prompt
    expect(mockCallLLM).toHaveBeenCalledWith(
      'gemini-3.1-flash-lite-preview',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
      expect.objectContaining({
        temperature: 0,
        max_completion_tokens: 200,
        response_format: { type: 'json_object' },
      })
    );

    // Verify the system prompt includes the clarifications
    const systemMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'system');
    expect(systemMessage.content).toContain('Distinguish between content formatting and chat response formatting');
    expect(systemMessage.content).toContain('GENERATED CONTENT');
    expect(systemMessage.content).toContain('assistant can use HTML tags');
    expect(systemMessage.content).toContain('Tool calls and generated content');

    // Verify result
    expect(result.score).toBe(5);
    expect(result.reason).toContain('correctly generated a plain text LinkedIn post');
  });

  it('should penalize assistant if the GENERATED CONTENT has markdown when plain text was requested', async () => {
    // Mock LLM response - should score low because the actual post content has markdown
    mockCallLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 2,
              reason: 'Assistant failed to generate plain text content - the LinkedIn post contains markdown formatting (**bold**, bullet points with *) when user explicitly requested "no markdown and plain text only".',
            }),
          },
        },
      ],
    } as any);

    const messages = [
      {
        role: 'user',
        content: 'Create a LinkedIn post about AI trends with no markdown and plain text only formatting',
      },
      {
        role: 'assistant',
        content: `Here's your LinkedIn post:

**AI is transforming industries** at an unprecedented pace.

Key trends:
* Generative AI tools becoming mainstream
* AI ethics and governance frameworks
* Edge AI for real-time processing`,
      },
    ];

    const result = await scoreSession(messages as ChatMessage[], 2);

    expect(result.score).toBe(2);
    expect(result.reason).toContain('failed to generate plain text content');
    expect(result.reason).toContain('markdown');
  });

  it('should score high when user does not specify formatting and assistant uses HTML in responses', async () => {
    // Mock LLM response - should score high because no special formatting was requested
    mockCallLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 5,
              reason: 'Assistant provided excellent help with market research. HTML formatting in the response enhanced readability.',
            }),
          },
        },
      ],
    } as any);

    const messages = [
      {
        role: 'user',
        content: 'Help me research AI market trends',
      },
      {
        role: 'assistant',
        content: `<strong>AI Market Research Summary:</strong>

<ul>
<li><strong>Market Size:</strong> Expected to reach $1.5T by 2030</li>
<li><strong>Key Players:</strong> OpenAI, Google, Microsoft, Anthropic</li>
<li><strong>Growth Drivers:</strong> Enterprise adoption, regulatory frameworks</li>
</ul>`,
      },
    ];

    const result = await scoreSession(messages as ChatMessage[], 2);

    expect(result.score).toBe(5);
    expect(result.reason).toContain('excellent');
  });

  it('should handle edge case: user asks for plain text email content', async () => {
    // Mock LLM response - should understand this is about email CONTENT, not chat format
    mockCallLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 5,
              reason: 'Assistant correctly generated a plain text email as requested. The HTML formatting in the chat response was appropriate for presenting the email content.',
            }),
          },
        },
      ],
    } as any);

    const messages = [
      {
        role: 'user',
        content: 'Draft a plain text email to our customers about the product update',
      },
      {
        role: 'assistant',
        content: `<strong>Plain Text Email Draft:</strong>

<pre>Subject: Exciting Product Updates Coming Your Way

Hi there,

We're thrilled to announce several new features coming to our product next month. These updates are based on your valuable feedback.

Key improvements:
- Faster load times
- New analytics dashboard
- Enhanced security features

Thank you for being a valued customer!

Best regards,
The Team</pre>

<p>This email is formatted in plain text as requested - no HTML tags or formatting in the actual email content.</p>`,
      },
    ];

    const result = await scoreSession(messages as ChatMessage[], 2);

    expect(result.score).toBe(5);
    expect(result.reason).toContain('correctly generated a plain text email');
  });

  it('should evaluate tool call parameters to verify generated content meets requirements', async () => {
    // Mock LLM response - should score high because tool parameters contain plain text content
    mockCallLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 5,
              reason: 'Assistant successfully created plain text LinkedIn posts. The tool call parameters show the posts are in plain text format without markdown, meeting the user requirements. The file URL is standard tool output.',
            }),
          },
        },
      ],
    } as any);

    const messages = [
      {
        role: 'user',
        content: 'Create 3 LinkedIn posts about AI trends with no markdown and plain text only formatting',
      },
      {
        role: 'assistant',
        content: `Function call: create_social_media_posts
Parameters: {"posts": [{"platform": "linkedin", "content": "AI is transforming industries at an unprecedented pace. Three trends to watch:\n\n• Generative AI in enterprise\n• Edge computing for real-time AI\n• Ethical AI frameworks"}]}`,
      },
      {
        role: 'assistant',
        content: `<p>✅ Created 3 LinkedIn posts successfully!</p>

<p>View your posts here: <a href="https://agentweb-files.s3.us-east-1.amazonaws.com/social-posts-12345.html" target="_blank">LinkedIn Posts</a></p>

<p>All posts use plain text formatting without markdown as requested.</p>`,
      },
    ];

    const result = await scoreSession(messages as ChatMessage[], 3);

    expect(result.score).toBe(5);
    expect(result.reason).toContain('plain text');
  });
});
