# Command: audit

Full six-lens audit on a URL. Outputs a written markdown report.

## Usage

```
/audit <url>
```

Example: `/audit https://example.com`

## Workflow

### 1. Validate input

- Confirm the URL is well-formed and reachable.
- If no URL provided, ask once: "Which URL should I audit?"
- If URL requires authentication, stop and explain: "Crit v1 audits public surfaces only. Authenticated flows are on the roadmap."

### 2. Capture

Open the URL in the browser via Chrome MCP tools and capture:

- **Page text**: `mcp__claude-in-chrome__get_page_text`
- **Accessibility tree**: `mcp__claude-in-chrome__read_page` (filter: all, depth 8–15 depending on page size)
- **DOM and computed style queries**: `mcp__claude-in-chrome__javascript_tool` for:
  - Heading counts and hierarchy (`h1`..`h6`)
  - Landmark presence (`main`, `nav`, `footer`, `aside`)
  - Skip link presence
  - Image count and `alt` strategy
  - Form count, button count, link count
  - Meta tags (title, description, OG, viewport, lang)
  - Font loading
  - Contrast samples across 25–30 representative text nodes
  - `prefers-reduced-motion` media query presence
  - **Consistency scan** (feeds the UI Baseline lens): walk every visible element (skip `display: none`, SVG internals, and shadow roots) and collect `getComputedStyle` values for each of these properties into a frequency histogram: `font-size`, `line-height`, `letter-spacing`, `font-weight`, `margin-top`, `margin-right`, `margin-bottom`, `margin-left`, `padding-top`, `padding-right`, `padding-bottom`, `padding-left`, `gap`, `column-gap`, `row-gap`, `border-radius`, `color`, `background-color`, `border-color`, `box-shadow`. Output one map per property: `{ value: count, sampleSelectors: [up to 3] }`. Sort by count descending. This data drives the Consistency Drift sub-section under UI Baseline.
  - **Design system fingerprinting** (feeds the UI Baseline lens): collect the following signals so the analysis step can decide whether the page is built on a known design system or hand-rolled:
    - **Stylesheet and script URLs.** Read `document.styleSheets[*].href` and all `<script src>` URLs. Match against known package names: `mui`, `@mui`, `material-ui`, `chakra`, `mantine`, `antd`, `ant-design`, `bootstrap`, `tailwind`, `radix-ui`, `headlessui`, `styled-components`, `emotion`, `vanilla-extract`.
    - **Class name prefixes.** Sample class names from ~100 visible elements. Match prefixes: `Mui*` (MUI), `chakra-*` (Chakra), `mantine-*` (Mantine), `ant-*` (Ant Design), `bs-*` / `btn-*` / `container` / `row` / `col-` (Bootstrap), `sc-*` (styled-components), `css-*` (Emotion), Tailwind atomic utilities (many short class names per element from a fixed vocabulary like `flex items-center gap-4 p-2`).
    - **Data attributes.** Look for `data-state`, `data-side`, `data-orientation`, `data-radix-*`, `data-mui-*`, `data-headlessui-*` on at least one element.
    - **CSS custom property names.** Read `getComputedStyle(document.documentElement)` and extract all `--*` property names. Match prefixes: `--mui-*`, `--chakra-*`, `--mantine-*`, `--bs-*` (Bootstrap), `--color-*` (Tailwind v4), and the shadcn signature triple `--background --foreground --primary` defined in HSL component form (e.g., `0 0% 100%`).
    - **Output.** Return a short object: `{ detected: "shadcn" | "MUI" | "Chakra" | "Mantine" | "Ant Design" | "Bootstrap" | "Tailwind" | "Radix" | "styled-components" | "Emotion" | "custom" | "mixed", confidence: "high" | "medium" | "low", evidence: [list of matched signals] }`.
  - **Token usage scan** (feeds the UI Baseline lens): count CSS custom properties (design tokens) defined and used.
    - **Tokens defined.** Count `--*` property names declared on `:root`, `html`, `body`, and `[data-theme]` selectors. Report the total and a sample of names (first 15).
    - **Token usage signal.** For same-origin stylesheets, iterate `document.styleSheets[*].cssRules` and count declarations whose value contains `var(--`. Compare against total declarations. (Cross-origin stylesheets throw on `cssRules` access — note them as inaccessible rather than failing.)
    - **Output.** `{ tokensDefined: number, sampleTokens: string[], declarationsTotal: number, declarationsUsingVar: number, inaccessibleStylesheets: number }`. The analysis step uses this to label token coverage as High / Medium / Low / None.
