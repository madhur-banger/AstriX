# Security Fundamentals: OWASP and Cryptography

Most production security incidents trace back to a small, well-known set of mistakes. This file is a working checklist of those mistakes (OWASP's Top 10) plus the cryptography vocabulary you need to reason about the fixes correctly rather than by cargo-culting them.

## OWASP Top 10 (2021)

- **A01 — Broken Access Control.** The system fails to enforce that a user can only act on resources they're authorized for — e.g. `GET /orders/1234` returns any order for any logged-in user because the handler checks "is this a valid order ID" but never "does this order belong to the requesting user." Fix: authorize per-resource, on the server, every time — never trust a client-supplied ID alone.
- **A02 — Cryptographic Failures.** Sensitive data transmitted or stored without adequate protection — passwords hashed with fast, unsalted MD5/SHA-1, or PII sent over plain HTTP. Fix: TLS everywhere, purpose-built password hashing (bcrypt/argon2 — see below), encrypt sensitive data at rest.
- **A03 — Injection.** Untrusted input is concatenated into a command interpreter instead of passed as data. The canonical example:

```js
// VULNERABLE: string concatenation lets input escape the intended query shape
const query = `SELECT * FROM users WHERE email = '${userInput}'`;
// userInput = "' OR '1'='1" returns every row in the table

// SAFE: parameterized query — the driver sends input as data, never as SQL syntax
const result = await db.query("SELECT * FROM users WHERE email = $1", [userInput]);
```

- **A04 — Insecure Design.** A flaw in the design itself, not the implementation — e.g. an account-recovery flow that emails a password reset link with no expiry and no single-use enforcement, so a leaked old email compromises the account indefinitely. Fix: threat-model the flow before writing code, not after.
- **A05 — Security Misconfiguration.** Default credentials left in place, verbose stack traces returned to clients in production, unnecessary services/ports exposed, missing security headers. Fix: hardened defaults, automated config auditing, minimal attack surface.
- **A06 — Vulnerable and Outdated Components.** Shipping a dependency with a known CVE because nobody's tracking versions. Fix: automated dependency scanning (`npm audit`, Dependabot/Snyk) wired into CI, not a manual quarterly check.
- **A07 — Identification and Authentication Failures.** Weak password policies, no brute-force protection on login, session tokens that don't expire or rotate. Fix: rate-limit auth endpoints, hash passwords properly, rotate/expire session and refresh tokens.
- **A08 — Software and Data Integrity Failures.** Trusting data or code from a source without verifying its integrity — an unsigned auto-update mechanism, deserializing untrusted data without validation. Fix: signature verification, checksums, avoid deserializing untrusted data with a dynamic-execution deserializer.
- **A09 — Security Logging and Monitoring Failures.** A breach goes undetected for months because failed logins, access-control violations, and other suspicious events were never logged or alerted on. Fix: log security-relevant events, alert on anomalies, don't only log for debugging.
- **A10 — Server-Side Request Forgery (SSRF).** The server fetches a URL supplied (directly or indirectly) by the user, and an attacker points it at an internal-only endpoint (a cloud metadata service, an internal admin API) the server can reach but the attacker can't reach directly. Fix: never let user input construct a server-side fetch target unless it's validated against a strict allowlist.

## Symmetric vs. Asymmetric Cryptography

**Symmetric** encryption uses the *same* key to encrypt and decrypt — **AES** (Advanced Encryption Standard) is the near-universal standard. It's fast and suited for bulk data (encrypting a database column, a file, a TLS session's actual traffic), but both parties need the same secret key, which creates a key-distribution problem: how do you get the key to the other party without an eavesdropper also getting it?

**Asymmetric** (public-key) cryptography uses a *key pair* — a public key that can be shared openly, and a private key kept secret. **RSA** and **ECC** (elliptic-curve cryptography, e.g. the curves behind Ed25519) are the standard algorithms. Data encrypted with the public key can only be decrypted with the private key, which solves the key-distribution problem (no secret needs to travel over the wire) at the cost of being computationally far more expensive than symmetric encryption — which is exactly why TLS uses asymmetric crypto only to bootstrap trust and exchange a symmetric key, then switches to fast symmetric encryption for the actual data (see below).

## Hashing vs. Encryption

This distinction is the single most consequential one in this file to get right: **encryption is reversible** (given the key, you get the original data back) and is for data you need to retrieve later — a credit card number, a file. **Hashing is one-way** (there is no key that reverses a hash back to the input) and is for verifying data without ever needing the original back — a password.

You never need to recover a user's actual password — you only ever need to verify that what they typed matches what they set. That's exactly what a one-way hash gives you, and it's why passwords are hashed, never encrypted: encryption implies a key exists somewhere that unlocks every user's plaintext password at once, which is a catastrophic single point of failure. A hash has no such key by design.

**Plain SHA-256 is still the wrong hash for passwords**, despite being a perfectly good general-purpose cryptographic hash — it's *deliberately fast*, which is exactly the wrong property for password storage: fast hashing is what makes brute-forcing every password in a stolen hash dump computationally feasible on cheap GPU hardware (billions of SHA-256 hashes per second). **bcrypt** and **argon2** exist specifically to be *slow and memory-hard* — bcrypt has a tunable cost factor (work factor), argon2 additionally tunes memory usage, both deliberately expensive per-guess so that brute-forcing a stolen hash dump is computationally impractical even though the algorithm itself is public.

```js
import bcrypt from "bcrypt";

const passwordHash = await bcrypt.hash(plainTextPassword, 12); // cost factor 12
const isMatch = await bcrypt.compare(candidatePassword, passwordHash);
```

## TLS at the Concept Level

TLS (what makes `https://` secure) accomplishes two things in its handshake, without needing to trace the full cipher-suite negotiation to understand the shape:

1. **Server authentication.** The server presents a certificate, issued by a Certificate Authority the client's OS/browser already trusts, forming a **chain of trust** back to a trusted root CA. This is what proves "you're actually talking to the real `example.com`," not an attacker impersonating it (a MITM).
2. **A negotiated symmetric session key.** Asymmetric cryptography is used only briefly, during the handshake, to safely agree on a shared secret without ever sending that secret in the clear (modern TLS typically uses an ephemeral Diffie-Hellman key exchange for this). Once that shared secret exists, the connection switches to fast symmetric encryption (AES, typically) for the actual data — because, as above, asymmetric crypto is too slow to encrypt an entire session's traffic directly.

The gotcha that actually bites people: a valid TLS certificate proves you're talking to the domain named on the cert — it says nothing about whether that domain is trustworthy. A phishing site can hold a perfectly valid TLS certificate for `paypa1-login.com`; the padlock icon confirms encryption and identity of the domain, not the legitimacy of the domain itself.
