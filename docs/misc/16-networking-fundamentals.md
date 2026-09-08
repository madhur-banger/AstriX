# Networking Fundamentals

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Cloud docs talk about VPCs, security groups, and load balancers as if the protocols underneath them are a given. They're not — a VPC is just AWS's product wrapping IP addressing and routing; a security group is a policy layer on top of TCP/UDP; an ALB is a piece of infrastructure making L7 HTTP decisions. This file covers the actual protocols those products are built on, condensed to what matters day-to-day rather than the full seven-layer OSI abstraction.

## The Layers That Matter

The OSI model has seven layers; in practice, working engineers reason in terms of three:

- **L3 — IP (Internet Protocol).** Addressing and routing. An IP address identifies a host; routers use it to forward packets toward their destination, hop by hop, with no guarantee of delivery, ordering, or even that a packet arrives at all. IP is a "best effort" layer — everything about reliability is built on top of it, not inside it.
- **L4 — TCP/UDP.** Where "reliable" or "unreliable" gets decided, and where a **port number** (0–65535) identifies which application on a host a packet is for — this is the layer a security group rule (`allow TCP 443 from 0.0.0.0/0`) actually operates at.
- **L7 — HTTP (and other application protocols).** What the bytes inside the L4 payload actually mean — a request line, headers, a body. This is the layer a load balancer's path-based routing rule or an API's REST semantics live at.

## DNS Resolution

Typing a domain into a browser triggers a lookup chain before a single byte of the actual request goes out:

1. **Browser cache** — has this exact hostname been resolved recently? Browsers cache DNS answers for the duration of the record's TTL.
2. **OS cache** — the operating system's own resolver cache (`systemd-resolved` on Linux, similar on macOS/Windows).
3. **Recursive resolver** — if neither cache has an answer, the query goes to a configured recursive resolver (your ISP's, or a public one like `8.8.8.8`/`1.1.1.1`), which does the actual multi-step lookup on the client's behalf.
4. **Root servers** — the recursive resolver asks a root DNS server (there are 13 logical root server addresses, globally anycast) "who's authoritative for `.com`?"
5. **TLD servers** — the root server answers with the `.com` TLD server's address; the resolver asks it "who's authoritative for `example.com`?"
6. **Authoritative nameserver** — the TLD server answers with the domain's actual authoritative nameserver (e.g., Route 53, Cloudflare); the resolver asks it directly for the `A`/`AAAA` record, gets the real IP, and caches the answer for the record's TTL before returning it to the client.

```bash
dig example.com                    # full DNS query + answer, including which record type and TTL
dig +short example.com             # just the resolved IP(s)
dig example.com A                  # explicitly request the IPv4 address record
nslookup example.com               # older, simpler tool — same underlying query
```

A `dig` response's `ANSWER SECTION` shows the resolved IP and the record's remaining TTL in seconds — this is directly why DNS changes (like repointing a domain to a new load balancer) don't take effect everywhere instantly: every resolver and browser that already cached the old answer keeps using it until that TTL expires, which is also why lowering a record's TTL *before* a planned cutover is a standard pre-migration step.

## TCP vs UDP

**TCP** is connection-oriented and reliable: before any data moves, client and server perform a **three-way handshake** — `SYN` (client: "I want to connect, here's my starting sequence number") → `SYN-ACK` (server: "acknowledged, here's mine") → `ACK` (client: "acknowledged") — establishing a stateful connection both sides track. Every subsequent packet is sequenced and acknowledged; a lost packet gets retransmitted, and packets are reassembled in order on the receiving end before the application ever sees them.

**UDP** is connectionless: a datagram is sent with no handshake, no acknowledgment, and no retransmission. If it's lost, it's gone — the application layer has to notice and handle that itself, if it cares to at all.

The tradeoff is exactly why protocol choice varies by workload. A video call needs the *latest* frame delivered fast far more than it needs *every* frame delivered eventually — a frame that arrives late because it was waiting for a retransmitted, now-stale predecessor is worse than a frame simply dropped. That's why WebRTC and most video-conferencing stacks run over UDP-based protocols (RTP), accepting occasional visible glitches in exchange for low, consistent latency, whereas a file download or a database connection needs every byte, in order, correctly — exactly what TCP guarantees at the cost of retransmission delay when packets are lost.

## HTTP/1.1 vs HTTP/2 vs HTTP/3

**HTTP/1.1** sends one request per TCP connection at a time by default (or uses several parallel connections as a workaround — the classic "6 connections per host" browser limit). A slow response blocks everything queued behind it on that connection — **head-of-line blocking** at the application layer, since HTTP/1.1 has no way to interleave multiple in-flight requests on one connection.

**HTTP/2** fixes that specific problem with **multiplexing**: many requests and responses share a single TCP connection, broken into frames tagged with a stream ID, interleaved and reassembled independently. One slow response no longer blocks unrelated ones on the same connection.

**HTTP/3** exists because HTTP/2's fix was incomplete — it solved head-of-line blocking at the *application* layer but the underlying transport is still TCP, and TCP itself enforces in-order delivery at the *packet* layer. A single lost TCP packet stalls *every* multiplexed stream on that connection until it's retransmitted, because TCP won't hand the kernel's later-arrived bytes to the application until the gap is filled — head-of-line blocking has moved down a layer, not disappeared. HTTP/3 fixes this by replacing TCP with **QUIC**, a transport built on top of UDP that implements its own reliability and multiplexing where each stream's loss recovery is independent — a lost packet on stream A no longer blocks stream B, because QUIC (unlike TCP) actually tracks streams as separate entities at the transport layer rather than as an application-layer abstraction bolted onto one ordered byte stream.

## The TLS Handshake

TLS solves a specific problem: two parties who've never communicated before need to establish an encrypted channel, without a shared secret already in place, over a network an attacker can observe or tamper with. The handshake (TLS 1.2 shape; TLS 1.3 collapses some round trips but solves the same problems):

1. **Client Hello** — the client sends the TLS versions and cipher suites it supports, plus a random value.
2. **Server Hello + certificate + public key** — the server picks a cipher suite, sends its certificate (proving its identity, signed by a CA the client's trust store already trusts) and its public key.
3. **Key exchange → shared symmetric session key** — client and server each contribute material (historically via RSA key exchange; almost universally Diffie-Hellman/ECDHE today) that lets both sides independently derive the *same* symmetric session key, without ever transmitting that key itself over the wire.
4. **Encrypted traffic** — from this point on, all application data (the actual HTTP request/response) is encrypted with the symmetric session key, not the public key.

Each step solves a distinct problem: the certificate solves *authentication* (you're actually talking to the domain you think you are, not an attacker in the middle); asymmetric key exchange solves *establishing a shared secret over an insecure channel with no prior relationship*; switching to a *symmetric* key for the actual traffic solves *performance* — asymmetric crypto is computationally far more expensive than symmetric crypto, so real TLS traffic uses asymmetric operations only briefly, during the handshake, to bootstrap a fast symmetric key for everything after.
