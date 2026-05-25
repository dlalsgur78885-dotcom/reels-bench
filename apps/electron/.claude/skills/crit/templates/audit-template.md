# Crit Audit: [Product Name or URL]

**Audited by:** [Auditor name]
**Date:** [YYYY-MM-DD]
**URL audited:** [link]
**Audit framework version:** v1.1
**Time invested:** [hours]

---

## Executive Summary

[3–5 sentences. Cover:]
- Overall design quality (1–10 + one-word verdict: e.g., "8: polished")
- Top 3 critical issues in plain language
- Estimated total remediation effort (e.g., "~12 hours of focused work")
- One-line recommendation: ship as-is / quick polish / structural rework

---

## Scoring Conventions

**Severity**

| Level | Meaning |
|---|---|
| **Critical** | Blocks compliance (WCAG/EAA/EU DSA), breaks UX, or causes significant trust loss |
| **High** | User-noticeable degradation in quality, conversion, or trust |
| **Medium** | Visible to designers and PMs; affects polish, not function |
| **Low** | Refinement opportunity for craft-conscious teams |

**Effort**

| Level | Meaning |
|---|---|
| **S** | Under 1 hour |
| **M** | 1–4 hours |
| **L** | 1+ day or requires design rework |

**Heuristic tag conventions**

Every finding cites the specific principle or standard violated. Examples:
- `Nielsen #5 Error prevention`
- `WCAG 2.4.7 Focus Visible`
- `EAA / WCAG 2.2 AA`
- `AI Guideline #11 Make clear why the system did what it did` (Microsoft HAI)
- `Dark pattern: Roach Motel` (cite `EU DSA Art. 25` where applicable)
- `Victoria Principle #3 Stability over cleverness`
- `Kowalski / Krehel / Tompkins motion principles`

---

## How to read this report

This report has two parts:

1. **Prioritized Fix List** below — the **action list**. Every finding is severity-scored, audience-tagged, written in plain language, and tells you exactly what to do. Read this top to bottom and you have a punch list.
2. **Coverage sections** further down (one per lens) — the **evidence**. Raw counts, exact measurements, pass-rates per check, and what was inspected under each of the six lenses. Each finding in the list above cross-references back to its measurement here. Read these when you want to see *what was actually checked*, or hand the numbers to an engineer.

The findings are not duplicated between the two parts. The action is in part 1, the proof is in part 2.

---

## Prioritized Fix List

Top 10–15 issues across all six lenses, ordered by severity descending, then effort ascending within severity.

Each finding follows this structure so a non-technical buyer can act on it:

- **Plain-language title** (no jargon, no standards numbers in the headline)
- **Metadata line**: severity · effort · audience tag (`For PM` / `For designer` / `For engineer` / `For founder`, or multiple)
- **What's happening**: the issue described in 2–4 sentences without jargon
- **Why this matters**: 2–3 concrete business or UX consequences
- **What to do**: numbered, actionable steps with effort notes where useful
- **Standards footer** (italics, at the bottom): heuristic citation, verification note

---

### Finding 1: [Plain-language title]

**Severity:** [Critical / High / Medium / Low] · **Effort:** [S (under 1hr) / M (1–4hr) / L (1+ day)] · **For:** [PM | designer | engineer | founder]

**What's happening**

[2–4 sentences in plain language. If a technical term is necessary, define it in context. The goal: a non-technical reader can understand the issue without prior knowledge.]

**Why this matters**

- [Concrete business or UX consequence 1]
- [Consequence 2]
- [Consequence 3]

**What to do**

1. [Step 1, with effort context if helpful]
2. [Step 2]
3. [Optional: alternative approach or further context]

*Standards: [Heuristic citation, WCAG criterion, dark-pattern name, Victoria principle, etc.]. [Optional verification note.]*

---

### Finding 2: [Plain-language title]

[Repeat the same structure for every finding.]

---

---

*The findings above are the action list. The sections below document what was measured under each of the six lenses. Findings cross-reference back to these measurements with "See Finding N" — there is no duplication.*

---

## Coverage: 1. Accessibility (what was measured)

WCAG 2.2 AA / EAA-aligned. EU Accessibility Act enforceable since June 2025. Penalties up to €3M for non-compliance on B2B SaaS serving EU customers.

### Color contrast
[Tested against WCAG 2.2 AA: 4.5:1 for body text, 3:1 for large text and UI components.]

