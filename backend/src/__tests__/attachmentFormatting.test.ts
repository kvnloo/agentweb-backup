import { getAttachmentHint, formatAttachmentLine, formatAttachmentUrls } from '../utils/attachmentFormatting';

describe('attachmentFormatting', () => {
  describe('getAttachmentHint', () => {
    it('image hint steers toward video frames AND describe_image', () => {
      const hint = getAttachmentHint('image/png', 'photo.png');
      // Must guide Emma to use the image as a video frame
      expect(hint).toContain('startFrame');
      expect(hint).toContain('endFrame');
      expect(hint).toContain('generate_video');
      // Must still offer describe_image for plain analysis
      expect(hint).toContain('describe_image');
      // Leading space so it appends cleanly after the markdown link
      expect(hint.startsWith(' ')).toBe(true);
    });

    it('detects image by extension when mimetype is missing', () => {
      const hint = getAttachmentHint('', 'logo.WEBP');
      expect(hint).toContain('startFrame');
    });

    it('video hint steers toward describe_video', () => {
      const hint = getAttachmentHint('video/mp4', 'clip.mp4');
      expect(hint).toContain('describe_video');
      expect(hint).not.toContain('startFrame');
    });

    it('document hint steers toward read_file_content', () => {
      const hint = getAttachmentHint('application/pdf', 'report.pdf');
      expect(hint).toContain('read_file_content');
      expect(hint).not.toContain('startFrame');
    });
  });

  describe('formatAttachmentLine', () => {
    it('builds a markdown link with the image hint', () => {
      const line = formatAttachmentLine({ filename: 'a.png', url: 'https://x/a.png', mimetype: 'image/png' });
      expect(line).toContain('[a.png](https://x/a.png)');
      expect(line).toContain('startFrame');
    });

    it('falls back to "Attachment" when filename is missing', () => {
      const line = formatAttachmentLine({ url: 'https://x/a.png', mimetype: 'image/png' });
      expect(line).toContain('[Attachment](https://x/a.png)');
    });
  });

  describe('formatAttachmentUrls', () => {
    it('joins multiple attachments with newlines', () => {
      const out = formatAttachmentUrls([
        { filename: 'a.png', url: 'https://x/a.png', mimetype: 'image/png' },
        { filename: 'b.pdf', url: 'https://x/b.pdf', mimetype: 'application/pdf' },
      ]);
      expect(out.split('\n')).toHaveLength(2);
      expect(out).toContain('[a.png](https://x/a.png)');
      expect(out).toContain('[b.pdf](https://x/b.pdf)');
    });
  });
});
