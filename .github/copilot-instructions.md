# Project Context

This is a **personal project**. It is not production-ready and may not be for months (if ever). There are **no teams**—just a single developer (the project owner). The focus is on **developer experience (DX)** and coding speed, with minimal friction. Production-readiness, team workflows, and related concerns will be addressed in the future if/when needed.

## Architecture & Design

This project follows a **service-oriented architecture** with well-defined patterns for scalability. Before making any architecture-impacting changes (adding services, modifying service communication, etc.), **read [docs/ai/README.md](../../docs/ai/README.md)** and the architecture documentation linked there.

Key principle: Services are independent units that communicate via environment variables and message queues, not direct code dependencies. Modules compose services into deployable units.

# Copilot Instructions for TradeBot Development

## Code Philosophy

All code in this project is written primarily for **human understanding and maintainability**. Machine readability is secondary.

### Principles

- Do not export module values unnecessarily. It only adds more surface to the module which makes it less maintainable. Only export things that someone else actually needs.
- Use space after negation `!`, e.g. `if (! something()) ...`; it's easier to spot and harder to misread for humans.

## Type Definitions

- All TypeScript interfaces and type definitions should be placed in dedicated `types` files (e.g., `services/broadcast/types/index.ts`).

- **Language**: TypeScript is preferred over JavaScript for all new code
- **Formatting**: All code must follow Prettier formatting rules (see `.prettierrc`)
- **Semicolons**: Always use semicolons (enforced by Prettier)
- **Linting**: Follow ESLint rules for TypeScript
- **Node modules**: Use `node:` prefix when importing core Node modules (e.g., `import fs from 'node:fs'`)

## Code Structure

- All application code lives in `src/` folders within each service
- Use modular files for different concerns:
  - `src/index.ts` - Entry point, orchestration only
  - `src/mongodb.ts` - MongoDB connection and utilities
  - `src/rabbitmq.ts` - RabbitMQ connection and utilities
  - `src/health.ts` - Health check server
  - `src/config.ts` - Configuration loading and validation
  - Other domain-specific modules as needed

- Each module should export clean, well-documented interfaces
- Avoid circular dependencies

### `src/index.ts` — the entry point contract

**`index.ts` is the synopsis of the service, not an implementation file.**
It must be readable like a paragraph — a reader should understand what the
service does before they reach line 20.

Hard rules:
- **≤ 50 lines.** Anything longer means implementation has leaked in.
- **No complex logic.** Top-level flow is fine: connect, consume, try/catch ack/nack, shutdown. What must not appear: algorithms, state machines, buffer management, retry logic, message parsing, recovery routines.
- **Every non-trivial block must live in its own module** (`loop.ts`,
  `consume.ts`, `flush.ts`, etc.) and be called by name from `index.ts`.

A correct `index.ts` reads like a synopsis — you can see the shape of the
service without seeing how any step is implemented:
```ts
await connectQueue();

queue.consume(async (message) => {
  try {
    await transform(message);
    message.ack();
  } catch {
    message.nack();
  }
});

onShutdown(async () => {
  await flush();
  await queue.disconnect();
});
```

## Build & Deployment

- TypeScript is compiled to JavaScript in the `dist/` folder
- Dockerfiles should compile TypeScript during the build stage
- Production images should run compiled JavaScript from `dist/`

## Error Handling

- Always use try-catch for async operations
- Log errors with context (use structured logging via pino)
- Provide meaningful error messages for debugging
- Never silently swallow errors

## Testing

- Integration tests in `tests/` folder
- Use Vitest as test runner
