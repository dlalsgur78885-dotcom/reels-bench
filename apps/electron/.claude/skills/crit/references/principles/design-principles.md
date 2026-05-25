# Victoria's Design Principles

These 18 principles are how I think about product design. They are the calibration spine for Crit's heuristic and UI-baseline lenses, applied across all six audit passes to decide what gets flagged as Critical versus Low.

If you install Crit, every audit it produces is shaped by these. They're opinionated on purpose.

By Victoria Marafetti.

---

## 1. Master usability fundamentals first

The foundation matters more than novelty.

- Prioritize clarity over cleverness.
- Follow established interaction patterns unless there is a strong reason not to.
- Avoid reinventing common UI behavior.
- Reduce cognitive load aggressively.
- Users should not have to "figure out" the interface.
- Strong products feel obvious in retrospect.

**Anti-patterns**
- Over-designed interactions
- "Creative" flows that hurt usability
- Components behaving inconsistently
- Excessive motion or visual noise
- Hidden actions / ambiguous affordances

---

## 2. Design for the actual product category

Do not import UX patterns from unrelated products.

A B2B enterprise workflow is not Figma, Slack, Linear, Notion, or consumer social apps. Context matters.

**Principle.** Interaction patterns must match: engagement frequency, user intent, workflow complexity, emotional context, task urgency.

**Example.** Just because a pattern works in a collaborative creative tool does not mean it belongs in hiring workflows.

---

## 3. Stability over cleverness

Interfaces should feel visually and behaviorally stable.

**Avoid**
- Components resizing dynamically while interacting
- Layout jumping
- Unpredictable transitions
- Multi-select patterns that rearrange themselves
- UI elements changing location during selection

**Favor**
- Spatial consistency
- Predictable positioning
- Fixed interaction zones
- Stable sizing
- Calm interfaces

---

## 4. Reduce cognitive load relentlessly

Every additional decision costs attention.

**Prefer**
- Fewer visible choices
- Clear hierarchy
- Progressive disclosure
- Defaults that help users move forward
- Obvious primary actions

**Avoid**
- Multiple competing CTAs
- Too many actions visible simultaneously
- Over-explaining
- Redundant options
- Interfaces that require interpretation

---

## 5. Confirmation dialogs should be rare

Generic confirmation modals are often lazy UX.

**Risk framework:** probability of accidental action × severity of consequence.

- **Low probability + low consequence** → no confirmation. (Closing forms, cancel buttons, navigating away.)
- **High probability + high consequence** → confirmation justified. (Deleting important work, irreversible destructive actions.)

---

## 6. Inline confirmations over modal confirmations

Especially for deletion flows.

**Avoid** generic "Are you sure?": removes context, interrupts flow, feels like cover-your-ass UX.

**Prefer** inline confirmations that keep the item visible, preserve context, and clarify exactly what will happen.

**Example.** Instead of "Delete work experience?": show an inline expanded state with the job title, consequences, and an explicit inline delete action.

---

## 7. Don't misuse snackbars or modals

Feedback patterns must match importance.

**Snackbars.** Good for lightweight confirmations, undo opportunities, temporary feedback. Not for critical information, required decisions, or long explanations.

**Modals.** Use sparingly. A modal interrupts the user's mental flow. Ask: "Does this truly deserve interruption?"

---

## 8. Product thinking over visual polish

Pretty UI is not enough.

Strong design demonstrates: prioritization, systems thinking, business understanding, workflow awareness, edge-case thinking, operational realism.

The best designs solve real workflow problems cleanly.

---

## 9. Design for present reality, not hypothetical future complexity

Avoid over-future-proofing.

**Don't** add complexity "just in case," optimize for imaginary scale, or introduce abstractions too early.

**Do** solve the current problem elegantly, evolve systems incrementally, wait for complexity to become real.

---

## 10. Standard patterns exist for a reason

Users bring learned behavior. Favor recognizable forms, familiar controls, expected interactions.

Novelty should happen only where it creates clear value.

---

## 11. UX should feel calm

Strong UX reduces anxiety. Good interfaces feel steady, trustworthy, intentional, quiet, confident.

Avoid hyperactive UI, excessive feedback, animation overload, constantly changing states.

---

## 12. Separate trendy ideas from durable ideas

Experimental ideas are allowed. They should be consciously chosen.

- **Safe / durable.** Proven patterns, predictable UX, usability-first decisions.
- **Trendy / experimental.** AI-native interactions, unconventional navigation, dynamic systems, conversational interfaces.

The team should know which category something belongs to.

---

## 13. Multi-step workflows should feel linear and comprehensible

Users should always know where they are, what happened, what happens next.

Avoid fragmented flows, disconnected states, ambiguous transitions.

---

## 14. Systems thinking matters

Design is not just screens.

Think about state transitions, operational consequences, data dependencies, permissions, lifecycle states, downstream workflows.

---

## 15. Strong UX removes unnecessary anxiety

Users should not constantly fear losing work, making mistakes, or missing information.

Good UX builds confidence through predictability, transparency, context, sensible defaults, recoverability.

---

## 16. Buttons and actions should reflect hierarchy clearly

Users should instantly understand the primary action, secondary action, and optional action.

**Avoid**
- Equally weighted actions
- Ambiguous button groups
- Icon-only ambiguity without context

---

## 17. Enterprise UX should optimize for efficiency, not entertainment

The goal is speed, clarity, reliability, confidence. Not delight for its own sake.

---

## 18. AI UX should still obey usability fundamentals

Even AI-native experiences must preserve clarity, communicate system state, establish trust, explain reasoning when necessary, and avoid magic / confusion.

AI should reduce ambiguity, not increase it.
