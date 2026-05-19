import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  companyDb,
  COMPANY_DEAL_STAGES,
  CompanyNotFoundError,
  CompanyAuthError,
} from '../services/companyDb';

const router = express.Router();
router.use(authenticateToken);

// GET /api/crm/companies
router.get('/', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const companies = await companyDb.listCompaniesByUser(authReq.user!.userId);
    res.json(companies);
  } catch (err) {
    console.error('listCompaniesByUser error:', err);
    res.status(500).json({ error: 'Failed to list companies' });
  }
});

// POST /api/crm/companies
router.post('/', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const userId = authReq.user!.userId;
    const { name, domain, industry, dealStage, dealValue, notes, website, linkedinUrl, employeeCount } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (dealStage && !(COMPANY_DEAL_STAGES as readonly string[]).includes(dealStage)) {
      res.status(400).json({ error: `invalid dealStage: ${dealStage}` });
      return;
    }

    const company = await companyDb.createCompany({
      userId,
      name,
      domain,
      industry,
      dealStage,
      dealValue,
      notes,
      website,
      linkedinUrl,
      employeeCount,
    });
    res.status(201).json(company);
  } catch (err) {
    console.error('createCompany error:', err);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// GET /api/crm/companies/:companyId
router.get('/:companyId', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { companyId } = req.params;
    const company = await companyDb.getCompany(companyId);
    if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
    if (company.userId !== authReq.user!.userId) { res.status(403).json({ error: 'Forbidden' }); return; }
    res.json(company);
  } catch (err) {
    console.error('getCompany error:', err);
    res.status(500).json({ error: 'Failed to get company' });
  }
});

// PATCH /api/crm/companies/:companyId
router.patch('/:companyId', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { companyId } = req.params;
    const userId = authReq.user!.userId;
    const { dealStage } = req.body;

    if (dealStage !== undefined && dealStage !== null && !(COMPANY_DEAL_STAGES as readonly string[]).includes(dealStage)) {
      res.status(400).json({ error: `invalid dealStage: ${dealStage}` });
      return;
    }

    const updated = await companyDb.updateCompany(companyId, userId, req.body);
    res.json(updated);
  } catch (err) {
    if (err instanceof CompanyNotFoundError) { res.status(404).json({ error: (err as Error).message }); return; }
    if (err instanceof CompanyAuthError) { res.status(403).json({ error: (err as Error).message }); return; }
    console.error('updateCompany error:', err);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// DELETE /api/crm/companies/:companyId
router.delete('/:companyId', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { companyId } = req.params;
    await companyDb.deleteCompany(companyId, authReq.user!.userId);
    res.status(204).send();
  } catch (err) {
    if (err instanceof CompanyNotFoundError) { res.status(404).json({ error: (err as Error).message }); return; }
    if (err instanceof CompanyAuthError) { res.status(403).json({ error: (err as Error).message }); return; }
    console.error('deleteCompany error:', err);
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

// GET /api/crm/companies/:companyId/leads
router.get('/:companyId/leads', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { companyId } = req.params;
    const userId = authReq.user!.userId;
    const company = await companyDb.getCompany(companyId);
    if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
    if (company.userId !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }
    const leads = await companyDb.getLeadsByCompanyId(companyId);
    res.json(leads);
  } catch (err) {
    console.error('getLeadsByCompanyId error:', err);
    res.status(500).json({ error: 'Failed to get company leads' });
  }
});

// POST /api/crm/companies/:companyId/leads  — body: { listId, leadId }
router.post('/:companyId/leads', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { companyId } = req.params;
    const { listId, leadId } = req.body;
    const userId = authReq.user!.userId;

    if (!listId || !leadId) { res.status(400).json({ error: 'listId and leadId required' }); return; }

    const company = await companyDb.getCompany(companyId);
    if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
    if (company.userId !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    await companyDb.assignLeadToCompany(listId, leadId, companyId);
    res.status(204).send();
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    console.error('assignLeadToCompany error:', err);
    res.status(500).json({ error: 'Failed to assign lead' });
  }
});

// DELETE /api/crm/companies/:companyId/leads/:leadId?listId=...
router.delete('/:companyId/leads/:leadId', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { companyId, leadId } = req.params;
    const listId = req.query.listId as string;
    const userId = authReq.user!.userId;

    if (!listId) { res.status(400).json({ error: 'listId query param required' }); return; }

    const company = await companyDb.getCompany(companyId);
    if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
    if (company.userId !== userId) { res.status(403).json({ error: 'Forbidden' }); return; }

    await companyDb.unassignLeadFromCompany(listId, leadId);
    res.status(204).send();
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    console.error('unassignLeadFromCompany error:', err);
    res.status(500).json({ error: 'Failed to unassign lead' });
  }
});

export default router;
