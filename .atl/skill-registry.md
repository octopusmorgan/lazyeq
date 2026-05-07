# Skill Registry

**Delegator use only.** Any agent that launches sub-agents reads this registry to resolve compact rules, then injects them directly into sub-agent prompts. Sub-agents do NOT read this registry or individual SKILL.md files.

See `_shared/skill-resolver.md` for the full resolution protocol.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| when implementing a change, preparing commits, splitting PRs, or planning chained or stacked PRs | work-unit-commits | ~/.claude/skills/work-unit-commits/SKILL.md |
| when drafting or posting feedback, review comments, maintainer replies, Slack messages, or GitHub comments | comment-writer | ~/.claude/skills/comment-writer/SKILL.md |
| when writing guides, READMEs, RFCs, onboarding docs, architecture docs, or review-facing documentation | cognitive-doc-design | ~/.claude/skills/cognitive-doc-design/SKILL.md |
| when a PR would exceed 400 changed lines, when planning chained PRs, stacked PRs, or reviewable slices | chained-pr | ~/.claude/skills/chained-pr/SKILL.md |
| When creating a GitHub issue, reporting a bug, or requesting a feature | issue-creation | ~/.claude/skills/issue-creation/SKILL.md |
| When creating a pull request, opening a PR, or preparing changes for review | branch-pr | ~/.claude/skills/branch-pr/SKILL.md |
| When user asks to create a new skill, add agent instructions, or document patterns for AI | skill-creator | ~/.claude/skills/skill-creator/SKILL.md |
| When writing Go tests, using teatest, or adding test coverage | go-testing | ~/.claude/skills/go-testing/SKILL.md |
| When user says "judgment day", "judgment-day", "review adversarial", "dual review", "doble review", "juzgar", "que lo juzguen" | judgment-day | ~/.claude/skills/judgment-day/SKILL.md |
| /browser, browse, web automation, scrape, navigate, screenshot | browser | ~/.claude/skills/browser/SKILL.md |
| Advanced GitHub Actions workflow automation, CI/CD pipelines, repository management | github-workflow-automation | ~/.claude/skills/github-workflow-automation/SKILL.md |
| Automated versioning, testing, deployment, and rollback management | github-release-management | ~/.claude/skills/github-release-management/SKILL.md |
| Issue tracking, project board automation, and sprint planning | github-project-management | ~/.claude/skills/github-project-management/SKILL.md |
| Multi-repository coordination, synchronization, and architecture management | github-multi-repo | ~/.claude/skills/github-multi-repo/SKILL.md |
| Comprehensive code review with AI-powered swarm coordination | github-code-review | ~/.claude/skills/github-code-review/SKILL.md |
| building self-learning agents, optimizing workflows, or implementing meta-cognitive systems | ReasoningBank Intelligence | ~/.claude/skills/reasoningbank-intelligence/SKILL.md |
| building self-learning agents, optimizing decision-making, or implementing experience replay systems | ReasoningBank with AgentDB | ~/.claude/skills/reasoningbank-agentdb/SKILL.md |
| building RAG systems, semantic search engines, or intelligent knowledge bases | AgentDB Vector Search | ~/.claude/skills/agentdb-vector-search/SKILL.md |
| optimizing memory usage, improving search speed, or scaling to millions of vectors | AgentDB Performance Optimization | ~/.claude/skills/agentdb-optimization/SKILL.md |
| building stateful agents, chat systems, or intelligent assistants | AgentDB Memory Patterns | ~/.claude/skills/agentdb-memory-patterns/SKILL.md |
| building self-learning agents, implementing RL, or optimizing agent behavior through experience | AgentDB Learning Plugins | ~/.claude/skills/agentdb-learning/SKILL.md |
| building distributed AI systems, multi-agent coordination, or advanced vector search applications | AgentDB Advanced Features | ~/.claude/skills/agentdb-advanced/SKILL.md |
| build custom skills for specific workflows, generate skill templates, or understand the Claude Skills specification | Skill Builder | ~/.claude/skills/skill-builder/SKILL.md |
| multi-agent pipelines, data transformation, and sequential workflows | stream-chain | ~/.claude/skills/stream-chain/SKILL.md |
| truth scoring, code quality verification, automatic rollback, quality metrics | Verification & Quality Assurance | ~/.claude/skills/verification-quality/SKILL.md |
| AI-assisted pair programming, TDD, debugging, refactoring, learning sessions | Pair Programming | ~/.claude/skills/pair-programming/SKILL.md |
| pre/post task hooks, session management, Git integration, memory coordination | Hooks Automation | ~/.claude/skills/hooks-automation/SKILL.md |
| SPARC methodology, specification-driven development, multi-agent orchestration | sparc-methodology | ~/.claude/skills/sparc-methodology/SKILL.md |
| advanced swarm patterns for research, development, testing, and complex distributed workflows | swarm-advanced | ~/.claude/skills/swarm-advanced/SKILL.md |
| scaling beyond single agents, implementing complex workflows, or building distributed AI systems | Swarm Orchestration | ~/.claude/skills/swarm-orchestration/SKILL.md |

