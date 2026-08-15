# Features

Each feature (agents, audit, billing, ...) gets its own directory here:
`src/features/<feature>/{components,hooks,api,types}`. Feature code stays
self-contained; only genuinely cross-feature primitives belong in
`src/components/ui`, `src/hooks`, or `src/lib`. No feature directories
exist yet — this scaffold (WO-050) establishes the convention; the first
real feature lands in a subsequent work order.
