import {
  SUPPORTED_FILE_TYPES,
  isSupportedFileType,
  getContentType
} from '../../utils/fileProcessor';

describe('fileProcessor utils', () => {
  describe('SUPPORTED_FILE_TYPES', () => {
    it('should include common document types', () => {
      expect(SUPPORTED_FILE_TYPES).toContain('txt');
      expect(SUPPORTED_FILE_TYPES).toContain('pdf');
      expect(SUPPORTED_FILE_TYPES).toContain('docx');
      expect(SUPPORTED_FILE_TYPES).toContain('xlsx');
      expect(SUPPORTED_FILE_TYPES).toContain('csv');
    });

    it('should include image types', () => {
      expect(SUPPORTED_FILE_TYPES).toContain('jpg');
      expect(SUPPORTED_FILE_TYPES).toContain('png');
      expect(SUPPORTED_FILE_TYPES).toContain('gif');
      expect(SUPPORTED_FILE_TYPES).toContain('webp');
    });

    it('should include video types', () => {
      expect(SUPPORTED_FILE_TYPES).toContain('mp4');
      expect(SUPPORTED_FILE_TYPES).toContain('mov');
      expect(SUPPORTED_FILE_TYPES).toContain('webm');
    });
  });

  describe('isSupportedFileType', () => {
    it('should return true for supported extensions', () => {
      expect(isSupportedFileType('document.pdf')).toBe(true);
      expect(isSupportedFileType('image.jpg')).toBe(true);
      expect(isSupportedFileType('video.mp4')).toBe(true);
      expect(isSupportedFileType('file.txt')).toBe(true);
      expect(isSupportedFileType('data.csv')).toBe(true);
    });

    it('should return true for csv mime types', () => {
      expect(isSupportedFileType('file.unknown', 'text/csv')).toBe(true);
      expect(isSupportedFileType('file.unknown', 'application/csv')).toBe(true);
      expect(isSupportedFileType('file.unknown', 'application/vnd.ms-excel')).toBe(true);
    });

    it('should return true for uppercase extensions', () => {
      expect(isSupportedFileType('document.PDF')).toBe(true);
      expect(isSupportedFileType('image.JPG')).toBe(true);
    });

    it('should return false for unsupported extensions without mime type', () => {
      expect(isSupportedFileType('file.xyz')).toBe(false);
      expect(isSupportedFileType('file.unknown')).toBe(false);
    });

    it('should return true for image/* mime types regardless of extension', () => {
      expect(isSupportedFileType('file.unknown', 'image/custom')).toBe(true);
      expect(isSupportedFileType('file.xyz', 'image/png')).toBe(true);
    });

    it('should return true for video/* mime types regardless of extension', () => {
      expect(isSupportedFileType('file.unknown', 'video/custom')).toBe(true);
      expect(isSupportedFileType('file.xyz', 'video/mp4')).toBe(true);
    });

    it('should check mime type mapping for supported types', () => {
      expect(isSupportedFileType('file.unknown', 'application/pdf')).toBe(true);
      expect(isSupportedFileType('file.unknown', 'text/plain')).toBe(true);
      expect(isSupportedFileType('file.unknown', 'text/html')).toBe(true);
    });

    it('should return false for unsupported mime types', () => {
      expect(isSupportedFileType('file.unknown', 'application/unknown')).toBe(false);
    });

    it('should handle files without extension', () => {
      expect(isSupportedFileType('filename')).toBe(false);
      expect(isSupportedFileType('filename', 'application/pdf')).toBe(true);
    });

    it('should handle filename with no dot returning empty extension', () => {
      // This tests the || '' fallback on line 65
      expect(isSupportedFileType('nodotfile')).toBe(false);
    });

    it('should call getFileTypeFromMime with undefined and return unknown', () => {
      // Test file with unsupported extension and mime type that maps to unknown
      expect(isSupportedFileType('file.xyz', 'application/x-unknown-type')).toBe(false);
    });

    it('should handle filename ending with dot (empty extension, covers || "" branch)', () => {
      expect(isSupportedFileType('file.')).toBe(false);
    });

    it('should return true for dot-terminated filename when mime type is supported', () => {
      expect(isSupportedFileType('file.', 'application/pdf')).toBe(true);
    });

    it('should support all office document mime types', () => {
      expect(isSupportedFileType('file.unknown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
      expect(isSupportedFileType('file.unknown', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true);
      expect(isSupportedFileType('file.unknown', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    });
  });

  describe('getContentType', () => {
    it('should return provided mime type if available', () => {
      expect(getContentType('file.txt', 'text/plain')).toBe('text/plain');
      expect(getContentType('file.unknown', 'application/custom')).toBe('application/custom');
    });

    it('should derive content type from extension when mime type not provided', () => {
      expect(getContentType('file.txt')).toBe('text/plain');
      expect(getContentType('file.pdf')).toBe('application/pdf');
      expect(getContentType('file.jpg')).toBe('image/jpeg');
      expect(getContentType('file.jpeg')).toBe('image/jpeg');
      expect(getContentType('file.png')).toBe('image/png');
      expect(getContentType('file.gif')).toBe('image/gif');
    });

    it('should return content types for html files', () => {
      expect(getContentType('file.html')).toBe('text/html');
      expect(getContentType('file.htm')).toBe('text/html');
    });

    it('should return content type for csv files', () => {
      expect(getContentType('file.csv')).toBe('text/csv');
    });

    it('should return content types for office documents', () => {
      expect(getContentType('file.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(getContentType('file.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(getContentType('file.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    });

    it('should return content types for video files', () => {
      expect(getContentType('file.mp4')).toBe('video/mp4');
      expect(getContentType('file.mov')).toBe('video/quicktime');
      expect(getContentType('file.webm')).toBe('video/webm');
      expect(getContentType('file.ogg')).toBe('video/ogg');
      expect(getContentType('file.avi')).toBe('video/x-msvideo');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(getContentType('file.unknown')).toBe('application/octet-stream');
      expect(getContentType('file.xyz')).toBe('application/octet-stream');
    });

    it('should handle files without extension', () => {
      expect(getContentType('filename')).toBe('application/octet-stream');
    });

    it('should handle filename with no dot returning empty extension', () => {
      // This tests the || '' fallback on line 88
      expect(getContentType('nodotfile')).toBe('application/octet-stream');
    });

    it('should return content types for all image types', () => {
      expect(getContentType('file.webp')).toBe('image/webp');
      expect(getContentType('file.bmp')).toBe('image/bmp');
      expect(getContentType('file.svg')).toBe('image/svg+xml');
    });

    it('should return content type for xlsm files', () => {
      expect(getContentType('file.xlsm')).toBe('application/vnd.ms-excel.sheet.macroEnabled.12');
    });

    it('should return content type for m4v files', () => {
      expect(getContentType('file.m4v')).toBe('video/x-m4v');
    });

    it('should handle filename ending with dot (empty extension, covers || "" branch)', () => {
      expect(getContentType('file.')).toBe('application/octet-stream');
    });
  });
});