## Project Skills

| Trigger | Skill | Path |
|---------|-------|------|
| Vite projects, vite.config.ts, Vite plugins, building libraries/SSR apps with Vite | vite | .agents/skills/vite/SKILL.md |
| "improve accessibility", "a11y audit", "WCAG compliance", "screen reader support", "keyboard navigation", "make accessible" | accessibility | .agents/skills/accessibility/SKILL.md |
| creating Node.js servers, REST APIs, GraphQL backends, or microservices architectures | nodejs-backend-patterns | .agents/skills/nodejs-backend-patterns/SKILL.md |
| build web components, pages, artifacts, posters, or applications, styling/beautifying any web UI | frontend-design | .agents/skills/frontend-design/SKILL.md |
| Node.js architecture decisions, framework selection, async patterns, security | nodejs-best-practices | .agents/skills/nodejs-best-practices/SKILL.md |
| "improve SEO", "optimize for search", "fix meta tags", "add structured data", "sitemap optimization" | seo | .agents/skills/seo/SKILL.md |

## Compact Rules

Pre-digested rules per skill. Delegators copy matching blocks into sub-agent prompts as `## Project Standards (auto-resolved)`.

### work-unit-commits
- Each commit = one deliverable work unit (feature, fix, refactor), NOT file-type batches
- Tests and docs stay beside the code they verify — same commit
- Keep each work unit under 400 changed lines for reviewer cognitive budget
- Commit message: conventional commits, describe WHAT and WHY, not HOW
- Order commits: foundation → feature → polish → tests → docs
- If a change spans >400 lines, split into multiple work units with clear boundaries

### comment-writer
- Write warm, direct, human tone — not robotic or overly formal
- Be specific: reference exact files, lines, or code snippets
- For PR reviews: explain WHY something should change, not just WHAT
- Use constructive language: "Consider…" instead of "This is wrong"
- Match the context: PR comments differ from Slack messages
- Keep it concise — one paragraph max unless complex reasoning needed

### cognitive-doc-design
- Progressive disclosure: overview → details → reference, never dump everything at once
- Chunk related info into sections with clear headings
- Signpost: tell readers where they are and what comes next
- Use tables for comparisons, checklists for actions, code blocks for examples
- Recognition over recall: show don't tell, use before/after examples
- PR descriptions: summary → changes → testing → screenshots (if UI)

### chained-pr
- Split when PR exceeds 400 changed lines or review time >60 minutes
- Each PR must be independently reviewable and testable
- Order: foundation/infrastructure → core logic → UI/integration → polish
- Use `size:exception` only when maintainer explicitly approves
- Each PR needs its own clear title, description, and test plan
- Never split a single logical unit across multiple PRs

### issue-creation
- Issue-first enforcement: create issue BEFORE PR for any non-trivial change
- Bug reports: steps to reproduce, expected vs actual, environment details
- Feature requests: problem statement, proposed solution, alternatives considered
- Use labels consistently: bug, enhancement, documentation, question
- Link related issues and PRs for traceability

### branch-pr
- Issue-first: every PR must link to an issue (create one if missing)
- Branch naming: `type/description` (e.g., `fix/login-crash`, `feat/search`)
- PR title: conventional commit format, describe the change not the process
- PR body: what changed, why, how to test, screenshots for UI changes
- Request reviewers from the team, assign to the linked issue
- Keep PRs under 400 lines — split if larger

### skill-creator
- Create skills for repeated patterns, project conventions, or complex workflows
- Use YAML frontmatter: name, description (with Trigger:), version
- Structure: When to Use → Critical Rules → Patterns → Examples
- Keep SKILL.md under 200 lines; put detailed references in separate files
- Test the skill by loading it and verifying sub-agents follow the rules
- Don't create skills for trivial patterns or things already documented elsewhere

### go-testing
- Use table-driven tests for all Go unit tests
- Use `teatest` for Bubbletea TUI component testing
- Test files: `*_test.go` in same package as source
- Golden file testing for complex output: `testdata/*.golden`
- Run with `go test ./...` or `go test -v ./...`
- Coverage: `go test -coverprofile=coverage.out ./...`

### judgment-day
- Launch TWO independent blind judge sub-agents simultaneously on same target
- Each judge reviews independently — no cross-contamination
- Synthesize findings from both judges, apply fixes
- Re-judge until both pass, or escalate after 2 iterations
- Trigger phrases: "judgment day", "judgment-day", "review adversarial", "dual review", "doble review", "juzgar"
- Use for: significant implementations, architecture changes, high-risk code

