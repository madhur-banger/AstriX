# Browser Storage & Frontend Security

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Where a frontend puts data — and how it locks down what code is allowed to run and talk to what — is a small set of mechanisms that get reinvented on every project. Getting them wrong is one of the most common ways a frontend bug becomes a security incident rather than a cosmetic one.

## Cookies vs. localStorage vs. sessionStorage vs. IndexedDB

| | Cookies | localStorage | sessionStorage | IndexedDB |
|---|---|---|---|---|
| **Capacity** | ~4KB per cookie | ~5-10MB (browser-dependent) | ~5-10MB | Hundreds of MB+ (quota-based, browser-dependent) |
| **Persistence** | Until expiry date, or session if none set | Until explicitly cleared | Until the tab/window closes | Until explicitly cleared |
| **Sent automatically on every request?** | Yes, to matching domain/path (unless `SameSite` blocks it cross-site) | No — JS must read and attach it manually | No | No |
| **API** | Synchronous, string-based (`document.cookie`), awkward to parse | Synchronous, key-value string API | Synchronous, key-value string API | Asynchronous, transactional, structured objects/indexes |
| **`httpOnly` available?** | Yes — server-set cookies can be made invisible to JS | No — no equivalent concept | No | No |

A few consequences worth internalizing beyond the table. Cookies are the *only* mechanism the browser attaches to outgoing requests on its own — that's exactly what makes them suitable for session credentials the server needs on every request, and exactly what makes them the vector for CSRF (a malicious site can trigger a request to your domain and the browser will happily attach the cookie, unless `SameSite` or a CSRF token stops it). `localStorage`/`sessionStorage` are the opposite: nothing leaves the browser unless application code explicitly reads the value and puts it somewhere (a header, a request body) — which is safer against CSRF but means any XSS on the page can read the value directly via JavaScript, since there's no `httpOnly`-equivalent protection for storage APIs. IndexedDB is the right tool once data outgrows a few megabytes of strings — structured records, offline caches, anything needing indexes or transactions — not for small auth tokens.

## Content-Security-Policy (CSP)

CSP is an HTTP response header that tells the browser which sources are allowed to supply scripts, styles, images, fonts, and other resources for a page — anything not on the allowlist is refused to load or execute, even if it's already been injected into the DOM by an attacker.

```http
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.example.com; frame-ancestors 'none'
```

Reading this directive by directive: `default-src 'self'` is the fallback for any resource type not otherwise listed, restricting it to the page's own origin; `script-src 'self' https://cdn.example.com` means only scripts served from the same origin or that specific CDN may execute — critically, this is what actually neutralizes most XSS payloads, because an attacker's injected `<script>alert(document.cookie)</script>` or an injected `<img onerror="...">` simply won't run, since inline script execution isn't in the allowlist; `frame-ancestors 'none'` prevents the page from being embedded in an `<iframe>` on any other site at all, which is the modern replacement for the older `X-Frame-Options` header and is the direct defense against clickjacking. CSP is delivered as a header (or a `<meta http-equiv="Content-Security-Policy">` tag, with slightly reduced capability) rather than JavaScript, specifically so it's enforced by the browser before any page script — malicious or otherwise — gets a chance to run.

## Subresource Integrity (SRI)

SRI lets a page assert "this exact file, byte for byte" when loading a script or stylesheet from a third-party source, using a cryptographic hash in the `integrity` attribute:

```html
<script
  src="https://cdn.example.com/library@1.4.2/dist/library.min.js"
  integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
  crossorigin="anonymous"
></script>
```

Before executing the fetched file, the browser hashes it and compares that hash against the `integrity` value; if they don't match, the script is refused entirely — the page continues without it rather than running altered code. This defends against a specific, real attack: a compromised or maliciously modified third-party CDN silently serving altered JavaScript to every site that references it. Without SRI, every site loading that CDN's URL executes whatever bytes the CDN happens to be serving *right now*, with full trust — a single compromised CDN becomes a supply-chain attack against every downstream site simultaneously. With SRI, an altered file simply fails to load, containing the blast radius to "third-party feature breaks" instead of "third-party feature now runs attacker JS with the same privileges as the page's own code." `crossorigin="anonymous"` is required alongside `integrity` for cross-origin resources, since the browser needs CORS permission to even read the response bytes well enough to hash and verify them.

## `postMessage` Security

`postMessage` is the sanctioned way for two different browsing contexts — a page and an `<iframe>` it embeds, or a page and a popup window it opened — to communicate across origins, since same-origin policy otherwise blocks them from touching each other's DOM or JS state directly.

The classic mistake is either omitting the `targetOrigin` argument or passing `"*"`, which sends the message to *any* origin the target window happens to be navigated to — including one an attacker controls if they can get the reference redirected there:

```js
// Bad: '*' sends this message to whatever origin the iframe is
// currently showing — including an attacker-controlled page if the
// iframe has been navigated away from where you expect
iframe.contentWindow.postMessage({ token: sessionToken }, "*");
```

```js
// Good: the message is only delivered if the target window's current
// origin exactly matches this string; otherwise the browser drops it
iframe.contentWindow.postMessage({ token: sessionToken }, "https://trusted-app.example.com");
```

The mirror-image mistake happens on the *receiving* end: a `message` event listener that acts on `event.data` without checking `event.origin` will process a message from literally any page that has a reference to your window — including a malicious page that opened yours in a popup purely to send it forged messages.

```js
// Bad: no origin check — any page can send this listener a message
window.addEventListener("message", (event) => {
  updateUserState(event.data); // trusts data from anyone
});

// Good: explicitly validate event.origin before trusting event.data at all
window.addEventListener("message", (event) => {
  if (event.origin !== "https://trusted-app.example.com") {
    return;
  }
  updateUserState(event.data);
});
```

Both sides need the check — a correct `targetOrigin` on the sender only restricts *where the message is delivered*, and a correct `event.origin` check on the receiver only restricts *whose messages get trusted*; either one alone leaves the other side exploitable.

## Where This Shows Up in AstriX

AstriX's own token-storage decision is a real, deliberate instance of the comparison table above: the access token lives only in a Zustand store's in-memory state (row: localStorage/sessionStorage, but deliberately *not* used — no `persist` middleware, nothing written to disk), while the refresh token lives exclusively in an `httpOnly` cookie the browser sends automatically and JavaScript can never read (row: cookies, specifically the `httpOnly` column). [`docs/frontend/06-authentication-and-authorization-ui.md`](../frontend/06-authentication-and-authorization-ui.md) has AstriX's full reasoning; in short, it's the XSS-resistant end of this tradeoff space — an in-memory access token leaves nothing for a script to read after the page closes, and an `httpOnly` refresh cookie can't be exfiltrated by a garden-variety XSS payload at all.
