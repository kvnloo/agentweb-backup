# AgentWeb

AgentWeb is a powerful web automation platform that allows users to create and manage web-based tasks using natural language instructions. It provides secure credential management and executes tasks in isolated environments, making it ideal for automating recurring web operations while maintaining security.

## Features

- 🤖 Natural language task creation
- 🔒 Zero credential storage - credentials required per task execution
- 🌐 Isolated browser sessions for each task
- ⏱️ Support for both single and recurring tasks
- 📊 Real-time task monitoring and alerts
- 🔐 MFA for AgentWeb account security

## Prerequisites

- Node.js (v16 or higher)
- Docker
- AWS Account
- browser-use library

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/agentweb.git
cd agentweb
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the development server:
```bash
npm run dev
```

## Usage

1. Create and secure your AgentWeb account with MFA
2. Create a new task using natural language
3. Input target website credentials when executing the task
4. Monitor task execution and results
5. Set up alerts for task completion or failures

For detailed documentation, please refer to our [Design Document](./design.md).

## Security

AgentWeb implements a strict security model:
- Zero permanent storage of target website credentials
- Fresh credential input required for each task execution
- Isolated browser sessions for each task
- MFA-protected AgentWeb accounts
- No correlation between AgentWeb accounts and target website credentials
- Automatic session cleanup after task completion

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.

## Roadmap

See our [Design Document](./design.md) for detailed development roadmap and future considerations.

## Setup

### Prerequisites
- Node.js (v18 or later)
- AWS Account with DynamoDB access

### Backend Setup

1. Install dependencies:
```bash
cd backend
npm install
```

2. Configure environment variables:
- Create a `.env` file in the `backend` directory:
```
PORT=3001
JWT_SECRET=your_jwt_secret
AWS_REGION=your_aws_region
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
```

3. Create DynamoDB tables:
```bash
cd backend
npm run build
node dist/scripts/create-tables.js
```
This will create all required tables in DynamoDB:
- AW-Users: User accounts
- AW-Tasks: Task definitions
- AW-TaskExecutions: Task execution records
- AW-Waitlist: Waitlist entries

4. Start the backend server:
```bash
npm run dev
```

### Frontend Setup

1. Install dependencies:
```bash
cd frontend
npm install
```

2. Configure environment variables:
- Create a `.env` file in the `frontend` directory:
```
VITE_API_URL=http://localhost:3001
```

3. Start the development server:
```bash
npm run dev
```

The application will be available at http://localhost:5173

## Development

### Project Structure

```
.
├── backend/
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── services/    # Database and business logic
│   │   └── utils/       # Utility functions
│   └── scripts/         # Database setup scripts
└── frontend/
    └── src/
        ├── components/  # React components
        ├── contexts/    # React contexts
        └── pages/       # Page components
```

### Environment Variables

Backend:
- Create a `.env` file in the `backend` directory:
```
PORT=3001
JWT_SECRET=your_jwt_secret
AWS_REGION=your_aws_region
```

Frontend:
- Create a `.env` file in the `frontend` directory:
```
VITE_API_URL=http://localhost:3001
```