### browser
- Use `browser/open` to navigate to URL, `browser/snapshot` for AI-optimized page state
- `browser/click` and `browser/fill` for interactions
- `browser/screenshot` for visual verification
- Always close browser after use: `browser/close`
- Prefer snapshots over screenshots for text extraction (faster, more reliable)

### github-workflow-automation
- Use swarm coordination for parallel CI/CD pipeline tasks
- Automate workflow creation with AI-generated YAML
- Include security scanning, linting, and testing in all CI pipelines
- Use matrix builds for multi-version/multi-OS testing
- Cache dependencies aggressively for faster builds
- Add status badges and workflow dispatch triggers

### github-release-management
- Follow semantic versioning: MAJOR.MINOR.PATCH
- Automated changelog generation from commit messages
- Pre-release testing: run full test suite before tagging
- Create release assets: binaries, changelog, signatures
- Rollback plan: document rollback steps in release notes
- Use swarm coordination for parallel deployment tasks

### github-project-management
- Use project boards for sprint planning and issue tracking
- Link issues to milestones and epics
- Automate status transitions: PR merged → issue closed
- Use labels for triage: priority, type, status
- Sprint retrospectives: track velocity and burndown

### github-multi-repo
- Coordinate changes across multiple repositories with synchronized PRs
- Use monorepo patterns when possible to reduce cross-repo complexity
- Template management: keep shared configs in a template repo
- Cross-repo dependency tracking: update all dependents together
- Architecture decisions: document in a central ADR repo

### github-code-review
- Multi-agent review: assign different agents to security, performance, style
- Automated checks: lint, type-check, test coverage before human review
- Review comments: explain WHY, suggest concrete alternatives
- Quality gates: block merge if critical issues found
- Use swarm coordination for large PRs (>400 lines)

### ReasoningBank Intelligence
- Implement adaptive learning with pattern recognition and strategy optimization
- Store successful patterns for future reuse
- Track decision outcomes and adjust strategies over time
- Use for: self-learning agents, workflow optimization, meta-cognitive systems
- Requires: agentic-flow v3.0.0-alpha.1+, AgentDB v3.0.0-alpha.10+

### ReasoningBank with AgentDB
- Use AgentDB backend for 150x faster pattern retrieval and 500x faster batch ops
- Trajectory tracking: record agent decisions and outcomes
- Verdict judgment: evaluate success/failure of past decisions
- Memory distillation: compress experiences into reusable patterns
- 100% backward compatible with standard ReasoningBank

### AgentDB Vector Search
- Use HNSW indexing for sub-millisecond search (<100µs)
- Quantization: 4-32x memory reduction with minimal accuracy loss
- Support for custom distance metrics (cosine, euclidean, dot product)
- Batch operations: 2ms insert for 100 vectors
- Use for: RAG systems, semantic search, document retrieval

### AgentDB Performance Optimization
- Quantization: scalar (8-bit) or binary (1-bit) for memory reduction
- HNSW indexing: M=16, efConstruction=200 for balanced speed/accuracy
- Caching: hot vectors in memory, cold on disk
- Batch operations: group inserts/queries for throughput
- Monitor: search latency, memory usage, accuracy drop

### AgentDB Memory Patterns
- Session memory: short-term context within a conversation
- Long-term storage: persistent observations across sessions
- Pattern learning: recognize recurring situations and responses
- Context management: prioritize relevant memories, expire stale ones
- Use topic_key for evolving topics (upserts, not duplicates)

### AgentDB Learning Plugins
- 9 RL algorithms: Decision Transformer, Q-Learning, SARSA, Actor-Critic, etc.
- Offline RL for pre-trained models, online RL for live learning
- WASM-accelerated neural inference: 10-100x faster training
- Plugin system: create, train, deploy learning modules
- Use for: autonomous agents, behavior optimization, experience-based learning

### AgentDB Advanced Features
- QUIC synchronization: sub-1ms cross-node communication
- Multi-database management: separate DBs per project/domain
- Custom distance metrics: domain-specific similarity functions
- Hybrid search: vector + metadata filtering combined
- Distributed systems: shard databases, replicate for fault tolerance

### Skill Builder
- YAML frontmatter required: name, description, version
- Progressive disclosure: overview → quick start → detailed patterns → references
- Keep SKILL.md under 200 lines; use reference files for depth
- Test skills by loading them and verifying behavior
- Use Claude Skills specification for compatibility across surfaces

### stream-chain
- Custom chains: execute sequential prompts with full control
- Predefined pipelines: use battle-tested workflows for common tasks
- Each step receives complete output from previous step
- Stream-JSON for efficient data flow between agents
- Use for: multi-step transformations, sequential processing, data pipelines

