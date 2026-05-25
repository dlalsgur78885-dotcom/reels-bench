# Command: audit-quick

Top 5 critical issues only. Returns as a chat message, no file written.

## Usage

```
/audit-quick <url>
```

## When to use

- User wants a fast pulse on a site before committing to a full audit
- A prospect is on a call and asks "what would you flag on our site"
- Self-checking before publishing a feature

## Workflow

### 1. Capture (minimal)

- Open URL via `mcp__claude-in-chrome__navigate`
- `mcp__claude-in-chrome__get_page_text` for content + headings
- One `mcp__claude-in-chrome__javascript_tool` call to capture structural signals:
  - Heading counts (h1..h6)
  - Landmark presence (main, nav, footer)
  - Skip link presence
  - Image count and empty-alt count
  - Viewport meta
  - Meta description and og:title
- One screenshot for visual reference

Do NOT run full contrast sampling, motion inspection, or detailed heuristic review. Save that for `/audit`.

### 2. Identify top 5 critical issues

Look for the highest-leverage problems first:

1. **Compliance blockers**: missing landmarks, multiple h1, no skip link, broken hierarchy (these are most-likely Critical severity)
2. **Trust killers**: visible placeholder text, broken stats, dev overlays leaking, copy typos in hero
3. **Conversion blockers**: unclear value proposition, missing primary CTA, broken or hidden contact path
4. **Brand expression breaks**: em-dashes if user has saved preference, mismatched typography, generic AI-slop visual patterns
5. **Acute a11y issues**: color contrast on hero subtitle, missing alt on portfolio images, no focus states on primary CTAs

Pick the FIVE most consequential. No more. If the site has fewer than five, return what's there honestly.

### 3. Format output

Return in chat (no file). Each finding uses a compact version of the full audit format: plain-language title, severity/audience metadata, brief "What's happening" + "What to do", standards footer:

```
Quick audit of <url>

1. [Plain-language title]
   Severity: [Critical / High / Medium / Low] · For: [PM | designer | engineer | founder]
   What's happening: [1–2 sentences, no jargon]
   What to do: [1–2 numbered steps]
   Standards: [Nielsen #5 / WCAG 2.4.7 / AI Guideline #11 / Dark pattern: Roach Motel / etc.]

2. [next finding, same structure]
3. ...
4. ...
5. ...

For the full six-lens audit with prioritized fix list, run /audit <url>.
For paired remediation, get in touch via victoriamarafetti.com.
```

### 4. Stop

Do NOT offer to expand into a full audit unless asked. The user picked `audit-quick` for a reason.

## Time target

5–10 minutes from invocation to delivery.

## Failure modes

Same as `/audit`. If the URL can't load, say so and stop.
