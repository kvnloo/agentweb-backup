import { AgentModeService } from '../services/agentModeService';

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: { update: jest.fn() }
}));

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('crypto', () => ({ createHash: jest.fn() }));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3WithPath: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/updated_file_v2.html',
    key: 'updated_file_v2.html'
  })
}));

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Conference Speakers</title></head>
<body>
  <h1 class="title">TEC2026 Speakers</h1>
  <div id="speakers-grid">
    <div class="speaker-card" data-speaker="alice">
      <div class="speaker-name">Alice Johnson</div>
      <div class="speaker-title">CTO, TechCorp</div>
      <div class="bio">Expert in AI &amp; ML</div>
      <img class="speaker-photo" src="alice.jpg" alt="Alice Johnson">
    </div>
    <div class="speaker-card" data-speaker="bob">
      <div class="speaker-name">Bob Smith</div>
      <div class="speaker-title">VP Engineering, DataCo</div>
      <div class="bio">Cloud infrastructure leader</div>
      <img class="speaker-photo" src="bob.jpg" alt="Bob Smith">
    </div>
    <div class="speaker-card" data-speaker="patrick">
      <div class="speaker-name">Patrick Bajari</div>
      <div class="speaker-title">Chief Economist, Amazon</div>
      <div class="bio">Economics &amp; ML research</div>
      <img class="speaker-photo" src="patrick.jpg" alt="Patrick Bajari">
    </div>
  </div>
  <footer>
    <p class="footer-text">TEC2026 Conference</p>
  </footer>
