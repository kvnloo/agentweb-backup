/**
 * Scan a list of chat messages and extract asset URLs (images, videos, HTML reports).
 * Pure utility with no external dependencies — safe to import from any module.
 */
export function scanMessagesForAssets(
  messages: any[],
  session: { updatedAt?: string; createdAt?: string }
): {
  images: Array<{ url: string; filename: string; generatedAt: string }>;
  videos: Array<{ url: string; filename: string; generatedAt: string }>;
  htmlReports: Array<{ url: string; filename: string; generatedAt: string }>;
} {
  const images: Array<{ url: string; filename: string; generatedAt: string }> = [];
  const videos: Array<{ url: string; filename: string; generatedAt: string }> = [];
  const htmlReports: Array<{ url: string; filename: string; generatedAt: string }> = [];

  const htmlUrlRegex = /(https?:\/\/[^\s"]+\.amazonaws\.com\/[^\s"]+\.html)/gi;
  const seenUrls = new Set<string>();

  let lastAssistantTimestamp: string | undefined;

  for (const message of messages) {
    const ownTimestamp = message.timestamp || message.metadata?.timestamp;

    if (message.role === 'assistant' && ownTimestamp) {
      lastAssistantTimestamp = ownTimestamp;
    }

    const timestamp = ownTimestamp || lastAssistantTimestamp || session.updatedAt || session.createdAt;

    // ENG-510: a per-image marker persisted the moment each image completes (before the
    // end-of-turn toolCalls stamp). It is the only surviving record if the whole-turn cap
    // kills the turn mid-flight, so completed images are still delivered. De-duped by URL
    // against the toolCalls stamp below, so a normally-completed image is listed once.
    const marker = message.metadata;
    if (marker?.kind === 'image-generated' && marker?.imageUrl && !seenUrls.has(marker.imageUrl)) {
      seenUrls.add(marker.imageUrl);
      images.push({ url: marker.imageUrl, filename: marker.imageFilename || 'generated-image.png', generatedAt: timestamp });
    }

    if (!message.metadata?.toolCalls) {
      if (typeof message.content === 'string') {
        htmlUrlRegex.lastIndex = 0;
        let match;
        while ((match = htmlUrlRegex.exec(message.content)) !== null) {
          const url = match[1];
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            htmlReports.push({ url, filename: url.split('/').pop() || 'report.html', generatedAt: timestamp });
          }
        }
      }
      continue;
    }

    for (const toolCall of message.metadata.toolCalls) {
      if ((toolCall.name === 'generate_image' || toolCall.name === 'upload_image') && toolCall.result?.success && toolCall.result?.imageUrl) {
        const url = toolCall.result.imageUrl;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          images.push({ url, filename: toolCall.result.filename || 'generated-image.png', generatedAt: timestamp });
        }
      }

      if ((toolCall.name === 'generate_video' || toolCall.name === 'upload_video') && toolCall.result?.success && toolCall.result?.videoUrl) {
        const url = toolCall.result.videoUrl;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          videos.push({ url, filename: toolCall.result.filename || 'generated-video.mp4', generatedAt: timestamp });
        }
      }

      const toolResult = toolCall?.result || {};
      const urlCandidates = [
        toolResult.s3_url,
        toolResult.file_url,
        toolResult.htmlUrl,
        toolResult.blog_html_url,
      ].filter(Boolean);

      for (const url of urlCandidates) {
        if ((url.toLowerCase().endsWith('.html') || url.toLowerCase().endsWith('.htm')) && !seenUrls.has(url)) {
          seenUrls.add(url);
          htmlReports.push({
            url,
            filename: toolResult.filename || toolResult.file_name || toolResult.versioned_filename || url.split('/').pop() || 'report.html',
            generatedAt: timestamp,
          });
        }
      }
    }

    if (typeof message.content === 'string') {
      htmlUrlRegex.lastIndex = 0;
      let match;
      while ((match = htmlUrlRegex.exec(message.content)) !== null) {
        const url = match[1];
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          htmlReports.push({ url, filename: url.split('/').pop() || 'report.html', generatedAt: timestamp });
        }
      }
    }
  }

  return { images, videos, htmlReports };
}
