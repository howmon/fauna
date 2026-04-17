# Contributing to Fauna

Thank you for your interest in contributing! Here's how to get started.

## Getting Started

1. **Fork** the repository and clone your fork locally.
2. **Install dependencies**: `npm install` in the root, and `npm install` inside `relay/` for the MCP relay server.
3. **Start the dev server**: `npm start` (runs on `http://localhost:3737`).
4. **Start the relay**: `cd relay && npm start` (WebSocket relay on port 3335).

## Workflow

1. Create a branch from `main`: `git checkout -b feat/your-feature`
2. Make your changes and test them locally.
3. Commit with a clear message: `git commit -m "feat: describe your change"`
4. Push your branch and open a pull request against `main`.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR.
- Include a clear description of *what* changed and *why*.
- Reference any related issues with `Fixes #123` or `Closes #123`.
- Ensure the app starts and core features work before submitting.

## Code Style

- JavaScript (ES6+), no build step required.
- Use `var` in client-side files (consistent with existing code), `const`/`let` in Node.js server code.
- 2-space indentation throughout.
- Keep lines reasonably short (120 chars max).

## Reporting Bugs

Open an issue using the **Bug report** template. Include:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS/Node version

## Requesting Features

Open an issue using the **Feature request** template with a clear description of the use case.

## Security Issues

Please **do not** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible disclosure process.
