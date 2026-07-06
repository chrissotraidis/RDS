# Spec Format Reference

This document defines the as-built specification format produced by the analyze
skill. The spec is consumed by `arnold run` to rebuild a product on a new tech
stack. It captures every product requirement without referencing the original
implementation.

---

## Guiding Principles

**Think like a product manager, not an engineer.** Apply these rules:

1. **Name requirements as product features** — "Care Plan Management", not
   "State Management and Hooks". Ask: "What would a product manager call this
   in a roadmap?"

2. **Infer the product domain** — From screen names, data entities, API
   endpoints, and business logic, determine what this product IS. State this
   clearly in the Overview.

3. **Identify user roles** — From auth logic, role constants, conditional
   rendering, and navigation guards, identify distinct user types.

4. **Write user-centric requirements** — Each requirement describes value
   delivered to a user role. Bad: "The system SHALL utilize React Native."
   Good: "Caregivers SHALL be able to manage daily checklists."

5. **Construct user flows** — Trace multi-step journeys across screens, API
   calls, and state changes. Connect related findings into coherent flows.

6. **Separate product from infrastructure** — CI/CD, build tooling, test
   frameworks, and state management architecture are NOT product requirements.

## Stack-Agnostic Requirements

The spec is used to rebuild on a DIFFERENT tech stack. Therefore:

- NEVER mention specific libraries, frameworks, gems, or packages
- NEVER reference file paths, class names, or module structures
- NEVER describe data types in implementation terms (use "text", "number",
  "date", "yes/no" — not "string", "integer", "datetime", "boolean")
- DO describe behaviors, rules, and user-visible outcomes in plain language
- DO name entities in business terms ("Care Plan", "Invoice") not technical
  terms ("CarePlan model", "invoices table")

---

## Epistemic Classification

Tag every requirement and finding with its confidence level:

| Marker | Meaning | Rule |
|--------|---------|------|
| `[CONFIRMED]` | Directly observed with multiple corroborating signals | 2+ wiki pages provide corroborating evidence |
| `[INFERRED]` | Reasonable deduction from partial evidence | Only 1 source or evidence is indirect |
| `[GAP]` | Expected capability appears missing | Must become an open question in Review |
| `[CONFLICT]` | Sources disagree on this finding | Must become a conflict entry in Review |

Rules:
- A requirement is CONFIRMED when 2+ wiki pages provide corroborating evidence
- A requirement is INFERRED when only 1 wiki page provides evidence, or
  evidence is indirect
- A requirement is a GAP when a logical expectation is not met
- NEVER silently resolve contradictions — surface them as CONFLICT entries

---

## Document Structure

The spec is a single Markdown file with 11 numbered sections.

### 1. Overview

```markdown
## 1. Overview
- Application Classification: [inferred domain type, e.g., HEALTHCARE, FINTECH, SAAS]
- Vision & Description: What this application is and why it exists
- Target Users: Who uses this and their key characteristics (list each user role)
- What This Is NOT: Explicit boundaries inferred from what the app does NOT do
- Assumptions & Constraints: Conditions taken as true from the analysis
```

### 2. Features

Organized by functional area using the requirement/scenario format.

```markdown
## 2. Features

### [Functional Area Name]

#### Requirement: [Feature Name] [REQ-{DOMAIN}-{NNN}]
[One-sentence statement using RFC 2119 keywords: SHALL/SHOULD/MAY]

> [CONFIRMED] / [INFERRED] — [brief evidence summary]

**Context:** [Why this feature exists — what user problem it solves]

##### Scenario: [Descriptive Name]
- GIVEN [user state/precondition]
- WHEN [user action]
- THEN [observable outcome from user perspective]
- AND [additional outcome, if any]

##### Scenario: [Edge Case or Error Name]
- GIVEN [precondition]
- WHEN [failure or edge condition]
- THEN [specific error handling or recovery behavior]
```

Rules:
- Every functional requirement becomes a `#### Requirement:` block
- Every behavioral spec, corner case, and acceptance criterion becomes a
  `##### Scenario:` block using GIVEN/WHEN/THEN
- Each requirement MUST have at least one scenario
- Use specific numbers, limits, and concrete details in scenarios
- Assign unique IDs: `[REQ-{DOMAIN}-{NNN}]` where DOMAIN is a short
  uppercase label (AUTH, CARE, USER, PAY) and NNN is zero-padded from 001
- Requirements with partial evidence get `[INFERRED]`
- Stubbed or incomplete requirements move to Section 10

### 3. Entities & Data Model

All persistent objects discovered. Each entity includes:
- Description and purpose (in business terms)
- Attributes described in plain language
- Relationships to other entities
- Lifecycle states (if applicable)
- Business rules that govern this entity

### 4. User Journeys

End-to-end flows through the system:
- New user journey (first-time experience)
- Core repeated journeys (daily/frequent use)
- Edge case journeys (unusual but valid paths)
- Recovery journeys (when things go wrong)

### 5. Views & Interfaces

Every screen, page, or interaction surface. Each view includes:
- Purpose: Why this view exists
- Information displayed: What the user sees
- Actions available: What the user can do
- Navigation: Where users can go from here
- Role-based variations: How the view changes by user role

### 6. System Behaviors

How the system operates autonomously:
- Scheduled processes (recurring jobs)
- Triggered automations (event-driven actions)
- Background calculations
- Notification logic and delivery rules

