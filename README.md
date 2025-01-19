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