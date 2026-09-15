# Web Performance & Core Web Vitals

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

"The site feels slow" is a useless bug report. Core Web Vitals exist to turn that vague complaint into three specific, measurable numbers — and Google uses them as an actual search-ranking signal, which is why they get taken seriously beyond pure UX polish. As of 2026 there are exactly three: LCP, INP, and CLS. (A fourth metric, FID, was fully retired as a Core Web Vital in March 2024, replaced by INP — see below.)

## Largest Contentful Paint (LCP)

**What it measures:** the render time of the largest visible content element (usually a hero image, a large block of text, or a `<video>` poster) within the initial viewport. It's a proxy for "when did the page feel like it actually loaded," as opposed to `onload` firing, which can happen while the page is still visibly blank.

**Target:** under 2.5 seconds is "good"; 2.5–4s is "needs improvement"; over 4s is "poor."

**A concrete cause + fix.** A common LCP killer: a hero `<img>` that's large, unoptimized, and discovered late because it's referenced via a CSS `background-image` the browser can't preload, or because it's far down the HTML and the browser's preload scanner never sees it until the whole document is parsed.

```html
<!-- Slow: browser doesn't know this image is important until CSS is fully parsed -->
<div class="hero" style="background-image: url('/hero-4000px.jpg')"></div>

<!-- Fast: real <img> the preload scanner finds immediately, sized correctly,
     and explicitly hinted as high priority -->
<img
  src="/hero-1600w.jpg"
  srcset="/hero-800w.jpg 800w, /hero-1600w.jpg 1600w, /hero-2400w.jpg 2400w"
  sizes="100vw"
  width="1600"
  height="900"
  fetchpriority="high"
  alt="Product dashboard overview"
/>
<link rel="preload" as="image" href="/hero-1600w.jpg" />
```

Serving a correctly-sized, modern-format (WebP/AVIF) image and hinting it as high-priority (`fetchpriority="high"`, an early `<link rel="preload">`) are the two highest-leverage fixes. `loading="lazy"` should never be applied to an LCP candidate — that defers the exact resource you want to load first.

## Interaction to Next Paint (INP)

**What it measures:** the latency between a user interaction (click, tap, key press) and the next time the browser paints the resulting visual update, sampled across the entire page lifecycle rather than just the first interaction. INP replaced First Input Delay (FID) as the official responsiveness Core Web Vital in March 2024 — FID only measured the delay before the *first* input started being processed, while INP captures the full interaction cost (input delay + processing time + presentation delay) for effectively every interaction on the page, which is a much more honest measure of "does this page feel janky when I actually use it."

**Target:** under 200ms is "good"; 200–500ms is "needs improvement"; over 500ms is "poor."

**A concrete cause + fix.** A classic INP killer: a click handler that does synchronous, expensive work directly in the event callback — say, re-rendering a large list or running a heavy computation — before the browser can paint any visual feedback.

```js
// Bad: expensive synchronous work blocks the next paint
button.addEventListener("click", () => {
  const results = expensiveFilter(largeArray); // blocks main thread for 300ms+
  renderResults(results);
});

// Better: yield to the browser so it can paint immediately-available
// feedback (e.g. a pressed state or spinner) before the heavy work runs
button.addEventListener("click", () => {
  showLoadingState();
  setTimeout(() => {
    const results = expensiveFilter(largeArray);
    renderResults(results);
  }, 0);
});
```

Breaking long tasks into smaller chunks (yielding via `setTimeout`, `scheduler.yield()` where supported, or moving the computation to a Web Worker) keeps any single task short enough that the browser can interleave a paint, per the event-loop model described in [file 10](./10-browser-internals-and-rendering.md).

## Cumulative Layout Shift (CLS)

**What it measures:** the sum of every unexpected layout shift during the page's lifetime — an element visibly moving after the user has already started perceiving the page, weighted by how much of the viewport moved and how far. It's the metric behind the universally hated experience of tapping a button just as an ad loads above it and shifts the whole page down.

**Target:** under 0.1 is "good"; 0.1–0.25 is "needs improvement"; over 0.25 is "poor."

**A concrete cause + fix.** Images and ad slots with no reserved dimensions are the single most common cause — the browser has no idea how tall the element will be until the resource finishes loading, so it renders the page as if that space were zero-height, then jolts everything below it downward once the real content arrives.

```css
/* Bad: no dimensions reserved — content jumps once the image loads */
img.thumbnail { max-width: 100%; }
```

```html
<!-- Good: width/height (or aspect-ratio) reserve the space up front,
     so the browser lays out the final geometry before the image arrives -->
<img class="thumbnail" src="/thumb.jpg" width="400" height="300" alt="Preview" />
```

```css
/* Equivalent fix for a responsive image or an ad slot with dynamic width */
.thumbnail, .ad-slot {
  aspect-ratio: 4 / 3;
  width: 100%;
}
```

The same fix applies to web fonts (`font-display: optional` or matching fallback-font metrics to avoid the FOIT/FOUT reflow) and to any dynamically-injected banner, cookie notice, or ad that isn't given a reserved slot before it loads.

## Profiling in Chrome DevTools

Two tools cover almost everything:

- **The Performance tab** records a timeline of exactly what the main thread did — parse, script execution, style/layout/paint/composite — frame by frame. Record a real interaction (a page load, a click), then look for long yellow (scripting) blocks, red-flagged "long tasks" over 50ms, and the layout/paint bars lining up with CSS changes from file 10's reflow discussion.
- **Lighthouse** (built into DevTools' Lighthouse tab, or `npx lighthouse <url>` from the CLI) runs a synthetic audit and reports lab-measured LCP/CLS/TBT (Total Blocking Time, a proxy for INP in lab conditions since real INP needs field data) alongside a prioritized list of specific fixes — unoptimized images, render-blocking resources, unused JS/CSS.

Lighthouse numbers are *lab data* — one simulated run, one device profile. The Chrome User Experience Report (CrUX) and `web-vitals` JS library capture *field data* — real users' real devices and networks — which is what Google's ranking signal actually uses, and it commonly disagrees with lab numbers because real users have slower phones and worse networks than a CI runner.

## Performance Budgets

A performance budget is a hard numeric ceiling on a specific metric, enforced in CI so a regression fails the build instead of shipping silently. A realistic example budget for a mid-size SPA:

- JS bundle (initial load, gzipped): **< 200KB**
- CSS bundle (gzipped): **< 50KB**
- LCP (75th percentile, field data): **< 2.5s**
- INP (75th percentile, field data): **< 200ms**
- CLS (75th percentile, field data): **< 0.1**

Tools like `bundlesize`, Lighthouse CI, or a custom Webpack/Vite bundle-analyzer check with a hard-fail threshold are how budgets get enforced mechanically rather than relying on someone noticing the bundle crept up over six months of dependency additions.
