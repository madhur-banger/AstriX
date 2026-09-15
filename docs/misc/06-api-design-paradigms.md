# API Design Paradigms

REST, GraphQL, gRPC, and WebSockets/SSE are not competing implementations of the same idea — each solves a different problem well and a different problem badly. Knowing which is which is more valuable than being deep in any single one.

## The REST Maturity Model (Richardson Levels 0–3)

Leonard Richardson's model describes how "RESTful" an HTTP API actually is, in four levels:

- **Level 0 — The Swamp of POX.** One URL, one HTTP verb (usually `POST`), the "API" is really just RPC-over-HTTP with the operation encoded in the request body. `POST /api` with `{ "action": "getUser", "id": 42 }`.
- **Level 1 — Resources.** Multiple URLs, one per resource type, but still mostly one verb. `POST /users/42/getDetails`, `POST /users/42/updateDetails` — resources exist in the URL, but the HTTP method still isn't doing semantic work.
- **Level 2 — HTTP Verbs.** URLs name resources *and* HTTP methods carry real meaning — `GET /users/42` to read, `PUT /users/42` to replace, `DELETE /users/42` to remove — plus status codes carry outcome (`404`, `409`, `201`). This is what the overwhelming majority of APIs calling themselves "REST" actually are, and it's a perfectly legitimate stopping point.
- **Level 3 — HATEOAS** (Hypermedia as the Engine of Application State). Responses include links to the next valid actions, so a client discovers the API's state machine at runtime instead of hardcoding URL templates — a `GET /orders/42` response includes a `"cancel": { "href": "/orders/42/cancel" }` link only when the order is actually cancellable. Genuinely rare in practice outside specific domains (some payment and banking APIs) because it adds real client and server complexity for a discoverability benefit most API consumers don't need — they read the docs once and hardcode the URL anyway.

## GraphQL: Solving Over-Fetching and Under-Fetching

A REST endpoint returns a fixed response shape. If a mobile client needs only a user's name and avatar but the endpoint returns twelve fields, that's **over-fetching** — wasted bandwidth. If the client needs a user plus their five most recent posts, and no endpoint returns both, that's **under-fetching** — forcing N additional round trips. GraphQL fixes both by letting the client specify exactly the shape of data it wants, resolved server-side by per-field resolver functions, in one round trip:

```graphql
query {
  user(id: "42") {
    name
    avatarUrl
    posts(limit: 5) {
      title
      createdAt
    }
  }
}
```

One request returns exactly `name`, `avatarUrl`, and five posts' `title`/`createdAt` — nothing more, nothing less, and no separate `/posts?userId=42` call. The real cost shows up server-side: a naive resolver implementation can turn one GraphQL query into an **N+1 query problem** (a `posts` resolver that runs a separate database query per user in a list, instead of batching), which is why production GraphQL servers almost always pair it with a batching/caching layer like DataLoader.

## gRPC: Internal Service-to-Service, Not Public APIs

gRPC defines service contracts in **Protocol Buffers** (`.proto` files) — a strongly-typed, binary serialization format compiled into client/server stubs in many languages — and communicates over **HTTP/2**, which supports request multiplexing (many concurrent requests on one connection, no head-of-line blocking at the HTTP layer) and bidirectional streaming natively.

```proto
service UserService {
  rpc GetUser (GetUserRequest) returns (User);
}
message GetUserRequest { string id = 1; }
message User { string id = 1; string name = 2; string email = 3; }
```

gRPC wins for **internal service-to-service calls** where both ends are systems you control: binary serialization is smaller and faster to parse than JSON, the generated stubs give you compile-time type safety across language boundaries, and HTTP/2 streaming suits high-throughput internal traffic well. It loses for public APIs: binary payloads aren't human-inspectable in a browser dev tools network tab the way JSON is, browser support for gRPC directly is limited (gRPC-Web needs a proxy translation layer), and the barrier to entry for a third-party developer poking at your API with `curl` is much higher than REST/JSON.

## WebSockets vs. Server-Sent Events

**WebSockets** open a single persistent, full-duplex connection — both client and server can push messages at any time, in either direction, over the same connection. This is the right tool when the client genuinely needs to send data too: a chat app, a collaborative editor, a multiplayer game.

**Server-Sent Events (SSE)** are a simpler, one-way channel: the server pushes a stream of events over a single long-lived HTTP connection (`Content-Type: text/event-stream`), and the client only receives — it can't push data back over the same channel (it'd send a normal HTTP request for anything it needs to say). 

```js
const events = new EventSource("/api/notifications/stream");
events.onmessage = (e) => console.log("New notification:", JSON.parse(e.data));
```

SSE is the simpler, correct choice whenever the data flow is genuinely one-directional — live notifications, a progress bar for a long-running server job, a live dashboard feed. It runs over plain HTTP (works through existing proxies/load balancers without special handling, auto-reconnects natively via the `EventSource` API), needs no separate protocol upgrade handshake, and doesn't require the server to manage bidirectional message routing it'll never use. Reaching for a WebSocket when the server only ever pushes and the client never talks back is unnecessary protocol complexity for no benefit — a mistake worth catching in review.
