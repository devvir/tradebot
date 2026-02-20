# AI Documentation Index

This folder contains documentation for AI agents working on TradeBot architecture and design decisions. These documents should be reviewed before making any significant changes to the project structure, service design, or module composition.

## Contents

### [service-architecture.md](service-architecture.md)

**Core architectural philosophy and design patterns for the entire system.**

Describes ideal organizational patterns and principles for how services and modules should be structured. The current project implements these principles with three active services (feed, codec, archivist) and shared packages (logger, types).

Covers:
- Why services are independent and how they communicate
- How environment variables function as the contract between services
- The folder structure for services and modules
- How to add new services or modules following the architecture
- Key design decisions and their rationale

**Read this before:**
- Adding or modifying any service
- Changing how services communicate
- Adding a new module

### [docker.md](docker.md)

**Docker Compose composition strategy for reusable services and modules.**

Covers:
- How to use `include` for generic infrastructure services
- How to use `extends` for module-specific service configurations
- Service dependency management without coupling
- Merge rules and composition patterns

**Read this before:**
- Creating a new module
- Deciding how to wire services together

## Quick Reference

**Key Principle:** Services are independent units that communicate via environment variables and message queues. Currently active services: feed, codec, archivist. Shared packages (workspace modules): @tradebot/logger, @tradebot/types.

**Current Enforcement:**
- Each service reads configuration from environment variables only
- Services import shared packages via workspace references (e.g., `import logger from '@tradebot/logger'`)
- No hardcoded connections between services
- Message-based communication through RabbitMQ
