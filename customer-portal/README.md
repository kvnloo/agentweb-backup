# AgentWeb Customer Portal

AgentWeb Customer Portal is a specialized frontend application for AgentWeb that provides a dedicated interface for customers to access market research reports, templates, and resources. It integrates with the AgentWeb backend and uses the same authentication system as the partner portal and growth chat.

## Features

- 🔒 Secure customer authentication with role-based access
- 📊 Customer dashboard with template access and market research reports
- 📝 Market research reports and materials
- 🎨 Brand guidelines and resources
- ⚙️ Account settings and profile management
- 📱 Responsive design for all devices
- 🌙 Dark/light theme support
- 🔄 Real-time updates and notifications

## Prerequisites

- Node.js (v18 or later)
- AgentWeb backend running and accessible
- AgentWeb customer account

## Development Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

Create a `.env` file in the root directory:

```env
VITE_API_URL=http://localhost:3001
VITE_PARTNER_PORTAL_URL=http://localhost:5173
VITE_DEBUG=false
```

3. Start the development server:

```bash
npm run dev
```

The application will be available at http://localhost:5174

## Building for Production

```bash
npm run build
```

This will create a `dist` folder with the production build.

## Production Deployment

### AWS Elastic Beanstalk

1. Build the production version and create deployment package:

```bash
cd customer-portal && \
VITE_API_URL=https://api.agentweb.pro \
VITE_PARTNER_PORTAL_URL=https://partner.agentweb.pro \
VITE_DEBUG=false \
npm run build && \
VERSION="0.21" && \
mkdir -p builds && \
zip -r "builds/deploy_v${VERSION}.zip" dist package.json package-lock.json server.js
```

2. Create a new application in Elastic Beanstalk:
   - Go to AWS Management Console > Elastic Beanstalk
   - Click "Create application"
   - Enter application name (e.g., "agentweb-customer-portal")
   - Choose "Node.js" as platform
   - Upload the versioned zip file from `builds/deploy_v${VERSION}.zip`
   - Click "Create application"

### Environment Variables

- `VITE_API_URL`: The URL of the AgentWeb backend API (required at build time)
- `VITE_PARTNER_PORTAL_URL`: The URL of the partner portal for navigation
- `VITE_DEBUG`: Enable debug mode (defaults to false)
- `PORT`: Port for the production server (defaults to 3000)

## Integration with AgentWeb Backend

Customer Portal integrates with the AgentWeb backend through:

- **Authentication**: Uses the same JWT-based auth system as partner portal and growth chat
- **Role-based Access**: Customer role provides access to reports and templates
- **User Management**: Shares user accounts and roles with the main AgentWeb system
- **Templates**: Access to customer-specific templates and resources

### API Endpoints Used

- `POST /api/auth/login` - User authentication
- `GET /api/auth/me` - Get current user info
- `GET /api/auth/google` - Google OAuth login
- `GET /api/templates` - Get available templates
- `GET /api/templates/:id` - Get specific template
- `GET /api/reports` - Get market research reports
- `GET /api/reports/:id` - Get specific report
- `GET /api/user/settings` - Get user settings
- `PUT /api/user/settings` - Update user settings

## Architecture

The application is built with:

- **React 18** with TypeScript
- **Vite** for build tooling
- **Tailwind CSS** with custom design system
- **Radix UI** for accessible components
- **Axios** for API communication
- **React Query** for data fetching
- **React Router** for navigation
- **Socket.io** for real-time updates

## Design System

The application features a custom design system with:

- **Customer Colors**: Professional blue and green color scheme
- **Custom Components**: Task management, template selection, and report viewing
- **Typography Scale**: Consistent heading and body text styles
- **Responsive Design**: Mobile-first approach with breakpoint optimization
- **Accessibility**: WCAG compliant components and interactions

## Development

### Project Structure

```
src/
├── components/     # Reusable UI components
│   ├── ui/        # Base UI components (Button, Input, etc.)
│   ├── auth/      # Authentication components
│   ├── tasks/     # Task management components
│   ├── templates/ # Template selection components
│   └── layout/    # Layout and navigation components
├── contexts/      # React contexts (Auth, Templates, etc.)
├── pages/         # Page components
│   ├── Dashboard.tsx
│   ├── Tasks.tsx
│   ├── Settings.tsx
│   └── ...
├── lib/           # Utility functions
├── hooks/         # Custom React hooks
└── main.tsx       # Application entry point
```

### Adding New Features

1. Create new components in `src/components/`
2. Add new pages in `src/pages/`
3. Update routing in `src/App.tsx`
4. Add new API integrations in the appropriate context
5. Update the navigation in `src/components/layout/`

## Authentication Flow

1. **Unauthenticated Users**: Redirected to login page
2. **Sign In**: Users can authenticate via email/password or Google OAuth
3. **Role Verification**: System verifies user has 'customer' role
4. **Authenticated Users**: Access customer-specific features and resources
5. **Session Management**: Automatic token refresh and logout on expiration

## Customer Features

### Dashboard
- Overview of available templates and reports
- Quick access to recent activities
- Account status and usage statistics

### Templates
- Browse and search available templates
- Category-based organization
- Template details and usage instructions

### Market Research Reports
- Access to market research materials
- Downloadable reports and resources
- Search and filter capabilities

### Settings
- Profile management
- Account preferences
- Notification settings
- Billing information (if applicable)

## Troubleshooting

### Common Issues

1. **Build errors**: Ensure all dependencies are installed with `npm install`
2. **API connection issues**: Verify `VITE_API_URL` is correct and backend is accessible
3. **Authentication failures**: Check that the backend JWT_SECRET is properly configured
4. **Port conflicts**: The dev server runs on port 5174 by default
5. **Role access issues**: Verify user has 'customer' role in the backend

### Development Tips

- Use the browser's developer tools to debug API calls
- Check the browser console for any JavaScript errors
- Verify environment variables are loaded correctly
- Test authentication flow with both email/password and Google OAuth
- Ensure backend is running and accessible before testing

## Support

For support and questions:
- Check the main AgentWeb documentation
- Open an issue in the AgentWeb repository
- Contact the AgentWeb team

## License

This project is part of AgentWeb and follows the same licensing terms.