</body>
</html>`;

describe('updateHtmlFile CSS-selector operations', () => {
  let svc: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
    (svc as any).dynamoDB = {
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    } as any;

    const mockHash = { update: jest.fn().mockReturnThis(), digest: jest.fn().mockReturnValue('mock-hash-123') };
    require('crypto').createHash.mockReturnValue(mockHash);

    jest.spyOn(svc as any, 'fetchFileContent').mockResolvedValue(SAMPLE_HTML);
    jest.spyOn(svc as any, 'uploadUpdatedFile').mockResolvedValue({
      url: 'https://s3.amazonaws.com/bucket/file_v2.html'
    });
  });

  // ── Validation failures ──────────────────────────────────────────────

  describe('validation failures', () => {
    it('rejects non-array operations', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css', 'not-an-array', 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('At least one');
    });

    it('rejects empty operations array', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css', [], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('At least one');
    });

    it('rejects invalid action', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'destroy', selector: '.speaker-card' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid action');
    });

    it('rejects missing selector', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'remove' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('selector');
    });

    it('fails when selector matches nothing', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'remove', selector: '.nonexistent-class' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('operations failed');
    });

    it('rejects replace without html parameter', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'replace', selector: '.title' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('html is required');
    });

    it('rejects setAttribute without attribute/value', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'setAttribute', selector: 'img' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('attribute and value are required');
    });

    it('rejects removeAttribute without attribute', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'removeAttribute', selector: 'img' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('attribute is required');
    });
  });

  // ── Successful operations ────────────────────────────────────────────

  describe('remove action', () => {
    it('removes element matching selector', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'remove', selector: '.speaker-card[data-speaker="patrick"]' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.method).toBe('css_selector');
      expect(result.operations_applied).toBe(1);
      expect(result.updatedContent).not.toContain('Patrick Bajari');
      expect(result.updatedContent).toContain('Alice Johnson');
      expect(result.updatedContent).toContain('Bob Smith');
    });

    it('removes all matching elements when selector matches multiple', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'remove', selector: '.speaker-card' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).not.toContain('Alice Johnson');
      expect(result.updatedContent).not.toContain('Bob Smith');
      expect(result.updatedContent).not.toContain('Patrick Bajari');
    });
  });

  describe('replace action (outer HTML)', () => {
    it('replaces element outer HTML', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'replace', selector: 'h1.title', html: '<h1 class="title">New Conference</h1>' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).toContain('New Conference');
      expect(result.updatedContent).not.toContain('TEC2026 Speakers');
    });
  });

  describe('replaceInner action', () => {
    it('replaces element inner HTML while keeping outer tag', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'replaceInner', selector: '.speaker-card[data-speaker="bob"] .bio', html: 'Updated bio' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).toContain('Updated bio');
      expect(result.updatedContent).not.toContain('Cloud infrastructure leader');
      // Outer div.bio tag should still exist
      expect(result.updatedContent).toContain('class="bio"');
    });

    it('allows empty string to clear content', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'replaceInner', selector: '.speaker-card[data-speaker="bob"] .bio', html: '' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).not.toContain('Cloud infrastructure leader');
    });
  });

  describe('append action', () => {
    it('appends HTML inside element at the end', async () => {
      const newCard = '<div class="speaker-card" data-speaker="carol"><div class="speaker-name">Carol Williams</div></div>';
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'append', selector: '#speakers-grid', html: newCard }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).toContain('Carol Williams');
      const carolIdx = result.updatedContent.indexOf('Carol Williams');
      const patrickIdx = result.updatedContent.indexOf('Patrick Bajari');
      expect(carolIdx).toBeGreaterThan(patrickIdx);
    });
  });

  describe('prepend action', () => {
    it('prepends HTML inside element at the start', async () => {
      const newCard = '<div class="speaker-card" data-speaker="zara"><div class="speaker-name">Zara First</div></div>';
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'prepend', selector: '#speakers-grid', html: newCard }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).toContain('Zara First');
      const zaraIdx = result.updatedContent.indexOf('Zara First');
      const aliceIdx = result.updatedContent.indexOf('Alice Johnson');
      expect(zaraIdx).toBeLessThan(aliceIdx);
    });
  });

  describe('insertBefore action', () => {
    it('inserts HTML before target element', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'insertBefore', selector: '.speaker-card[data-speaker="bob"]', html: '<div class="divider">---</div>' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      const dividerIdx = result.updatedContent.indexOf('divider');
      const bobIdx = result.updatedContent.indexOf('Bob Smith');
      expect(dividerIdx).toBeLessThan(bobIdx);
    });
  });

  describe('insertAfter action', () => {
    it('inserts HTML after target element', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'insertAfter', selector: '.speaker-card[data-speaker="alice"]', html: '<div class="divider">---</div>' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      const aliceIdx = result.updatedContent.indexOf('Alice Johnson');
      const dividerIdx = result.updatedContent.indexOf('divider');
      const bobIdx = result.updatedContent.indexOf('Bob Smith');
      expect(dividerIdx).toBeGreaterThan(aliceIdx);
      expect(dividerIdx).toBeLessThan(bobIdx);
    });
  });

  describe('setAttribute action', () => {
    it('sets attribute on matching element', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'setAttribute', selector: '.speaker-card[data-speaker="alice"] img', attribute: 'src', value: 'alice-new.jpg' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).toContain('src="alice-new.jpg"');
      expect(result.updatedContent).not.toContain('src="alice.jpg"');
    });
  });

  describe('removeAttribute action', () => {
    it('removes attribute from matching element', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'removeAttribute', selector: '.speaker-card[data-speaker="alice"] img', attribute: 'alt' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.updatedContent).not.toContain('alt="Alice Johnson"');
      // Bob's alt should still be there
      expect(result.updatedContent).toContain('alt="Bob Smith"');
    });
  });

  // ── Multiple operations ──────────────────────────────────────────────

  describe('multiple operations', () => {
    it('applies multiple operations sequentially', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [
          { action: 'remove', selector: '.speaker-card[data-speaker="patrick"]' },
          { action: 'append', selector: '#speakers-grid', html: '<div class="speaker-card"><div class="speaker-name">Carol</div></div>' },
          { action: 'replaceInner', selector: 'h1.title', html: 'Updated Conference' }
        ], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.operations_applied).toBe(3);
      expect(result.updatedContent).not.toContain('Patrick Bajari');
      expect(result.updatedContent).toContain('Carol');
      expect(result.updatedContent).toContain('Updated Conference');
    });

    it('applies successful ops and skips failed ones when selector not found mid-sequence', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [
          { action: 'remove', selector: '.speaker-card[data-speaker="patrick"]' },
          { action: 'remove', selector: '.nonexistent' },
        ], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.operations_applied).toBe(1);
      expect(result.operations).toHaveLength(2);
      expect(result.operations[0].success).toBe(true);
      expect(result.operations[1].success).toBe(false);
      expect(result.message).toContain('1/2 operations');
      expect(result.updatedContent).not.toContain('Patrick Bajari');
    });
  });

  // ── Upload and versioning ────────────────────────────────────────────

  describe('upload and result', () => {
    it('uploads to S3 and returns versioned URL', async () => {
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'remove', selector: '.speaker-card[data-speaker="patrick"]' }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/file_v2.html');
      expect((svc as any).uploadUpdatedFile).toHaveBeenCalledTimes(1);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles fetchFileContent error gracefully', async () => {
      jest.spyOn(svc as any, 'fetchFileContent').mockRejectedValue(new Error('Network timeout'));
      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'css',
        [{ action: 'remove', selector: 'h1' }], 'u1', 's1'
      );
      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to update HTML file');
    });
  });

  // ── Backward compatibility ───────────────────────────────────────────

  describe('backward compatibility', () => {
    it('still supports update_type="full" with hash', async () => {
      const mockHash = { update: jest.fn().mockReturnThis(), digest: jest.fn().mockReturnValue('test-hash') };
      require('crypto').createHash.mockReturnValue(mockHash);

      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'full',
        [{ old_content_hash: 'test-hash', new_content: '<html>New</html>', expected_count: 1 }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
    });

    it('still supports update_type="part" with old_content', async () => {
      jest.spyOn(svc as any, 'performDirectReplacement').mockReturnValue({
        content: SAMPLE_HTML.replace('TEC2026 Speakers', 'New Title'),
        changeCount: 1
      });

      const result = await (svc as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html', 'part',
        [{ old_content: 'TEC2026 Speakers', new_content: 'New Title', expected_count: 1 }], 'u1', 's1'
      );
      expect(result.success).toBe(true);
    });
  });
});
