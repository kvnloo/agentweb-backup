### HTML Template Creation and Email Templates

The platform includes a comprehensive email template system accessible in the customer portal's "Email Templates" section.

#### Creating HTML Templates

**Two main approaches:**

1. **Manual Creation** (Customer Portal UI):
   - Create templates directly in the Email Templates interface
   - Enter template name, subject, and HTML content
   - System automatically detects variables: `{{variable_name}}`
   - Support for array variables: `{{items_n}}`, `{{items_n_title}}`, `{{items_n_description}}`

2. **AI-Generated Templates** (Agent Mode MCP Tool):
   - Use `create_html_template` tool in agent mode chat
   - Provide existing HTML file (S3 URL or raw HTML content)
   - Claude 4.5 processes and enhances the HTML
   - Automatically identifies dynamic content and creates variables
   - Saves directly to Email Templates for editing/preview

#### MCP Tools for HTML/Template Management

**`create_html_template`** - Create a REUSABLE email template and SAVE it to the Templates library
```typescript
// Parameters:
{
  html_source: string,        // S3 URL or raw HTML content
  template_name: string,      // Unique template identifier
  subject: string,            // Email subject (can include variables)
  additional_instructions: string  // Optional: how to process HTML
}
```

> **When to use which tool — template vs. file.** `create_html_template` produces a
> *reusable, parameterized template* (with `{{variable}}` placeholders) that is **saved
> to the user's Templates library**. Only use it when the user **explicitly** asks to
> create or save a reusable template. For a **one-off email or newsletter in HTML
> format** (a finished piece of content the user wants to draft, build, preview, or
> send), use **`create_html_file`** instead — it returns an HTML file (S3 URL) and does
> **not** save anything to the Templates library.

Example usage in agent mode:
```
User: "Save this as a reusable welcome-email template"
Agent: Uses create_html_template with:
  - html_source: "https://s3.amazonaws.com/bucket/welcome.html"
  - template_name: "welcome_email"
  - subject: "Welcome to {{company_name}}!"
  - additional_instructions: "Add variables for user name and company"

User: "Build my May newsletter into a branded HTML email"
Agent: Uses create_html_file with document_type: "email" (NOT create_html_template) —
       this is a one-off HTML email, not a reusable template.
```

**`create_html_file`** - Generate a standalone, one-off HTML document or email (NOT a saved template)
```typescript
// Parameters:
{
  title: string,                  // Document title, or the subject/headline for an email
  content_draft: string,
  format_requirements: string,    // Optional styling/structure requirements
  document_type: "document" | "email"  // Optional, default "document".
                                  // "email" => email-client-safe HTML (table layout,
                                  // inline CSS, 600px container, no JS) for one-off
                                  // newsletters/marketing emails.
}
// Returns S3 URL to generated HTML file.
// Use document_type "email" for one-off emails/newsletters; "document" (default)
// for reports, summaries, audits, GTM plans, etc.
```

> **One-off newsletter email without a template.** Previously a newsletter email
> required a saved template plus `create_html_from_template`. Now Emma can generate a
> finished, ready-to-send newsletter email directly with
> `create_html_file({ document_type: "email", ... })` — no template needed. The email
> mode emits table-based, inline-styled, email-client-safe HTML (Gmail/Outlook/Apple
> Mail) and fills in real content (no `{{variable}}` placeholders). Use
> `create_html_template` only when the user explicitly wants a reusable, saved template.

**`create_html_from_template`** - Generate HTML from existing template
```typescript
// Parameters:
{
  template_name: string,
  llmModel: string,
  variableValues: { [key: string]: string },
  arrayVariableValues: { [key: string]: string[] }
}
// Uses LLM to perform variable substitution
// Returns S3 URL to final HTML file
```

#### Variable System

**Regular Variables:** `{{variable_name}}`
- Single value substitution
- Examples: `{{user_name}}`, `{{company_name}}`, `{{email}}`

**Array Variables:** `{{items_n}}` pattern
- Used for repeating sections (lists, tables, etc.)
- **REQUIRED Pattern:** Must include exactly three instances: `_1`, `_2`, `_n`
  - `{{items_1_property}}` - First item
  - `{{items_2_property}}` - Second item
  - `{{items_n_property}}` - Array pattern
- Do NOT use `_3`, `_4`, `_5`, etc. Only `_1`, `_2`, and `_n` are valid
- This three-part pattern is required for the template system to function properly
- When using template: provide any number of items (not limited to 2)

**Example Array Variable Pattern:**
```html
<!-- In template: REQUIRED three-part pattern -->
<li>{{products_1_name}} - ${{products_1_price}}</li>
<li>{{products_2_name}} - ${{products_2_price}}</li>
<li>{{products_n_name}} - ${{products_n_price}}</li>

<!-- System extracts: products_n_name, products_n_price -->
<!-- When using: provide any number of items (5, 10, 100...) -->
```

#### Storage and Access

- **Backend:** Templates stored in DynamoDB settings table
  - Setting key: `email_templates_${userId}`
  - Value: JSON array of template objects
  - Each template includes: name, subject, html_content, variables, arrayVariables, timestamps

- **Frontend:** Email Templates page (customer-portal/src/pages/EmailTemplates.tsx)
  - Create, edit, delete operations
  - Live preview in iframe
  - Variable detection and display
  - Template selection for HTML generation

- **API Endpoints:**
  - `GET /api/settings/email-templates` - List user's templates
  - `POST /api/settings/email-templates` - Create/update template
  - `DELETE /api/settings/email-templates/:templateName` - Delete template

#### Implementation Details

**Template Creation Flow (create_html_template):**
1. Read HTML from source (URL fetch or direct content)
2. Send to Claude 4.5 with system prompt for email template enhancement
3. LLM identifies dynamic content and adds `{{variable}}` placeholders
4. Extract all variables using regex: `/\{\{([^}]+)\}\}/g`
5. Classify variables as regular or array type (based on `_n` pattern)
6. Save to DynamoDB with metadata
7. Return success with variable list

**Variable Extraction Logic:**
- Find all `{{...}}` patterns in HTML and subject
- Identify array base patterns: `something_n` or `something_n_suffix`
- Match numeric instances: `something_1`, `something_2`, etc.
- Separate into regular and array variable lists

**LLM Configuration:**
- Model: Claude Sonnet 4.6 (`anthropic.claude-sonnet-4-6`)
- Temperature: 0.8 for creative template enhancement
- Max tokens: 4000
- System prompt emphasizes email compatibility, inline styles, responsive design

**Testing:**
- Tests: `backend/src/__tests__/agentModeService.createHtmlTemplate.test.ts`
- Covers: HTML content, S3 URL fetching, variable extraction, template updates, error handling
