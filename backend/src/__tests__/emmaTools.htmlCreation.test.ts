/**
 * ENG-2103 F2 — proves emma/tools.ts's create_html_file/create_html_template
 * tool execute() bodies call emma/impl/htmlCreation.ts directly (not
 * agentModeService.<method>) and forward args unchanged. Same pattern as
 * emmaTools.leads.test.ts / emmaTools.brandMarketStrategy.test.ts /
 * emmaTools.mediaVideo.test.ts.
 */

jest.mock('../emma/impl/htmlCreation', () => ({
  createHtmlFile: jest.fn(),
  createHtmlTemplate: jest.fn(),
}));

const HTML_CREATION_CLUSTER_METHODS = ['createHtmlFile', 'createHtmlTemplate'];

// agentModeService.<htmlCreationClusterMethod> must NOT be called by these 2
// tools anymore. updateHtmlFile and createHtmlFromTemplate are NOT part of
// this cluster and stay on agentModeService, so the proxy below only throws
// for the 2 names this cluster owns.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        if (HTML_CREATION_CLUSTER_METHODS.includes(String(prop))) {
          return () => {
            throw new Error(`agentModeService.${String(prop)} should not be called by the createHtmlFile/createHtmlTemplate cluster after ENG-2103 F2`);
          };
        }
        return jest.fn().mockResolvedValue({ success: true });
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as htmlCreationImpl from '../emma/impl/htmlCreation';
import '../emma/tools';

const mockHtmlCreation = htmlCreationImpl as jest.Mocked<typeof htmlCreationImpl>;

describe('createHtmlFile/createHtmlTemplate cluster delegates to emma/impl/htmlCreation.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create_html_file forwards args and defaults document_type to "document"', async () => {
    const expected = { success: true, s3_url: 'https://s3/doc.html' };
    mockHtmlCreation.createHtmlFile.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('create_html_file')!.execute(
      { title: 'Weekly Report', content_draft: 'Full report body', format_requirements: 'Use brand colors' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockHtmlCreation.createHtmlFile).toHaveBeenCalledWith(
      'Weekly Report', 'Full report body', 'Use brand colors', 'u1', 's1', 'document'
    );
    expect(result).toBe(expected);
  });

  it('create_html_file forwards document_type "email" and defaults format_requirements to empty string', async () => {
    const expected = { success: true, s3_url: 'https://s3/email.html' };
    mockHtmlCreation.createHtmlFile.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('create_html_file')!.execute(
      { title: 'Newsletter', content_draft: 'Newsletter content', document_type: 'email' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockHtmlCreation.createHtmlFile).toHaveBeenCalledWith(
      'Newsletter', 'Newsletter content', '', 'u1', 's1', 'email'
    );
    expect(result).toBe(expected);
  });

  it('create_html_template forwards all args in createHtmlTemplate’s parameter order', async () => {
    const expected = { success: true, template_id: 'tpl_1' };
    mockHtmlCreation.createHtmlTemplate.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('create_html_template')!.execute(
      {
        html_source: '<html></html>', template_id: 'tpl_1', template_name: 'welcome_email',
        subject: 'Welcome!', additional_instructions: 'Add a CTA', types: ['email'],
      },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockHtmlCreation.createHtmlTemplate).toHaveBeenCalledWith(
      '<html></html>', 'tpl_1', 'welcome_email', 'Welcome!', 'Add a CTA', 'u1', 's1', ['email']
    );
    expect(result).toBe(expected);
  });

  it('create_html_template defaults additional_instructions to empty string when omitted', async () => {
    mockHtmlCreation.createHtmlTemplate.mockResolvedValue({ success: true });

    await emmaToolRegistry.getTool('create_html_template')!.execute(
      { html_source: '<html></html>', template_name: 'welcome_email' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockHtmlCreation.createHtmlTemplate).toHaveBeenCalledWith(
      '<html></html>', undefined, 'welcome_email', undefined, '', 'u1', 's1', undefined
    );
  });
});
