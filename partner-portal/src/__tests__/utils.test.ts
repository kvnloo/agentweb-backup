// Test utility functions
describe('Partner Portal Utils', () => {
  describe('Date formatting', () => {
    it('should format dates correctly', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const formatted = date.toISOString().split('T')[0];
      expect(formatted).toBe('2024-01-15');
    });

    it('should handle invalid dates', () => {
      const invalidDate = new Date('invalid');
      expect(isNaN(invalidDate.getTime())).toBe(true);
    });
  });

  describe('String utilities', () => {
    it('should capitalize first letter', () => {
      const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);
      
      expect(capitalize('hello')).toBe('Hello');
      expect(capitalize('world')).toBe('World');
      expect(capitalize('')).toBe('');
    });

    it('should truncate long strings', () => {
      const truncate = (str: string, length: number) => 
        str.length > length ? str.substring(0, length) + '...' : str;
      
      expect(truncate('Hello World', 5)).toBe('Hello...');
      expect(truncate('Short', 10)).toBe('Short');
    });
  });

  describe('Array utilities', () => {
    it('should filter unique values', () => {
      const unique = (arr: any[]) => [...new Set(arr)];
      
      expect(unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
      expect(unique(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('should group items by key', () => {
      const groupBy = (arr: any[], key: string) => 
        arr.reduce((groups, item) => {
          const group = item[key];
          groups[group] = groups[group] || [];
          groups[group].push(item);
          return groups;
        }, {});
      
      const items = [
        { type: 'user', name: 'John' },
        { type: 'admin', name: 'Jane' },
        { type: 'user', name: 'Bob' }
      ];
      
      const grouped = groupBy(items, 'type');
      expect(grouped.user).toHaveLength(2);
      expect(grouped.admin).toHaveLength(1);
    });
  });

  describe('Validation utilities', () => {
    it('should validate email format', () => {
      const isValidEmail = (email: string) => 
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('invalid-email')).toBe(false);
      expect(isValidEmail('')).toBe(false);
    });

    it('should validate required fields', () => {
      const hasRequiredFields = (obj: any, required: string[]) => 
        required.every(field => obj.hasOwnProperty(field) && obj[field] !== null && obj[field] !== undefined);
      
      const user = { name: 'John', email: 'john@example.com', age: 25 };
      expect(hasRequiredFields(user, ['name', 'email'])).toBe(true);
      expect(hasRequiredFields(user, ['name', 'phone'])).toBe(false);
    });
  });
});
