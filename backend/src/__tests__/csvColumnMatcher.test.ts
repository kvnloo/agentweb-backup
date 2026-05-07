import { suggestColumnMapping, MappingSuggestion } from '../services/csvColumnMatcher';

describe('csvColumnMatcher', () => {
  describe('exact and high-confidence matches', () => {
    it('maps standard headers exactly', () => {
      const result = suggestColumnMapping(['First Name', 'Last Name', 'Email']);
      expect(result['First Name'].field).toBe('firstName');
      expect(result['First Name'].confidence).toBe('high');
      expect(result['Last Name'].field).toBe('lastName');
      expect(result['Last Name'].confidence).toBe('high');
      expect(result['Email'].field).toBe('email');
      expect(result['Email'].confidence).toBe('high');
    });

    it('handles snake_case and lowercase variants', () => {
      const result = suggestColumnMapping(['first_name', 'lastname', 'EMAIL']);
      expect(result['first_name'].field).toBe('firstName');
      expect(result['lastname'].field).toBe('lastName');
      expect(result['EMAIL'].field).toBe('email');
    });

    it('maps phone synonyms (each in isolation)', () => {
      expect(suggestColumnMapping(['Phone'])['Phone'].field).toBe('phone');
      expect(suggestColumnMapping(['Mobile'])['Mobile'].field).toBe('phone');
      expect(suggestColumnMapping(['Cell'])['Cell'].field).toBe('phone');
    });
  });

  describe('companyLinkedin disambiguation', () => {
    it('distinguishes person linkedin from company linkedin', () => {
      const result = suggestColumnMapping(['LinkedIn', 'Company LinkedIn']);
      expect(result['LinkedIn'].field).toBe('linkedin');
      expect(result['Company LinkedIn'].field).toBe('companyLinkedin');
    });

    it('matches company linkedin synonyms (each in isolation)', () => {
      const variants = ['Co. Linkedin', 'Company LinkedIn URL', 'company_linkedin', 'Org LinkedIn'];
      for (const h of variants) {
        const result = suggestColumnMapping([h]);
        expect(result[h].field).toBe('companyLinkedin');
      }
    });

    it('plain LinkedIn URL maps to person linkedin (each in isolation)', () => {
      expect(suggestColumnMapping(['LinkedIn URL'])['LinkedIn URL'].field).toBe('linkedin');
      expect(suggestColumnMapping(['Linkedin Profile'])['Linkedin Profile'].field).toBe('linkedin');
    });
  });

  describe('Full Name handling', () => {
    it('emits splitFullName directive for Full Name header', () => {
      const result = suggestColumnMapping(['Full Name', 'Email']);
      expect(result['Full Name'].field).toBe('firstName');
      expect(result['Full Name'].splitFullName).toBe(true);
    });

    it('emits splitFullName for plain "Name" header when no first/last present', () => {
      const result = suggestColumnMapping(['Name', 'Email']);
      expect(result['Name'].splitFullName).toBe(true);
    });

    it('does NOT split when explicit first name column already present', () => {
      const result = suggestColumnMapping(['Name', 'First Name', 'Last Name']);
      expect(result['Name'].splitFullName).toBeFalsy();
    });
  });

  describe('fuzzy matching (typos)', () => {
    it('tolerates single-character typos via Levenshtein', () => {
      const result = suggestColumnMapping(['Comapny', 'Emal']);
      expect(result['Comapny'].field).toBe('company');
      expect(result['Comapny'].confidence).toBe('medium');
      expect(result['Emal'].field).toBe('email');
    });
  });

  describe('skip / unknown', () => {
    it('skips unrecognized columns', () => {
      const result = suggestColumnMapping(['Random Column', 'XYZ', 'Foo Bar']);
      expect(result['Random Column'].field).toBe('skip');
      expect(result['XYZ'].field).toBe('skip');
      expect(result['Foo Bar'].field).toBe('skip');
    });

    it('returns skip with low confidence', () => {
      const result = suggestColumnMapping(['Totally Unknown']);
      expect(result['Totally Unknown'].confidence).toBe('low');
    });
  });

  describe('duplicate header handling', () => {
    it('only the first occurrence wins for a given target field', () => {
      const result = suggestColumnMapping(['Email', 'Email Address']);
      expect(result['Email'].field).toBe('email');
      // second one should NOT also map to email (would cause duplicate writes)
      expect(result['Email Address'].field).not.toBe('email');
    });
  });

  describe('return type shape', () => {
    it('returns MappingSuggestion per header', () => {
      const result = suggestColumnMapping(['Email']);
      const sug: MappingSuggestion = result['Email'];
      expect(sug).toHaveProperty('field');
      expect(sug).toHaveProperty('confidence');
    });
  });
});