### 7. Logic & Calculations

All formulas, algorithms, and decision trees:
- Expressed in plain language
- With concrete worked examples
- With boundary conditions and limits

### 8. External Connections

Integrations with outside systems:
- What connects and why
- What data flows in each direction
- What happens when connections fail

### 9. Security & Privacy

- Who can access what (roles and permissions)
- How data is protected
- Authentication approach (described functionally)
- Sensitive data handling

### 10. Future Considerations

Items that appear stubbed, incomplete, or partially implemented:
- Describe the intended capability
- Note what evidence suggests it was planned
- Flag as deferred for PO decision

### JSON Metadata Block

Placed between Section 10 and Section 11, fenced with ` ```json `.

```json
{
  "application_type": "<HEALTHCARE | FINTECH | SAAS | ECOMMERCE | SOCIAL | EDUCATION | PRODUCTIVITY | CONTENT | MARKETPLACE | DEVTOOLS | GENERIC>",
  "features": ["<feature_name_1>", "<feature_name_2>"],
  "tech_stack": {},
  "data_models": [{"name": "<EntityName>", "attributes": ["<attr1>", "<attr2>"]}],
  "recipe_type": "<web_app | api_service | mobile_app | cli_tool | null>",
  "supporting_recipe_types": [],
  "as_built_metadata": {
    "original_stack": {"language": "<lang>", "framework": "<fw>"},
    "product_domain": "<inferred domain>",
    "user_roles": ["<role1>", "<role2>"],
    "confirmed": "<count>",
    "inferred": "<count>",
    "gaps": "<count>",
    "open_questions": "<count>",
    "conflicts": "<count>",
    "risks": "<count>"
  }
}
```

Rules:
- `tech_stack` MUST be empty `{}` — the new stack is chosen at build time
- `application_type` is an uppercase domain code
- `features` lists each feature area name as a short string
- `data_models` lists each entity with plain-language attribute names
- `recipe_type` inferred from the product:
  - Web applications with server-rendered pages: `web_app`
  - REST/GraphQL API services: `api_service`
  - Mobile applications: `mobile_app`
  - CLI tools: `cli_tool`
  - If unclear: `null`

### 11. Review

```markdown
## 11. Review

### Open Questions
Decisions requiring Product Owner input before building.
- **[OQ-NNN]** [Question text]
  - Context: [Why this matters]
  - Options: [A, B, C if applicable]
  - Default assumption: [What we'll assume if no answer]
  - Affects: [REQ-IDs or sections impacted]

### Conflicts
Cross-source contradictions surfaced during analysis.
- **[CONFLICT-NNN]** [Description]
  - Source A says: [finding]
  - Source B says: [finding]
  - Recommended resolution: [suggestion]

### Risk Register
Potential issues discovered during analysis.
- **[RISK-NNN]** [Description] — Severity: [HIGH/MEDIUM/LOW]
  - Evidence: [what signals this risk]
  - Recommended action: [suggestion]

### Source Provenance
For each major feature area, which wiki pages contributed to the findings.
| Feature Area | Wiki Sources | Key Evidence |
```

---

## Wiki Page to Spec Section Mapping

When formalizing wiki content into spec sections, use this mapping to identify
which wiki pages inform each spec section:

| Wiki Page | Spec Section | What to Extract |
|-----------|-------------|-----------------|
| `product/overview.md` | 1. Overview | Domain, users, scope, boundaries |
| `product/features-and-capabilities.md` | 2. Features | Feature inventory, platform coverage |
| `product/users-and-personas.md` | 2. Features (user roles), 1. Overview | Role definitions, capabilities |
| `engineering/data-and-entities.md` | 3. Entities & Data Model | Schema, relationships, lifecycle |
| `product/journeys-and-flows.md` | 4. User Journeys | End-to-end flows, branching |
| `design/information-architecture.md` | 5. Views & Interfaces | Screens, navigation, layout |
| `engineering/system-behavior.md` | 6. System Behaviors, 7. Logic & Calculations | Jobs, automations, algorithms |
| `engineering/interfaces-and-integrations.md` | 8. External Connections | APIs, third-party services |
| `product/roles-and-permissions.md` | 9. Security & Privacy | Auth model, access control |
| `operations/risks-and-known-gaps.md` | 11. Review (risks) | Risk register entries |
| `review/product-owner-questions.md` | 11. Review (open questions) | Unanswered decisions |
| `product/decision-log.md` | Cross-cutting | Accepted decisions affect any section |
| `design/ux-observations.md` | 5. Views & Interfaces | Friction, usability issues |
| `design/content-and-terminology.md` | 3. Entities (naming) | Domain vocabulary |
| `engineering/analytics-and-observability.md` | 6. System Behaviors | Monitoring, audit |
| `operations/release-and-support.md` | 10. Future Considerations | Deployment gaps |

### Multi-Root Workspace Synthesis

For workspaces with multiple roots, produce:
1. One spec per root (focused on that root's contribution)
2. One workspace-level synthesis spec that:
   - Unifies entity definitions across roots
   - Maps cross-root data flows (e.g., API calls from frontend to backend)
   - Identifies shared user roles across surfaces
   - Surfaces cross-root contradictions as `[CONFLICT]` entries
   - Documents which root implements which features