- **Screenshot**: at least one viewport screenshot for visual reference (`mcp__claude-in-chrome__computer` with `action: screenshot`)
- **Console errors**: `mcp__claude-in-chrome__read_console_messages` with pattern `error|warning`
- **Network**: optional; `mcp__claude-in-chrome__read_network_requests` only if performance signals are needed (note: out-of-scope for Crit; refer to Lighthouse)

### 3. Analyze across six lenses

For each lens, identify findings. Refer to the lens definitions in SKILL.md.

- **Accessibility.** Apply WCAG 2.2 AA conformance checks. Cite EAA exposure where the target is EU-facing B2B SaaS.
- **Motion.** Inspect animations identified during capture. Note where reduced-motion verification is needed (mark as "verification recommended" in the report rather than guessing).
- **UX heuristics (with dark-pattern scan).** Apply Nielsen 10 plus Victoria's 18 design principles plus product-specific heuristics (value prop clarity, primary CTA, conversion path, navigation logic). Run the explicit dark-pattern scan from SKILL.md (Roach Motel, Forced Continuity, Confirmshaming, Hidden Costs, Preselection, Sneak-into-Basket, Disguised Ads). Flag dark patterns as Critical when EU DSA Art. 25 or FTC click-to-cancel exposure applies, High otherwise.
- **UI baseline.** Apply `baseline-ui` principles. Inspect typography, color, spacing, components, density. Then run these four programmatic analyses on the data collected in step 2:
  - **Design system in use.** Take the fingerprinting signals and decide the system. `high` confidence requires at least two matching signal categories (e.g., URL match + class prefix match, or CSS custom property prefix match + data attribute match). One signal alone is `medium` at best. Report the detected system, confidence, and the evidence list. If no signals match, state explicitly: `"custom / no detectable design system"`. This label changes how every drift finding below is written: if a system is detected, name its canonical component or token convention in the recommendation (e.g., "use the shadcn `Button` primitive" or "use the MUI `spacing(2)` token"); if it's custom, recommend extracting a token / picking a system.
  - **Token coverage.** Translate the token usage scan into a label: `High` (≥50 tokens defined and most spacing/color declarations use `var()`), `Medium` (10–49 tokens, mixed usage), `Low` (1–9 tokens, mostly hardcoded), `None` (zero tokens defined). Report the label, the count of tokens, a sample of token names, and the implication: high coverage means findings should be expressed as "drift from the existing token system"; low or none means the recommendation is to *introduce* tokens for the most-repeated values surfaced in the drift table.
  - **Spacing base unit.** From the histograms for `margin-*`, `padding-*`, and `gap`, compute the greatest common divisor (GCD) of the top 8 most-used values (ignore 0). State the result in one sentence: `"Spacing follows a 4 px base unit"` / `"Spacing follows an 8 px base unit"` / `"Spacing follows a 4 px base unit with frequent off-grid exceptions"` (when GCD is 4 but ≥10% of values aren't multiples of 4) / `"No discernible base unit — spacing values appear ad hoc"` (when GCD is 1 or 2). This grounds the Consistency Drift findings in concrete language the designer can hand to the engineer.
  - **Consistency Drift.**
    - **Identify the intended scale.** For each property, the top 4–8 most frequent values that together cover ~80% of usage are the implicit scale. For pixel-based properties (`margin-*`, `padding-*`, `gap`, `border-radius`), the scale should approximate the base unit identified above. For `font-size`, expect a clear typographic scale (e.g., 12 → 14 → 16 → 18 → 24 → 32). For `line-height`, expect 2–3 values across the page.
    - **Flag the drift.** Values used 1–3 times that are within ±25% of a scale value but not equal to it are likely drift (the 3px → 13px → 8px → 7px pattern). For colors, near-duplicate values (visually indistinguishable hex pairs, or values within a small ΔE of each other) suggest token drift. Report each flagged value with: the property, the off-scale value, the nearest scale value, count, and 1–3 sample selectors.
    - **Severity calibration.** Default `Medium` (craft / polish). `High` if drift creates visible jank (misaligned columns, uneven rows, jittery vertical rhythm in repeating components). `Low` if the deltas are imperceptible and only matter for token cleanup.
    - **Audience tag.** Always `For designer` and `For engineer` — both need to act (designer defines the scale, engineer enforces it via tokens).
- **AI Interaction.** If the product has AI features (chat, autocomplete, suggestions, agentic flows, copilots), apply the Microsoft Human-AI Interaction Guidelines: confidence signaling, scope clarity, source citation, correction support, undo and control, graceful degradation, data-use transparency, initial / during / on-error / over-time states. If the product has zero AI surfaces, the AI Interaction section in the report should explicitly state this and be brief.
- **Agent Readability.** Audit how well the site is consumable by AI agents that browse, summarize, cite, and act on web content. Check `llms.txt` presence (`/llms.txt` or `/.well-known/llms.txt`), `robots.txt` directives for AI bots (GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, OAI-SearchBot), JSON-LD / Schema.org structured data, Open Graph and Twitter Card meta, content extractability (SSR vs JS-only SPA shell), stable anchor IDs for citation, semantic action affordances, MCP server presence, and bot mitigation false-blocks. Distinct from AI Interaction: lens 5 audits AI features ON the site, lens 6 audits how the site is consumed BY AI.

### 4. Score, tag, and translate every finding

Each finding receives:

- **Severity** (Critical / High / Medium / Low) per SKILL.md definitions
- **Effort** (S / M / L) per SKILL.md definitions
- **Audience tag** (`For PM` / `For designer` / `For engineer` / `For founder`, or multiple). If unclear who should act, the finding isn't actionable enough — rewrite or escalate.
- **Plain-language title** (no jargon, no acronyms, no standards numbers in the headline)
- **What's happening** (2–4 sentences explaining the issue without jargon; define technical terms in context)
- **Why this matters** (2–3 concrete business or UX consequences, not just "fails compliance")
- **What to do** (numbered, actionable steps; name effort estimates where useful)
- **Where** (specific location in the product)
- **Heuristic violated** (the specific principle, standard, or pattern: `Nielsen #5 Error prevention`, `WCAG 2.4.7 Focus Visible`, `AI Guideline #11`, `Dark pattern: Roach Motel`, `Victoria Principle #3`, etc. Goes in the italicized footer of the finding card, NOT in the headline.)

A finding without any of: plain-language title, "What's happening" explanation, "Why this matters" consequences, "What to do" steps, audience tag, or heuristic citation is incomplete and must not appear in the prioritized list.

### 5. Synthesize

Build the report following `templates/audit-template.md`:

1. **Executive summary** (3–5 sentences): overall score, top issues, recommendation
2. **Scoring conventions** (paste from template)
3. **How to read this report** (paste from template — explains the two-tier structure: findings = action, coverage sections = evidence)
4. **Prioritized fix list** (top 10–15 findings, sorted by severity descending, effort ascending within severity)
5. **Coverage sections** (one per lens, H2 named `## Coverage: <N>. <Lens name> (what was measured)`): Accessibility, Motion, UX Heuristics (with dark-pattern scan), UI Baseline, AI Interaction, Agent Readability. These are **measurement and methodology** — exact counts, pass-rates per check, what was inspected — **not duplicate findings**. Cross-reference back to the findings with "See Finding N" where a measurement led to one. If a check produced no significant finding, state that ("Forms: N/A. No forms on the page.") so the reader sees the coverage is honest.
6. **Notes and methodology**: tools used, limitations, version

### 6. Write report

- File path: `audits/<sanitized-domain>-<YYYY-MM-DD>.md`
- Sanitize domain: replace `.` with `-`, strip `www.`, lowercase
- Example: `audits/example-com-2026-05-16.md`
- Create the `audits/` directory if it does not exist
- If a file with this name already exists, append `-2`, `-3`, etc.

### 7. Verify before delivery

Run the Output Verification checks defined in SKILL.md. If any check fails, fix before returning to the user.

### 8. Deliver

Tell the user:

- Where the report was saved
- Headline finding (top critical issue in one sentence)
- Count of findings by severity
- Whether any limitations significantly impact confidence in the audit

## Failure modes to handle

- **URL won't load**: return clearly: "Could not load <url>. Confirm it's public and reachable."
- **Bot protection (Cloudflare, 403)**: note the limitation in the report, audit what can be inspected, name what was blocked
- **JavaScript-heavy SPA with delayed render**: wait 2–3 seconds after navigate, then re-capture
- **Browser tools unavailable**: explain: "Crit v1 requires browser automation. Install Chrome MCP and retry."
