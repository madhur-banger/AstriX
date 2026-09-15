# Accessibility Fundamentals

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Accessibility (a11y) is frequently treated as a checklist bolted on at the end of a project. In practice most of it is a byproduct of using the right HTML element in the first place — the checklist only grows large when that first step gets skipped.

## WCAG Levels

The Web Content Accessibility Guidelines (WCAG, maintained by the W3C) define three conformance levels:

- **A** — the minimum: basic accommodations like alt text on images, no content that relies purely on color to convey meaning. Rarely sufficient on its own for a real product.
- **AA** — the practical, real-world bar. This is what nearly every accessibility law references — the ADA in the US (via case law and DOJ guidance), the EU's European Accessibility Act, the UK's Public Sector Bodies Accessibility Regulations — and what essentially every enterprise procurement checklist and accessibility audit targets. "WCAG compliant" without a level specified almost always means AA in practice.
- **AAA** — the strictest level, including requirements like a 7:1 color contrast ratio (vs. AA's 4.5:1) and no auto-playing audio ever. WCAG itself states AAA isn't recommended as a general policy for entire sites, because some AAA criteria are genuinely impossible to satisfy for certain kinds of content (e.g. sign-language interpretation for all video).

For most teams, "target AA" is the entire policy decision — it's specific enough to audit against and realistic enough to actually hit.

## Semantic HTML Is the Foundation

The single highest-leverage accessibility decision on any page is using the HTML element built for the job, instead of a generic `<div>` with JavaScript bolted on to approximate its behavior.

```html
<!-- Before: a div pretending to be a button -->
<div class="btn" onclick="submitForm()">Submit</div>
```

This looks identical to a real button visually, but it gets none of a button's built-in behavior for free: it's not in the keyboard tab order by default (no `tabindex`), pressing Enter or Space does nothing, and a screen reader announces it as generic, unlabeled text — not as an interactive control, so a screen-reader user has no idea it can be activated at all.

```html
<!-- After: a real button -->
<button type="button" onclick="submitForm()">Submit</button>
```

The real `<button>` is automatically keyboard-focusable, automatically responds to both Enter and Space as activation keys, automatically gets `role="button"` announced by every screen reader with zero extra markup, and automatically participates correctly in form submission semantics (`type="button"` vs. the implicit `type="submit"` inside a `<form>`). Recreating all of that behavior on a `<div>` requires `tabindex="0"`, a `role="button"` attribute, and manually written `keydown` handlers for both Enter and Space — code that's easy to get subtly wrong (a very common bug: implementing Enter but forgetting Space, or vice versa) and that simply isn't necessary when the native element already does the job correctly.

The same logic extends everywhere: `<nav>`, `<main>`, `<article>`, `<h1>`–`<h6>` in proper heading order, `<label for="...">` tied to a real `<input id="...">` — each one gives a screen reader user landmarks to jump between and gives keyboard users behavior they'd otherwise have to be hand-rolled.

## ARIA — When Native HTML Isn't Enough

The first rule of ARIA use, stated plainly in the W3C's own ARIA Authoring Practices Guide: **if a native HTML element or attribute has the semantics and behavior you need, use it instead of re-purposing an element and adding ARIA.** ARIA doesn't change an element's behavior at all — it only changes what assistive technology *announces* about it. Adding `role="button"` to a `<div>` doesn't make it keyboard-operable; it just makes a screen reader lie and call it a button while it still can't be tabbed to or activated with a keyboard. This is widely known as "ARIA is a promise you have to keep yourself" — every ARIA attribute you add is a claim about behavior that your JavaScript now has to actually implement.

ARIA earns its place for the cases native HTML genuinely has no equivalent for — dynamic, JS-driven UI patterns the HTML spec never anticipated.

**Example: `aria-live` for a toast notification.** A toast that appears without any user action (e.g. "Item saved") is invisible to a screen reader by default — nothing moved focus, so nothing gets announced. `aria-live` tells assistive technology to watch a region and announce changes to it automatically:

```html
<div aria-live="polite" aria-atomic="true" class="toast-container">
  <!-- Injected dynamically when a toast fires: -->
  <div class="toast">Item saved successfully</div>
</div>
```

`aria-live="polite"` announces the change after the screen reader finishes whatever it's currently reading (appropriate for a non-urgent confirmation); `aria-live="assertive"` interrupts immediately (reserved for errors or time-sensitive alerts). `aria-atomic="true"` tells it to re-read the entire region's content rather than just the diff.

**Example: `aria-expanded` on a disclosure widget.** A collapsible section (an accordion header, a "show more" toggle) needs to communicate its open/closed state to a screen reader, since visually that state is conveyed only by whether content is present below it:

```html
<button aria-expanded="false" aria-controls="details-panel" id="details-toggle">
  Show details
</button>
<div id="details-panel" hidden>
  <p>Additional content revealed when expanded.</p>
</div>
```

```js
const toggle = document.getElementById("details-toggle");
const panel = document.getElementById("details-panel");
toggle.addEventListener("click", () => {
  const isExpanded = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!isExpanded));
  panel.hidden = isExpanded;
});
```

Here the underlying element is still a real `<button>` — ARIA is layered on top to add the one piece of state (expanded/collapsed) that plain HTML has no attribute for, not used as a replacement for the button itself.

## Keyboard Navigation Basics

A sighted mouse user's experience should be fully reproducible by someone who can't use a mouse at all — a requirement for motor-impaired users and a hard requirement for blind users navigating via screen reader, who operate almost entirely through the keyboard. Three things matter in practice:

- **Focus order** should follow visual/logical reading order. This falls out for free from DOM order — the browser tabs through focusable elements in the order they appear in the document — so it breaks specifically when CSS (`order` in flexbox/grid, `position: absolute`) visually rearranges elements without the underlying DOM order matching.
- **Visible focus indicators** must never be silently removed. `outline: none` on `:focus` without providing a replacement is one of the most common real-world accessibility violations — a keyboard user tabbing through a page with no focus ring has no way to tell where they are.

```css
/* Bad: removes the only visual signal of keyboard focus */
button:focus { outline: none; }

/* Good: replace it with something at least as visible, not remove it */
button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
```

(`:focus-visible` specifically — rather than plain `:focus` — matches the modern convention of showing the ring for keyboard focus but not for a mouse click, which is what most users expect.)

- **The Tab / Shift+Tab / Enter / Escape contract** is a set of expectations users bring to every web page regardless of which site they're on: Tab moves forward through focusable elements, Shift+Tab moves backward, Enter activates the focused control (Space also activates buttons and checkboxes), and Escape closes whatever transient UI is currently open — a modal, a dropdown, a popover. Violating this contract (a modal that traps focus but doesn't close on Escape, a dropdown where arrow keys do nothing) is immediately noticeable to keyboard-dependent users even when everything looks correct visually.

## Screen Reader Basics

A screen reader converts the accessibility tree — a parallel structure the browser builds alongside the DOM, combining semantic HTML, computed ARIA, and text content — into synthesized speech or braille output. Two mechanisms account for most of what actually gets read aloud:

- **Alt text** (`alt="..."` on `<img>`) is read in place of the image. An empty `alt=""` is a deliberate, valid signal meaning "this image is purely decorative, skip it" — omitting `alt` entirely is different and worse, since some screen readers fall back to reading the image's filename or URL.
- **Label associations** — `<label for="email">Email</label>` paired with `<input id="email">`, or `aria-label`/`aria-labelledby` where a visible `<label>` isn't appropriate — determine what's announced when a screen reader user tabs into a form field. An `<input>` with no associated label announces as just "edit text," giving the user no idea what to type; a properly associated one announces "Email, edit text."

```html
<label for="email">Email address</label>
<input type="email" id="email" name="email" required />
```

Clicking the visible label also focuses the input automatically — a free UX improvement for mouse users that comes from the same one correctly-written association.
