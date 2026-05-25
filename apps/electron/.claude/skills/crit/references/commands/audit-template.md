# Command: audit-template

Show the six-lens audit framework on demand. No browser, no URL, no scoring: just the framework.

## Usage

```
/audit-template
```

## When to use

- User wants to understand the Crit method before requesting an audit
- A prospect or peer wants to see "how Crit thinks" without running it
- Self-audit reference for a team building their own version
- Sales conversation: "what's in your audit?"

## Workflow

### 1. Read the template

Read the contents of `templates/audit-template.md` (relative to the skill's installed location).

### 2. Display in chat

Present the framework with a brief framing line:

```
Crit's six-lens audit framework (v1.0):

[paste template content]

To run this against a real URL: /audit <url>
For a quick top-5 scan: /audit-quick <url>
For deeper paired remediation: contact Victoria via victoriamarafetti.com
```

### 3. Stop

Do NOT offer to apply the framework unless asked. Showing the template is the entire job.

## Why this command exists

The framework is the product. Showing it freely (rather than gatekeeping behind a sales call) demonstrates the AI-native promise: agents can run the first 80% transparently. The 20% that converts to paid is the designer judgment on top.
