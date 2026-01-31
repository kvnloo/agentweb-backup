describe('ChatbotDB - URL extraction from HTML content', () => {
  it('should extract image URL from HTML content', () => {
    const htmlContent = '<strong>Generated image:</strong> <img src="https://example.s3.amazonaws.com/images/test-image.png" alt="Generated" />';

    // URL extraction regex from repair logic
    const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
    const matches = htmlContent.match(urlRegex);

    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://example.s3.amazonaws.com/images/test-image.png');
  });

  it('should extract video URL from HTML content', () => {
    const htmlContent = '<p>Video generated: https://storage.googleapis.com/videos/output.mp4</p>';

    const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
    const matches = htmlContent.match(urlRegex);

    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://storage.googleapis.com/videos/output.mp4');
  });

  it('should extract URL from JSON string', () => {
    const jsonContent = JSON.stringify({
      success: true,
      imageUrl: 'https://test.s3.amazonaws.com/path/to/image.jpg',
      filename: 'image.jpg'
    });

    const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
    const matches = jsonContent.match(urlRegex);

    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://test.s3.amazonaws.com/path/to/image.jpg');
  });

  it('should extract first URL when multiple URLs exist', () => {
    const content = 'Found images: https://s3.amazonaws.com/img1.png and https://s3.amazonaws.com/img2.png';

    const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
    const matches = content.match(urlRegex);

    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(2);
    expect(matches![0]).toBe('https://s3.amazonaws.com/img1.png');
  });

  it('should return null for content without URLs', () => {
    const content = 'No URLs here, just plain text';

    const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
    const matches = content.match(urlRegex);

    expect(matches).toBeNull();
  });

  it('should extract URL with query parameters', () => {
    const content = 'Image URL: https://s3.amazonaws.com/bucket/image.png?v=123&auth=abc';

    const urlRegex = /https?:\/\/[^\s<>"]+?\.(png|jpg|jpeg|gif|webp|mp4|mov|avi|webm)/gi;
    const matches = content.match(urlRegex);

    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe('https://s3.amazonaws.com/bucket/image.png');
  });
});
