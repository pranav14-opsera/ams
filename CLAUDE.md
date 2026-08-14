## Forge Development Standards

# Forge Development Standards

Follow clean-code best practices for your project's language and framework.

## Architecture

- Follow a layered architecture: routes/controllers -> services -> repositories/data-access -> providers
- Services receive dependencies through constructor injection — no hidden coupling
- External integrations use the strategy/factory pattern — depend on interfaces, not vendor SDKs
- Repositories contain zero business logic — only CRUD and queries
- Route handlers are thin: parse request, call service, format response

## File Discipline

- Keep files focused on a single responsibility
- Split files exceeding 500 lines — extract helpers, sub-services, or utility functions
- Move shared types/interfaces to dedicated type files

## Comments

- Explain **why**, not **what** — the code already says what it does
- Add comments for non-obvious business rules, workarounds, and trade-off decisions
- No commented-out code — use git history
- No TODOs without a ticket reference

## Error Handling

- Services throw descriptive errors; routes catch and return appropriate status codes
- Never silently swallow errors without documenting why
- Error messages should include what failed and how to fix it

## Implementation Quality

- Before writing new code, READ the existing files you will modify — match their patterns, style, and conventions
- Write complete, production-ready implementations — no placeholder code, no TODOs, no mock stubs
- Follow the project's existing frameworks and libraries — do not introduce alternatives without explicit instruction
- When implementation_steps are provided in a work order, follow them in order without skipping

## Unit Testing

- Every new or modified source file MUST have a corresponding unit test file
- Tests must cover: happy path, error/edge cases, and boundary conditions
- Mock external dependencies (databases, APIs, file systems, AI providers)
- Never commit code without running tests and confirming they pass
- Aim for meaningful coverage — test behavior, not implementation details

## Branching & PR Workflow

- **Never push directly to the default branch.** Always work on a feature branch.
- Each user story is its own atomic commit — never batch multiple WOs into one commit.
- Never start a new user story with uncommitted changes from the previous one — resolve or stash first.

## Forge Process Flow

- Read the user story + RTM traceability context before writing any code
- Cross-reference RTM rows to identify which PRD sections and architecture components are relevant
- Validate every acceptance criterion against your changes before committing
- Write/update unit tests for all changed files
- Run the full test suite and fix any failures
- One commit per user story — never batch multiple WOs into a single commit
- Never start a new user story with uncommitted changes from the previous one