### Verification & Quality Assurance
- Truth scoring: 0.0-1.0 reliability metric for code outputs
- Automatic rollback if score < 0.95 threshold
- Verification checks: correctness, security, best practices
- Quality metrics: statistical analysis with trends and confidence intervals
- CI/CD integration: export scores for pipeline gating

### Pair Programming
- Modes: Driver (writes code), Navigator (guides), Switch (alternate roles)
- TDD mode: write tests first, then implementation
- Real-time verification: automatic quality scoring with rollback
- Security scanning: check for vulnerabilities during coding
- Session persistence: auto-save, recovery, export

### Hooks Automation
- Pre-operation hooks: validate, prepare, auto-assign agents
- Post-operation hooks: format, analyze, train patterns
- Session management: persist state, restore context, generate summaries
- Git integration: automated commit hooks with quality verification
- Memory coordination: synchronize knowledge across swarm agents

### sparc-methodology
- 5 phases: Specification → Pseudocode → Architecture → Refinement → Completion
- 17 specialized modes for comprehensive development
- Multi-agent orchestration: parallel research, design, implementation
- TDD integration: tests drive implementation in Refinement phase
- Use for: complex projects requiring systematic approach

### swarm-advanced
- Research swarms: parallel investigation with synthesis
- Development swarms: coordinated implementation across modules
- Testing swarms: parallel test execution and analysis
- Dynamic topology: adjust agent count based on task complexity
- Fault tolerance: recover from agent failures gracefully

### Swarm Orchestration
- Mesh topology: all agents communicate with all others
- Hierarchical: leader agents coordinate worker agents
- Adaptive topology: switch based on task requirements
- Load balancing: distribute work evenly across agents
- Use for: scaling beyond single agents, complex workflows

### vite
- Use TypeScript: prefer `vite.config.ts`
- Always use ESM, avoid CommonJS
- Vite 8 uses Rolldown bundler and Oxc transformer
- `import.meta.glob` for dynamic imports, `?raw`/`?url` for asset queries
- Library mode: `build.lib` for package distribution
- SSR: `ssrLoadModule` for server-side rendering

### accessibility
- WCAG 2.2 AA minimum target: 4.5:1 contrast for normal text, 3:1 for large
- Prefer native elements over ARIA roles (button > div role="button")
- All images need alt text; decorative images: `alt=""`
- Keyboard accessible: all functionality works with Tab/Enter/Space
- Focus visible: use `:focus-visible`, never remove all outlines
- Target size: minimum 24×24 CSS pixels (AA), 44×44 recommended
- Respect `prefers-reduced-motion`: disable animations
- Don't rely on color alone for information

### nodejs-backend-patterns
- Layered architecture: controllers → services → repositories
- TypeScript preferred for type safety
- Use Fastify for performance, Express for ecosystem, Hono for edge
- Validate all inputs at boundaries (Zod recommended)
- Custom error classes: AppError, ValidationError, NotFoundError
- Structured logging (Pino/Winston), never console.log in production
- Rate limiting, CORS, helmet for security
- Connection pooling for databases, graceful shutdown

### frontend-design
- Choose BOLD aesthetic direction: brutalist, maximalist, retro-futuristic, etc.
- NEVER use generic AI aesthetics (Inter, Roboto, purple gradients)
- Typography: pick distinctive fonts, pair display + body
- CSS variables for color consistency, dominant colors with sharp accents
- Motion: CSS-only for HTML, Motion library for React, staggered reveals
- Spatial composition: asymmetry, overlap, diagonal flow, negative space
- Match complexity to vision: maximalist needs elaborate code, minimalist needs precision

### nodejs-best-practices
- Choose framework based on context, not default (Fastify > Express for new APIs)
- ESM over CommonJS for new projects
- Layered architecture for growing projects, single file for scripts
- Validate at boundaries: API entry, before DB, external data, env vars
- Fail fast with specific error messages
- Never use sync methods in production (fs.readFileSync, etc.)
- Offload CPU-intensive work to worker threads
- Security: parameterized queries, bcrypt/argon2, JWT verification, rate limiting

### seo
- Single `<h1>` per page, logical heading hierarchy
- Title tags: 50-60 chars, primary keyword near beginning, unique per page
- Meta descriptions: 150-160 chars, compelling CTA, unique per page
- Canonical URLs on all pages to prevent duplicate content
- robots.txt: allow crawling, block admin/private, include sitemap URL
- Structured data: JSON-LD for Organization, Article, Product, FAQ, Breadcrumbs
- Image SEO: descriptive filenames, alt text, WebP/AVIF, lazy load below-fold
- Mobile: responsive viewport, 48px tap targets, 16px body font

## Project Conventions

No convention files found (AGENTS.md, CLAUDE.md, .cursorrules not present in project root).
