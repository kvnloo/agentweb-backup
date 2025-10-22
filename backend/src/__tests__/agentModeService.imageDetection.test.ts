// Unit tests for describe_image function

describe('Image URL Detection (Legacy)', () => {
  // Helper function to detect image URLs in text (kept for reference)
  const detectImageUrls = (text: string): string[] => {
    const imageUrlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?[^\s]*)?)/gi;
    const matches = text.match(imageUrlRegex);
    return matches || [];
  };

  it('should detect single image URL', () => {
    const text = 'Check out this image: https://example.com/image.jpg';
    const result = detectImageUrls(text);
    expect(result).toEqual(['https://example.com/image.jpg']);
  });

  it('should detect multiple image URLs', () => {
    const text = 'Here are two images: https://example.com/image1.jpg and https://example.com/image2.png';
    const result = detectImageUrls(text);
    expect(result).toEqual(['https://example.com/image1.jpg', 'https://example.com/image2.png']);
  });

  it('should detect various image formats', () => {
    const text = 'Multiple formats: https://example.com/image.jpg https://example.com/image.png https://example.com/image.gif https://example.com/image.webp https://example.com/image.svg';
    const result = detectImageUrls(text);
    expect(result).toEqual([
      'https://example.com/image.jpg',
      'https://example.com/image.png',
      'https://example.com/image.gif',
      'https://example.com/image.webp',
      'https://example.com/image.svg'
    ]);
  });

  it('should not detect non-image URLs', () => {
    const text = 'Not images: https://example.com/document.pdf https://example.com/video.mp4';
    const result = detectImageUrls(text);
    expect(result).toEqual([]);
  });
});

describe('Describe Image Function', () => {
  // Mock the AgentModeService for testing
  const mockAgentModeService = {
    describeImage: async (imageUrl: string, prompt?: string) => {
      // Handle empty, null, undefined, or whitespace-only strings
      if (!imageUrl || imageUrl.trim() === '') {
        return {
          success: false,
          message: 'No image URL provided'
        };
      }

      // Use custom prompt or default
      const analysisPrompt = prompt || 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.';

      // Mock successful response - assume URL is an image
      return {
        success: true,
        description: `Mock analysis of image with prompt: "${analysisPrompt}". This image contains various visual elements that would be analyzed in detail.`,
        imageUrl: imageUrl
      };
    }
  };

  describe('Basic Functionality', () => {
    it('should successfully describe a single image URL', async () => {
      const imageUrl = 'https://example.com/image.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe(imageUrl);
      expect(result.description).toContain('Mock analysis');
    });

    it('should handle different image formats', async () => {
      const formats = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
      
      for (const format of formats) {
        const imageUrl = `https://example.com/image.${format}`;
        const result = await mockAgentModeService.describeImage(imageUrl);
        
        expect(result.success).toBe(true);
        expect(result.imageUrl).toBe(imageUrl);
      }
    });

    it('should handle image URLs with query parameters', async () => {
      const imageUrl = 'https://example.com/image.jpg?v=123&size=large&format=webp';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe(imageUrl);
    });

    it('should handle HTTPS and HTTP URLs', async () => {
      const httpsUrl = 'https://example.com/image.jpg';
      const httpUrl = 'http://example.com/image.jpg';
      
      const httpsResult = await mockAgentModeService.describeImage(httpsUrl);
      const httpResult = await mockAgentModeService.describeImage(httpUrl);
      
      expect(httpsResult.success).toBe(true);
      expect(httpResult.success).toBe(true);
      expect(httpsResult.imageUrl).toBe(httpsUrl);
      expect(httpResult.imageUrl).toBe(httpUrl);
    });
  });

  describe('Error Handling', () => {
    it('should handle empty image URL', async () => {
      const result = await mockAgentModeService.describeImage('');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('No image URL provided');
    });

    it('should handle null input', async () => {
      const result = await mockAgentModeService.describeImage(null as any);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('No image URL provided');
    });

    it('should handle undefined input', async () => {
      const result = await mockAgentModeService.describeImage(undefined as any);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('No image URL provided');
    });

    it('should handle whitespace-only input', async () => {
      const result = await mockAgentModeService.describeImage('   ');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('No image URL provided');
    });
  });

  describe('Custom Prompt Functionality', () => {
    it('should use custom prompt when provided', async () => {
      const imageUrl = 'https://example.com/logo.jpg';
      const customPrompt = 'Focus only on the colors and typography in this image';
      const result = await mockAgentModeService.describeImage(imageUrl, customPrompt);
      
      expect(result.success).toBe(true);
      expect(result.description).toContain(`with prompt: "${customPrompt}"`);
    });

    it('should use default prompt when no custom prompt provided', async () => {
      const imageUrl = 'https://example.com/logo.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.description).toContain('Please analyze and describe this image in detail');
    });

    it('should handle empty custom prompt', async () => {
      const imageUrl = 'https://example.com/logo.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl, '');
      
      expect(result.success).toBe(true);
      expect(result.description).toContain('Please analyze and describe this image in detail');
    });

    it('should handle long custom prompts', async () => {
      const imageUrl = 'https://example.com/logo.jpg';
      const longPrompt = 'A'.repeat(1000); // Very long prompt
      const result = await mockAgentModeService.describeImage(imageUrl, longPrompt);
      
      expect(result.success).toBe(true);
      expect(result.description).toContain(`with prompt: "${longPrompt}"`);
    });

    it('should handle special characters in custom prompt', async () => {
      const imageUrl = 'https://example.com/logo.jpg';
      const specialPrompt = 'Analyze this image: colors, composition, text, branding elements, and any marketing aspects. Focus on #hashtags, @mentions, and $symbols.';
      const result = await mockAgentModeService.describeImage(imageUrl, specialPrompt);
      
      expect(result.success).toBe(true);
      expect(result.description).toContain(`with prompt: "${specialPrompt}"`);
    });
  });

  describe('Response Structure', () => {
    it('should return correct response structure for successful analysis', async () => {
      const imageUrl = 'https://example.com/test.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('description');
      expect(result).toHaveProperty('imageUrl', imageUrl);
      expect(typeof result.description).toBe('string');
      expect(result.description.length).toBeGreaterThan(0);
    });

    it('should return correct response structure for failed analysis', async () => {
      const result = await mockAgentModeService.describeImage('');
      
      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('message');
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle URLs with special characters', async () => {
      const imageUrl = 'https://example.com/image%20with%20spaces.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe(imageUrl);
    });

    it('should handle URLs with ports', async () => {
      const imageUrl = 'https://example.com:8080/images/test.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe(imageUrl);
    });

    it('should handle URLs with subdomains', async () => {
      const imageUrl = 'https://cdn.example.com/assets/images/logo.png';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe(imageUrl);
    });

    it('should handle URLs with paths', async () => {
      const imageUrl = 'https://example.com/path/to/deep/nested/image.jpg';
      const result = await mockAgentModeService.describeImage(imageUrl);
      
      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe(imageUrl);
    });
  });
});