### Semantic HTML and ARIA
[Heading hierarchy, landmarks, ARIA usage, role correctness.]

### Keyboard navigation
[Tab order, skip links, escape patterns, focus traps.]

### Focus states
[Visible focus indicators on all interactive elements.]

### Image alt text
[Decorative vs informative, proper alt strategy.]

### Form labels
[Explicit labels, error association, autocomplete attributes.]

### Motion sensitivity
[Respect for `prefers-reduced-motion`.]

### Heading hierarchy
[Single H1, logical H2/H3 progression.]

---

## Coverage: 2. Motion and Interaction (what was measured)

Per Emil Kowalski / Jakub Krehel / Jhey Tompkins motion principles. Also informed by principles 3 (stability) and 11 (calm UX) from `references/principles/design-principles.md`.

### Easing
[Ease curves used. Standard easings vs custom. Linear motion is almost always wrong.]

### Duration
[150–250ms for micro-interactions. 250–400ms for transitions. Long durations need a reason.]

### Purpose and intent
[Does each animation answer "what just happened?" or "what's about to happen?"]

### Anticipation, response, completion
[Three-act structure for meaningful interactions.]

### Hover, focus, active states
[Coverage and consistency across interactive elements.]

### Page transitions
[Continuity, shared element transitions, perceived performance.]

### Reduced-motion fallback
[Static or simplified version when user prefers reduced motion.]

---

## Coverage: 3. UX Heuristics with dark-pattern detection (what was measured)

Nielsen 10 plus Victoria's 18 design principles at `references/principles/design-principles.md`, plus product-specific heuristics, plus a dedicated scan for B2B-relevant dark patterns.

### Visibility of system status
[Loading states, progress, confirmation feedback.]

### Match to real-world conventions
[Familiar patterns vs invention.]

### User control and freedom
[Undo, cancel, exit paths.]

### Consistency
[Internal consistency across pages, plus alignment with platform conventions.]

### Error prevention
[Inline validation, confirmation for destructive actions, sensible defaults.]

### Recognition over recall
[Visible options, contextual help, breadcrumbs.]

### Flexibility and efficiency
[Shortcuts, advanced patterns for power users without burdening novices.]

### Aesthetic and minimalist
[Information density, visual noise, restraint.]

### Help users recognize, diagnose, recover from errors
[Error message clarity, recovery paths, helpful copy.]

### Help and documentation
[In-product help, empty states, onboarding.]

### Cognitive load (principles 4, 13, 15)
[Number of competing choices, hierarchy clarity, progressive disclosure, anxiety reduction.]

### Confirmation patterns (principles 5, 6, 7)
[Necessary vs lazy confirmation dialogs. Inline vs modal. Snackbar usage match to message importance.]

### Product-specific
[Value proposition clarity, primary CTA hierarchy, navigation logic, conversion path.]

### Dark patterns (with legal exposure flagging)

Scan for these B2B-relevant dark patterns. Flag Critical when legal exposure exists (EU DSA Art. 25, FTC click-to-cancel), High when only trust damage:

- **Roach Motel**: easy to sign up, hard to cancel
- **Forced Continuity**: free trial silently converts to paid
- **Confirmshaming**: guilt-trip copy on opt-out (e.g., "No thanks, I don't want to save money")
- **Hidden Costs**: fees revealed only at the final checkout step
- **Preselection**: sensitive toggles (data sharing, marketing emails) opted-in by default
- **Sneak-into-Basket**: items added without explicit user action
- **Disguised Ads**: sponsored content not visibly marked

