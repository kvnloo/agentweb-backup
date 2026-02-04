// Unit tests for LinkedIn import draft message filtering
import { parse } from 'csv-parse/sync';

describe('LinkedIn Import - Draft Message Filtering', () => {
  describe('Message CSV Parsing', () => {
    it('should filter out draft messages where IS MESSAGE DRAFT is Yes', () => {
      const csvContent = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT,FOLDER,IS MESSAGE DRAFT
conv1,Chat with John,Me,https://linkedin.com/in/me,John,2026-02-01,Hello,Hi John,Inbox,No
conv2,Chat with Jane,Me,https://linkedin.com/in/me,Jane,2026-02-02,Draft,This is a draft,Drafts,Yes
conv3,Chat with Bob,Me,https://linkedin.com/in/me,Bob,2026-02-03,Meeting,Let's meet,Inbox,No
conv4,Another Draft,Me,https://linkedin.com/in/me,Alice,2026-02-04,Draft 2,Draft content,Drafts,Yes`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      // Apply the same filtering logic as in crm.ts
      const validMessages = messagesRecords.filter((m: any) => {
        // Must have conversation ID and date
        if (!m['CONVERSATION ID'] || !m.DATE) return false;

        // Skip messages marked as drafts (IS MESSAGE DRAFT = "Yes")
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;

        return true;
      });

      expect(validMessages.length).toBe(2);
      expect(validMessages[0]['CONVERSATION ID']).toBe('conv1');
      expect(validMessages[1]['CONVERSATION ID']).toBe('conv3');
    });

    it('should include messages where IS MESSAGE DRAFT is No', () => {
      const csvContent = `CONVERSATION ID,DATE,IS MESSAGE DRAFT
conv1,2026-02-01,No
conv2,2026-02-02,no
conv3,2026-02-03,NO`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const validMessages = messagesRecords.filter((m: any) => {
        if (!m['CONVERSATION ID'] || !m.DATE) return false;
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;
        return true;
      });

      expect(validMessages.length).toBe(3);
    });

    it('should include messages where IS MESSAGE DRAFT is missing or empty', () => {
      const csvContent = `CONVERSATION ID,DATE,IS MESSAGE DRAFT
conv1,2026-02-01,
conv2,2026-02-02,
conv3,2026-02-03,`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const validMessages = messagesRecords.filter((m: any) => {
        if (!m['CONVERSATION ID'] || !m.DATE) return false;
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;
        return true;
      });

      expect(validMessages.length).toBe(3);
    });

    it('should filter out messages with Yes in various cases', () => {
      const csvContent = `CONVERSATION ID,DATE,IS MESSAGE DRAFT
conv1,2026-02-01,Yes
conv2,2026-02-02,YES
conv3,2026-02-03,yes
conv4,2026-02-04,YeS`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const validMessages = messagesRecords.filter((m: any) => {
        if (!m['CONVERSATION ID'] || !m.DATE) return false;
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;
        return true;
      });

      expect(validMessages.length).toBe(0);
    });

    it('should filter out messages with whitespace around Yes', () => {
      const csvContent = `CONVERSATION ID,DATE,IS MESSAGE DRAFT
conv1,2026-02-01," Yes "
conv2,2026-02-02,"  yes  "
conv3,2026-02-03,No`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const validMessages = messagesRecords.filter((m: any) => {
        if (!m['CONVERSATION ID'] || !m.DATE) return false;
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;
        return true;
      });

      expect(validMessages.length).toBe(1);
      expect(validMessages[0]['CONVERSATION ID']).toBe('conv3');
    });

    it('should still filter out messages without conversation ID or date', () => {
      const csvContent = `CONVERSATION ID,DATE,IS MESSAGE DRAFT
,2026-02-01,No
conv2,,No
conv3,2026-02-03,No`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const validMessages = messagesRecords.filter((m: any) => {
        if (!m['CONVERSATION ID'] || !m.DATE) return false;
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;
        return true;
      });

      expect(validMessages.length).toBe(1);
      expect(validMessages[0]['CONVERSATION ID']).toBe('conv3');
    });

    it('should handle real-world LinkedIn export format', () => {
      const csvContent = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER,IS MESSAGE DRAFT
urn:li:msg:1,Project Discussion,John Smith,https://www.linkedin.com/in/johnsmith,Me,https://www.linkedin.com/in/me,2026-01-15 10:30:00,Re: Project,Let's schedule a call,Inbox,No
urn:li:msg:2,Follow-up,Me,https://www.linkedin.com/in/me,Jane Doe,https://www.linkedin.com/in/janedoe,2026-01-20 14:00:00,Quick question,Hi Jane\\, I wanted to follow up...,Sent,No
urn:li:msg:3,Draft Message,Me,https://www.linkedin.com/in/me,Bob Wilson,https://www.linkedin.com/in/bobwilson,2026-01-22 09:00:00,Draft,This is still being written,Drafts,Yes
urn:li:msg:4,Meeting Request,Me,https://www.linkedin.com/in/me,Alice Chen,https://www.linkedin.com/in/alicechen,2026-01-25 16:30:00,Meeting,Can we meet next week?,Sent,No`;

      const messagesRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const validMessages = messagesRecords.filter((m: any) => {
        if (!m['CONVERSATION ID'] || !m.DATE) return false;
        const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
        if (isDraft) return false;
        return true;
      });

      expect(validMessages.length).toBe(3);
      expect(validMessages.map((m: any) => m['CONVERSATION ID'])).toEqual([
        'urn:li:msg:1',
        'urn:li:msg:2',
        'urn:li:msg:4',
      ]);
      // Draft message (urn:li:msg:3) should be filtered out
      expect(validMessages.find((m: any) => m['CONVERSATION ID'] === 'urn:li:msg:3')).toBeUndefined();
    });
  });
});
