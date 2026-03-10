import { isAllowedUploadType } from '../utils/s3Utils';

describe('File upload validation — XSS prevention', () => {
  // --- FAIL TESTS ---

  it('should reject text/html files (XSS vector)', () => {
    expect(isAllowedUploadType('page.html', 'text/html')).toBe(false);
  });

  it('should reject application/javascript files', () => {
    expect(isAllowedUploadType('script.js', 'application/javascript')).toBe(false);
  });

  it('should reject files with dangerous extensions even if MIME is spoofed', () => {
    // .html file claiming to be image/png
    expect(isAllowedUploadType('malicious.html', 'image/png')).toBe(false);
    // .js file claiming to be text/plain
    expect(isAllowedUploadType('hack.js', 'text/plain')).toBe(false);
    // .svg file (can contain script tags)
    expect(isAllowedUploadType('icon.svg', 'image/svg+xml')).toBe(false);
  });

  it('should reject executable and uncommon MIME types', () => {
    expect(isAllowedUploadType('app.exe', 'application/x-executable')).toBe(false);
    expect(isAllowedUploadType('app.exe', 'application/x-msdownload')).toBe(false);
    expect(isAllowedUploadType('file.bat', 'application/x-bat')).toBe(false);
    expect(isAllowedUploadType('file.php', 'application/x-httpd-php')).toBe(false);
  });

  // --- SUCCESS TESTS ---

  it('should allow common image types', () => {
    expect(isAllowedUploadType('photo.jpg', 'image/jpeg')).toBe(true);
    expect(isAllowedUploadType('photo.png', 'image/png')).toBe(true);
    expect(isAllowedUploadType('photo.gif', 'image/gif')).toBe(true);
    expect(isAllowedUploadType('photo.webp', 'image/webp')).toBe(true);
  });

  it('should allow common document and media types', () => {
    expect(isAllowedUploadType('doc.pdf', 'application/pdf')).toBe(true);
    expect(isAllowedUploadType('doc.txt', 'text/plain')).toBe(true);
    expect(isAllowedUploadType('doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(isAllowedUploadType('video.mp4', 'video/mp4')).toBe(true);
    expect(isAllowedUploadType('video.webm', 'video/webm')).toBe(true);
    expect(isAllowedUploadType('data.csv', 'text/csv')).toBe(true);
    expect(isAllowedUploadType('data.json', 'application/json')).toBe(true);
  });
});
