# Contributing

Thanks for helping improve Elephant MCP! This guide covers day-to-day development tasks. If you are trying to use the server, head back to the [README](README.md).

## Prerequisites
- Node.js **22.18.0** or newer (Node 22 gives you native TypeScript execution).
- npm **10+** (bundled with Node 22).

## Local Setup
```bash
git clone <your-fork-url>
cd elephant-mcp
npm install
```

### Development Workflow
- `npm run dev` – Launches the stdio server directly from TypeScript with file watching.
- `npm run build` – Produces the distributable ESM bundle in `dist/`.
- `npm start` – Runs the compiled server (`dist/index.js`).

The entry point (`src/index.ts`) is executable (`#!/usr/bin/env node`) so the published package works with `npx -y @elephant-xyz/mcp@latest`.

## Quality Gates
- `npm run lint` / `npm run lint:fix` – ESLint with `@typescript-eslint`.
- `npm run format` / `npm run format:check` – Prettier with the repository defaults.
- `npm run test` – Vitest watch mode.
- `npm run test:ci` – Vitest JSON output (writes `test-results.json`).

Run these before you open a PR; CI expects them to pass.

## Configuration
Environment variables are validated in `src/config.ts`. Current options:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key for embeddings (preferred provider) | _(optional)_ |
| `AWS_REGION` | AWS region for Bedrock API calls | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key (optional if using IAM roles) | _(optional)_ |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (optional if using IAM roles) | _(optional)_ |
| `AWS_PROFILE` | AWS credentials profile name | _(optional)_ |
| `LOG_LEVEL` | Pino log level (`error`, `warn`, `info`, `debug`) | `info` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `production` |

Add new variables in `src/config.ts` so they inherit validation and documentation.

## Releasing
We use [semantic-release](https://semantic-release.gitbook.io/semantic-release/) driven by Conventional Commits:
- `main` branch pushes trigger `.github/workflows/release.yml`, which installs dependencies, builds the bundle, and runs `npx semantic-release`.
- semantic-release bumps the version, updates `CHANGELOG.md`, publishes to npm (requires `NPM_TOKEN`), and creates a GitHub release.

You can dry run locally with:
```bash
npm run release -- --dry-run
```
Just ensure `NPM_TOKEN` is available in your shell if you go beyond a dry run.

## Commit Style
Follow Conventional Commits (`feat:`, `fix:`, `chore:`…). This keeps automated releases predictable and the changelog clean.

## Need Help?
Open a discussion or ping us in the issues tracker. Include your Node.js version, the command you ran, and any console output so we can reproduce quickly. 
