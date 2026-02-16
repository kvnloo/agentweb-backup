import { AgentModeService } from '../services/agentModeService';
import { taskTemplateDb } from '../services/db';

// Mock dependencies
jest.mock('../services/db', () => ({
  taskTemplateDb: {
    getPublishedTemplates: jest.fn()
  }
}));

const mockedTaskTemplateDb = taskTemplateDb as jest.Mocked<typeof taskTemplateDb>;

describe('AgentModeService - listTaskTemplates', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  const mockTemplates = [
    {
      templateId: 'tmpl-1',
      name: 'SEO Analysis',
      description: 'Analyze website SEO',
      category: 'SEO',
      parameters: ['site_url'],
      prompt: 'Analyze SEO for {{site_url}}'
    },
    {
      templateId: 'tmpl-2',
      name: 'Competitor Research',
      description: 'Research competitors',
      category: 'Research',
      parameters: [{ name: 'competitor_url', id: 'competitor_url' }],
      prompt: 'Research {{competitor_url}}'
    },
    {
      templateId: 'tmpl-3',
      name: 'SEO Audit',
      description: 'Full SEO audit',
      category: 'SEO',
      parameters: ['site_url', 'depth'],
      prompt: 'Audit {{site_url}}'
    }
  ];

  it('should return formatted templates grouped by category', async () => {
    mockedTaskTemplateDb.getPublishedTemplates.mockResolvedValue(mockTemplates as any);

    const result = await agentModeService.listTaskTemplates();

    expect(result.success).toBe(true);
    expect(result.totalTemplates).toBe(3);
    expect(result.templates_by_category).toBeDefined();
    expect(result.templates_by_category['SEO']).toHaveLength(2);
    expect(result.templates_by_category['Research']).toHaveLength(1);

    // Check template format
    const seoTemplate = result.templates_by_category['SEO'][0];
    expect(seoTemplate.template_id).toBe('tmpl-1');
    expect(seoTemplate.name).toBe('SEO Analysis');
    expect(seoTemplate.description).toBe('Analyze website SEO');
    expect(seoTemplate.category).toBe('SEO');
    expect(seoTemplate.parameters).toEqual(['site_url']);
  });

  it('should extract parameter names from object parameters', async () => {
    mockedTaskTemplateDb.getPublishedTemplates.mockResolvedValue(mockTemplates as any);

    const result = await agentModeService.listTaskTemplates();

    const researchTemplate = result.templates_by_category['Research'][0];
    expect(researchTemplate.parameters).toEqual(['competitor_url']);
  });

  it('should return empty result when no templates available', async () => {
    mockedTaskTemplateDb.getPublishedTemplates.mockResolvedValue([]);

    const result = await agentModeService.listTaskTemplates();

    expect(result.success).toBe(true);
    expect(result.totalTemplates).toBe(0);
    expect(result.templates).toEqual([]);
    expect(result.message).toBe('No templates are currently available.');
  });

  it('should return error when getAvailableTemplates fails', async () => {
    mockedTaskTemplateDb.getPublishedTemplates.mockRejectedValue(new Error('DB connection failed'));

    const result = await agentModeService.listTaskTemplates();

    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to list task templates');
    expect(result.error).toBe('DB connection failed');
  });

  it('should filter out templates with empty categories', async () => {
    const templatesWithEmpty = [
      ...mockTemplates,
      {
        templateId: 'tmpl-4',
        name: 'No Category',
        description: 'Template without category',
        category: '',
        parameters: [],
        prompt: 'test'
      }
    ];
    mockedTaskTemplateDb.getPublishedTemplates.mockResolvedValue(templatesWithEmpty as any);

    const result = await agentModeService.listTaskTemplates();

    // The empty-category template should be filtered out by getAvailableTemplates
    expect(result.totalTemplates).toBe(3);
  });
});
