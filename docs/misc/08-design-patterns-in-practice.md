# Design Patterns in Practice

The Gang of Four catalog has 23 patterns; most backend engineers use six or so regularly without necessarily naming them. This file covers the ones that actually show up in real backend code, what problem each solves, and where to spot them in the wild.

## Adapter

**Problem:** You need to integrate with an external system (a vendor API, a legacy module) whose interface doesn't match what your application code expects, and you don't want that vendor's specific shape leaking into every caller.

**Solution:** Wrap the external system behind an interface your own code defines, so callers depend on your interface, not the vendor's.

```ts
interface EmailSender {
  send(to: string, subject: string, html: string): Promise<void>;
}

class ResendEmailAdapter implements EmailSender {
  constructor(private client: Resend) {}
  async send(to: string, subject: string, html: string) {
    await this.client.emails.send({ from: "noreply@app.com", to, subject, html });
  }
}

// Callers depend on EmailSender, never on Resend's SDK types directly.
async function notifyUser(sender: EmailSender, userEmail: string) {
  await sender.send(userEmail, "Welcome", "<p>Hi!</p>");
}
```

**Real-world instance:** AstriX's `backend/src/providers/` folder — `google.provider.ts` and `email.provider.ts` — is functionally this pattern. AstriX's own architecture docs describe that folder as "external-service adapters" ([`docs/backend/00-master-backend-architecture.md`](../backend/00-master-backend-architecture.md), the `providers/` row of the folder map), and separately document that `google.provider.ts` is a hand-rolled HTTP adapter (built on `axios`, not a vendor SDK) while `email.provider.ts` wraps the official `resend` SDK — two different external systems, each normalized behind AstriX's own calling convention rather than services throughout the codebase calling `axios` or the `Resend` client directly. Nothing in AstriX's docs claims the authors deliberately reached for "the GoF Adapter pattern" by name — it's an observation about the resulting shape, not a claim about intent.

## Strategy

**Problem:** An algorithm needs to vary at runtime (different payment processors, different sorting/ranking logic, different pricing rules) without an ever-growing `if/else` or `switch` chain at every call site.

**Solution:** Define a common interface for the algorithm, implement each variant as its own class/function, and inject the one to use.

```ts
interface DiscountStrategy {
  apply(price: number): number;
}

class PercentageDiscount implements DiscountStrategy {
  constructor(private percent: number) {}
  apply(price: number) { return price * (1 - this.percent / 100); }
}

class FlatDiscount implements DiscountStrategy {
  constructor(private amount: number) {}
  apply(price: number) { return Math.max(0, price - this.amount); }
}

function checkout(price: number, strategy: DiscountStrategy) {
  return strategy.apply(price);
}
```

**Real-world instance:** a payment module that supports Stripe, PayPal, and a manual invoice flow behind one `PaymentStrategy` interface, selected based on the customer's chosen method at checkout time, is the strategy pattern in almost every e-commerce backend.

## Factory

**Problem:** Object construction logic is complex enough, or varies enough by input, that scattering `new SomeClass(...)` calls throughout the codebase would duplicate that logic and make it hard to change centrally.

**Solution:** Centralize construction behind a function or class whose job is only to build the right object.

```ts
function createLogger(env: "development" | "production"): Logger {
  return env === "production"
    ? new PinoLogger({ level: "info", redact: ["password", "token"] })
    : new PinoLogger({ level: "debug", pretty: true });
}
```

**Real-world instance:** any app-config module that reads `process.env` once and returns a fully-constructed client (a database connection, an S3 client, a logger) rather than every call site independently reading env vars and constructing its own — factories are the reason changing "how a logger gets built" is a one-file change instead of a grep-and-replace across the codebase.

## Decorator

**Problem:** You want to add behavior (logging, caching, retrying, auth checks) to an object or function without modifying its own code or subclassing it for every combination of added behavior.

**Solution:** Wrap the original in something that implements the same interface, does its own work, then delegates to the wrapped original.

```ts
function withLogging<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    console.log(`calling ${fn.name} with`, args);
    const result = await fn(...args);
    console.log(`${fn.name} returned`, result);
    return result;
  }) as T;
}

const loggedFetchUser = withLogging(fetchUser);
```

**Real-world instance:** Express middleware is a decorator by shape — `asyncHandler(controller)` wraps a controller function with error-forwarding behavior, and the wrapped result is called exactly like the original but with added behavior layered around it, without the controller itself needing to know the wrapper exists.

## Observer

**Problem:** One event needs to trigger reactions in multiple, independent parts of the system, without the code that triggers the event needing to know who's listening or call each of them explicitly.

**Solution:** Subjects publish events; observers subscribe independently and get notified when an event fires.

```ts
import { EventEmitter } from "events";

const bus = new EventEmitter();

bus.on("user.registered", (user) => sendWelcomeEmail(user));
bus.on("user.registered", (user) => trackSignupAnalytics(user));

bus.emit("user.registered", newUser); // both listeners fire, registration code knows neither
```

**Real-world instance:** Node's built-in `EventEmitter`, browser DOM events, and message-queue pub/sub (see [`04-message-queues-and-event-driven-architecture.md`](./04-message-queues-and-event-driven-architecture.md)) are all this pattern at different scales — in-process, in-DOM, and across services respectively.

## Singleton — With a Caveat

**Problem:** Some resources genuinely should have exactly one instance for the life of the process — a database connection pool, a config object read once from the environment.

**Solution (naive):** A module-level variable, or a class that hands back the same instance on every call:

```ts
let instance: DatabaseConnection | null = null;
function getConnection(): DatabaseConnection {
  if (!instance) instance = new DatabaseConnection(config.DB_URL);
  return instance;
}
```

**The caveat:** in modern dependency-injection-based systems, a hand-rolled singleton is often an anti-pattern rather than a clean solution, because it creates a hidden global dependency — any code that calls `getConnection()` is implicitly coupled to one specific global instance, which makes unit testing painful (you can't easily inject a mock/test double without monkey-patching the module) and makes the dependency invisible in a function's signature. The better version of "one instance for the app's lifetime" in a DI-based framework (NestJS, Spring, most modern backend frameworks) is a service registered with singleton *scope* in the DI container — same one-instance guarantee, but the instance is handed to whoever needs it via constructor injection rather than reached for via a global getter, which keeps the dependency explicit and swappable in tests. Node's module cache (`require`/`import` caching a module's top-level state) already gives you singleton-like behavior for free in many cases, which is part of why hand-rolled singleton classes are less common in Node backends than in languages without that caching behavior.
