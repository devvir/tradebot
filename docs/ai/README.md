# AI Documentation Index

This folder contains documentation for AI agents working on TradeBot architecture and design decisions. These documents should be reviewed before making any significant changes to the project structure, service design, or module composition.

## Contents

### [service-architecture.md](service-architecture.md)

**Core architectural philosophy and design patterns for the entire system.**

Covers:
- Why services are independent and how they communicate
- How environment variables function as the contract between services
- Why services should operate independently of their consumers
- The folder structure for services and modules
- How to add new services or modules following the architecture
- Key design decisions and their rationale
- How the architecture scales as more services and modules are added

**Read this before:**
- Adding or modifying any service
- Changing how services communicate
- Adding a new module
- Making decisions about service dependencies
- Refactoring the project structure

### [docker.md](docker.md)

**Docker Compose composition strategy for reusable services and modules.**

Covers:
- How to use `include` for generic infrastructure services
- How to use `extends` for module-specific service configurations
- Service dependency management without coupling
- Merge rules and composition patterns
- Reference implementation in the reader module

**Read this before:**
- Creating a new module
- Deciding how to wire services together
- Adding dependencies between services

## Quick Reference

**Key Principle:** Services are independent, infrastructure-like units that are composed into modules. They communicate via environment variables and message queues, not direct function calls. A service succeeds on its own terms regardless of whether anything uses it.

**Enforcement:**
- Each service reads configuration from environment variables only
- No hardcoded connections between services
- Orchestration scripts auto-discover services and modules from the filesystem (no manual registry updates)
- Modules define which services they need via compose.yml `include` directives
