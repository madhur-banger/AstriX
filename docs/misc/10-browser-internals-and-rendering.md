# Browser Internals & Rendering

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Every frontend framework — React included — ultimately compiles down to instructions a browser has to turn into pixels. Understanding that pipeline explains why some CSS changes are "free" and others tank frame rate, and why a single slow `for` loop can freeze an entire page even though "JavaScript is asynchronous."

## The Critical Rendering Path

When a browser receives an HTML response, it runs a fixed pipeline before anything appears on screen:

1. **HTML parse → DOM.** The HTML byte stream is tokenized and parsed into the Document Object Model — a tree of node objects. Parsing is incremental and streaming: the browser doesn't wait for the full document before starting.
2. **CSS parse → CSSOM.** Every stylesheet (external `<link>`, inline `<style>`, `style=""` attributes) is parsed into the CSS Object Model, a tree of style rules with specificity and cascade already resolved into computed values per node.
3. **DOM + CSSOM → Render Tree.** The browser combines both trees into a render tree containing only the nodes that will actually be visible — `display: none` elements, `<head>` contents, and `<script>` tags are excluded (note: `visibility: hidden` elements *are* included, since they still occupy layout space).
4. **Layout (a.k.a. Reflow).** The browser walks the render tree and computes the exact geometry of every box — position and size in pixels — given the viewport width and the CSS.
5. **Paint.** The browser fills in pixels for each box: text, colors, borders, shadows, images — recorded as a set of draw calls, conceptually similar to a scene painted onto potentially multiple layers.
6. **Composite.** If the page has multiple layers (common with `position: fixed`, CSS `transform`, `will-change`, or video/canvas elements), the compositor thread combines them into the final image, potentially using the GPU.

CSS is famously "render-blocking" — the browser won't paint until it has the full CSSOM, because a rule discovered late could change everything already painted. `<script>` tags are similarly parser-blocking by default: encountering `<script src="...">` without `async`/`defer` pauses HTML parsing until the script downloads and executes, because the script might call `document.write()` and mutate the document being parsed.

## Reflow vs. Repaint vs. Composite-Only

These three are not interchangeable, and the cost difference is roughly two orders of magnitude between the cheapest and most expensive:

- **Reflow (layout)** happens when a change affects an element's geometry — its size, position, or the geometry of anything around it. Reflow is the most expensive because it can cascade: resizing one flex child can force every sibling, parent, and in the worst case, every node on the page to recompute layout.

```css
/* Expensive: changing top/left/width forces layout recalculation */
.box {
  position: absolute;
  top: 0;
  left: 0;
  width: 100px;
  transition: top 0.3s, left 0.3s, width 0.3s;
}
.box.moved {
  top: 200px;
  left: 300px;
  width: 250px; /* triggers reflow every animation frame */
}
```

- **Repaint** happens when geometry is unchanged but visual appearance is — color, background, `box-shadow`, `visibility`. No layout math is redone, but the browser still has to re-rasterize pixels for the affected region.

```css
/* Cheaper than a layout change, but still triggers a repaint every frame */
.box {
  background-color: red;
  transition: background-color 0.3s;
}
.box:hover {
  background-color: blue;
}
```

- **Composite-only** happens when a change can be handled entirely by the compositor thread re-combining existing painted layers — no layout, no repaint. `transform` and `opacity` are the two CSS properties that can achieve this, because they can be applied to a layer's existing bitmap (translating, scaling, rotating, or fading it) without asking layout or paint to redo any work.

```css
/* Cheap: transform and opacity are compositor-only — no layout, no repaint */
.box {
  transform: translateX(0);
  opacity: 1;
  transition: transform 0.3s, opacity 0.3s;
  will-change: transform; /* hints the browser to promote this to its own layer */
}
.box.moved {
  transform: translateX(300px);
  opacity: 0.5;
}
```

This is *the* practical rule for animation performance: animating `top`/`left`/`width`/`height` forces layout on every frame of the animation; animating the equivalent `transform: translate()`/`scale()` achieves the same visual result at a fraction of the cost, because it skips layout and paint entirely and runs on the compositor thread — often even off the main thread, which matters directly for the next section.

## Where the JS Engine Fits In

A JS engine (V8 in Chrome/Node, SpiderMonkey in Firefox, JavaScriptCore in Safari) runs a similar multi-stage pipeline: **parse** the source into an abstract syntax tree, **compile** it — modern engines use a JIT (Just-In-Time compiler): an interpreter runs the code immediately while a profiler watches for "hot" functions called repeatedly, which get recompiled into optimized machine code on the fly — then **execute**.

The critical fact for frontend engineering: **JavaScript execution and rendering share the same main thread.** While a synchronous JS function is running, the browser cannot run layout, paint, or respond to input events like clicks or scrolls. This is why a long synchronous loop visibly freezes a page:

```js
// This blocks the main thread for ~1-2 seconds on typical hardware.
// No click, scroll, or repaint can happen until it returns.
function blockMainThread() {
  const start = Date.now();
  while (Date.now() - start < 1500) {
    // busy work
  }
}
```

The fix is never "make it async" in the naive sense — `async`/`await` and Promises don't move CPU-bound work off the main thread by themselves, they only defer *when* a callback runs. Genuinely offloading CPU work requires a Web Worker, or breaking the task into smaller chunks yielded back to the event loop (e.g. via `setTimeout(fn, 0)` or `requestIdleCallback`).

## The Browser Event Loop

The browser event loop is the same fundamental model as Node's — a single thread repeatedly pulling work off queues — but with one addition: rendering steps are interleaved between turns of the loop, not run continuously.

Each loop iteration processes exactly one **task** (a macrotask) from the task queue — a `setTimeout` callback, a click handler, a network response handler. After that task finishes, the engine drains the entire **microtask queue** — every pending Promise `.then()`/`.catch()`/`.finally()` callback and `queueMicrotask()` callback — completely, before doing anything else. Only after both the task and all microtasks it spawned (including microtasks spawned by other microtasks) have run does the browser get a chance to render: it may run `requestAnimationFrame` callbacks, then perform style/layout/paint/composite if anything changed, then move to the next task.

```js
console.log("1: sync");

setTimeout(() => console.log("4: macrotask (setTimeout)"), 0);

Promise.resolve().then(() => console.log("3: microtask (Promise)"));

console.log("2: sync");
// Output: 1, 2, 3, 4 — all microtasks drain before the next macrotask runs
```

The practical gotcha: a microtask queue that keeps re-scheduling itself (a chain of `.then()` calls that never terminates) can starve rendering indefinitely, because the browser never gets to the "render if needed" step between tasks — the page appears frozen even though technically no single synchronous block is running longer than a few milliseconds at a time.