Cite [EU Digital Services Act Article 25](https://digital-strategy.ec.europa.eu/en/policies/digital-services-act) and the [FTC Negative Option Rule](https://www.ftc.gov/legal-library/browse/rules/negative-option-rule) where applicable.

---

## Coverage: 4. UI Baseline (what was measured)

Per `baseline-ui` + principles 10, 16, 17. Opinionated UI baseline to prevent generic interface output and enforce craft.

### Design system in use

[Programmatic detection: did the page build on a known design system, or is it hand-rolled? This label changes how every drift finding below should be read — drift from an existing system is "team isn't following their own rules," drift in a custom build is "no system exists yet."]

**Detected:** [shadcn / MUI / Chakra / Mantine / Ant Design / Bootstrap / Tailwind / Radix / styled-components / Emotion / custom / mixed]
**Confidence:** [high / medium / low]
**Evidence:**
- [e.g., `--background --foreground --primary` HSL custom properties on `:root` (shadcn signature)]
- [e.g., `data-state` and `data-orientation` attributes on dropdown menu (Radix primitives)]
- [e.g., Tailwind atomic class soup in 80%+ of sampled elements]

**Implication for findings below:** [If a system is detected: recommendations should cite the system's canonical component or token (e.g., "use the shadcn `Button` primitive instead of the bespoke `.custom-button` rule"). If custom: recommendations should propose extracting the most-repeated values into named tokens and naming a target system if appropriate.]

### Token coverage

[How much of the styling comes from CSS custom properties (design tokens) vs hardcoded values. Token-driven styling is theme-able, easier to keep consistent, and is the foundation of any design system. Hardcoded styling is brittle at scale.]

**Coverage:** [High / Medium / Low / None]
**Tokens defined:** [count, e.g., 47] · **Sample names:** [`--color-bg`, `--color-fg`, `--space-1`, `--radius-md`, ...]
**Usage:** [e.g., "of 1,240 declarations in same-origin stylesheets, 612 (49%) reference `var(--*)`"; or "could not be measured because most stylesheets are cross-origin"]

[**Implication:** if Low/None and the spacing/color histograms show drift, the recommendation in the Prioritized Fix List is to *introduce* tokens for the most-repeated values. If High, drift findings should be expressed as "value X drifts from the existing `--token-name` of Y."]

### Spacing base unit

[One-line summary computed from the spacing histogram. Gives the designer concrete language to hand to the engineer.]

**Effective base unit:** [e.g., "4 px base unit" / "8 px base unit" / "4 px base unit with frequent off-grid exceptions" / "No discernible base unit — spacing values appear ad hoc"]

[Optional: most-used spacing values, e.g., "0 / 4 / 8 / 12 / 16 / 24 / 32 / 48 (covers 88% of declarations)"]

### Typography
[Type scale, hierarchy, line height, measure (line length), legibility at common sizes.]

### Color system
[Palette intentionality, semantic colors, dark mode handling, brand consistency.]

### Spacing rhythm
[Grid system, padding/margin consistency, rhythm vs randomness.]

### Consistency drift (programmatic scan)

[Result of the Consistency Scan run during capture. Reports drift from the implicit design scale: values used 1–3 times that fall just off a scale most of the page is using. Catches the 3 px → 13 px → 8 px pattern, near-duplicate grays, line-heights that break typographic ratio, off-scale font sizes.]

**How to read this table:** the *Likely scale* column shows the values that dominate the page (the implicit design system). *Off-scale values* shows the outliers and where they appear. If the off-scale values are intentional (a brand exception, a one-off banner), note it; otherwise flag as a finding.

| Property | Likely scale (value × count) | Off-scale values (value × count, sample selector) | Recommendation |
|---|---|---|---|
| `font-size` | e.g., 14 × 312, 16 × 188, 24 × 41 | 13 × 2 (`.callout-meta`), 15 × 1 (`.hero-eyebrow`) | Round to nearest scale value or add to scale intentionally |
| `line-height` | e.g., 1.5 × 240, 1.2 × 78 | 1.37 × 4 (`.feature-card p`) | Normalize to 1.5 |
| `margin-top` | e.g., 0 × 880, 8 × 120, 16 × 88, 24 × 42 | 3 × 1, 7 × 2, 13 × 3 | Snap to 4 px / 8 px base unit |
| `padding-left` | e.g., 16 × 200, 24 × 90 | 13 × 1, 18 × 2 | Snap to scale |
| `border-radius` | e.g., 8 × 140, 4 × 60 | 6 × 1, 9 × 1 | Consolidate to two-value radius scale |
| `color` (text) | e.g., #1a1a1a × 410, #555 × 88 | #5b5b5b × 2, #1c1c1c × 1 | Consolidate near-duplicate grays into tokens |
| `box-shadow` | e.g., elevation-1 × 30, elevation-2 × 12 | one-off shadow on `.promo-card` | Move to shared elevation token |

[Promote the highest-impact drift findings into the Prioritized Fix List above (severity Medium by default, High if drift creates visible jank, Low if imperceptible and tokens-only).]

### Component consistency (principle 3)
[Buttons, inputs, cards: visual and behavioral consistency. No layout jump.]

### Visual density
[Information per screen, breathing room, hierarchy through space.]

### Imagery and iconography
[Style consistency, quality, purpose. Lucide for icons preferred.]

### White space
[Intentional vs accidental. White space as a design tool.]

### Button hierarchy (principle 16)
[Primary, secondary, optional actions instantly identifiable. No equally weighted CTAs.]

### Brand expression
[Visual personality consistent with stated positioning.]

---

## Coverage: 5. AI Interaction (what was measured)

Audits how AI features behave from the user's perspective: confidence, scope, citation, correction, control. Skip this section only if the product has zero AI surfaces (rare in B2B SaaS 2026). Calibrated against [Microsoft Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/) and Victoria's principle 18 (AI UX still obeys usability fundamentals).

### Confidence signaling
[Does the UI show when the AI is unsure? Are uncertain outputs visually distinguished from confident ones?]

### Scope clarity
[Does the user know what the AI can and cannot do upfront, or do they discover capabilities through failure?]

### Source citation
[When the AI produces facts or recommendations, can the user trace them to a source?]

### Correction support
[When the AI gets it wrong, can the user easily correct it? Is the correction preserved across the session?]

### Undo and control
[Can the user undo AI actions? Does the user remain in control of consequential decisions (send, delete, purchase, publish)?]

### Graceful degradation
[When the AI is unavailable, slow, or wrong, does the UI fail in a usable way or block the user?]

### Data use transparency
[Is the user told how their input is used (training, retention, sharing)? Surfaced where decisions are made, not buried in a privacy policy?]

### Initial / during / on-error / over-time states
[Per Microsoft's HAI Guidelines, each of these four phases of the AI interaction must be designed for, not just the happy path.]

---

## Coverage: 6. Agent Readability (what was measured)

Audits how well the site is consumable by AI agents (Claude, ChatGPT, Perplexity, Gemini, custom AI tools). Distinct from lens 5: this lens audits how the site is consumed BY AI, not the AI features ON the site.

### llms.txt presence and quality
[Is there a `/llms.txt` or `/.well-known/llms.txt` file? Does it accurately describe the site's purpose, key URLs, and content priorities? Standard introduced by Jeremy Howard and Answer.AI in late 2024.]

### robots.txt directives for AI bots
[Explicit allow/disallow for GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, OAI-SearchBot. Silence is ambiguous.]

### Structured data (JSON-LD / Schema.org)
[Person, Organization, Service, Product, Article, FAQPage, HowTo. Lets agents understand structured facts rather than scrape prose.]

### Open Graph + Twitter Card meta
[Used by agents and link-unfurling services as a fast summary surface.]

### Content extractability (SSR vs SPA shell)
[Can an AI fetcher that does not execute JavaScript get the content? If the value prop only renders after React hydration, agents see "Loading…".]

### Stable anchor IDs on headings
[Sections need stable `#section-id` for AI citation. Random or missing IDs make citations fragile.]

### Semantic action affordances
[Are CTAs and buttons described semantically ("Book a 30-minute design audit call") rather than generically ("Click here")?]

### MCP server presence (forward-looking)
[Does the business expose a Model Context Protocol server that agents can query directly? Rare today, increasingly expected as a 2026-onwards growth dimension.]

### Bot mitigation false-blocks
[Does Cloudflare or similar layer accidentally block legitimate AI agent user agents? Trade-off: protect from scrapers vs welcome AI traffic.]

---

## Notes and Methodology

**Tools used:**
- Browser automation (Chrome MCP)
- Manual inspection
- Reference frameworks: `rams`, `design-motion-principles`, `baseline-ui`, `fixing-accessibility`, `web-interface-guidelines`
- Victoria's 18 design principles (see `references/principles/design-principles.md`)
- Microsoft Guidelines for Human-AI Interaction (for AI lens)
- Brignull's dark pattern taxonomy

**Limitations:**
[What was not audited and why. E.g., authenticated flows, mobile-specific behaviors, performance under load, AI features that require login to test.]

**Sources for severity calibration:**
- WCAG 2.2 AA criteria
- European Accessibility Act (enforceable June 2025)
- EU Digital Services Act Article 25 (dark patterns, in force February 2024)
- FTC Negative Option Rule (click-to-cancel)
- Nielsen Norman Group heuristic catalog
- Microsoft Guidelines for Human-AI Interaction
- Victoria's 18 design principles
- Baymard Institute UX research (where applicable to e-commerce or B2B SaaS patterns)
