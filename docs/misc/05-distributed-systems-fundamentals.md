# Distributed Systems Fundamentals

Once a system spans more than one machine, a whole class of failure modes becomes possible that a single-process application never has to think about: a network link can drop, a node can be slow without being down, and "the same data" can legitimately mean two different things on two different machines for a little while. This file covers the vocabulary for reasoning about that precisely.

## CAP Theorem, Explained Correctly

CAP theorem is frequently mis-stated as "pick two of Consistency, Availability, Partition tolerance, forever." That's wrong in a way that matters: **partition tolerance isn't optional** — a network partition (nodes that can't talk to each other) is a fact of physical networks that will eventually happen whether your system is designed for it or not. CAP is really about **what a distributed system does during an actual partition**, not a permanent three-way tradeoff you get to pick once at design time.

When a partition happens and a node can't reach the rest of the cluster, it faces exactly one choice, per request, right then:

- **Choose Consistency**: refuse the request (return an error, or block) rather than risk answering with possibly-stale data. The system becomes unavailable for that request during the partition.
- **Choose Availability**: answer anyway, using whatever local data is available, accepting the answer might be stale or might conflict with a write happening on the other side of the partition.

Outside of an actual partition, a well-designed distributed system can be both consistent and available simultaneously — CAP says nothing about normal operation. It's specifically a statement about the moment communication breaks. A system's CAP "classification" (Postgres with synchronous replication leans CP; DNS and most CDNs lean AP) describes its behavior during that failure mode, not a permanent ceiling on its normal-case guarantees.

## Strong vs. Eventual Consistency

**Strong consistency**: after a write completes, every subsequent read (from any node) sees that write. **Eventual consistency**: after a write completes, reads *will* eventually see it, but there's a window — could be milliseconds, could be longer under load — where a read might return the old value.

Concrete example: a social app increments a post's like-count and the count is served from a read replica.

- Under **strong consistency**, the user who just liked the post refreshes and immediately sees the new count, guaranteed, because the read is either routed to the primary or the replica is guaranteed caught up before answering.
- Under **eventual consistency**, that same refresh can briefly show the old count if the read hits a replica that hasn't yet received the replicated write — a classic **read-your-own-writes** violation. This is why some systems route a user's own reads to the primary right after they write, even if other users' reads go to eventually-consistent replicas — a targeted fix rather than paying strong-consistency cost for every read.

Neither is universally "better" — strong consistency costs latency and availability (you may have to wait for or fail requests to guarantee it); eventual consistency costs correctness windows in exchange for lower latency and higher availability. The right choice depends on whether a stale read for a few hundred milliseconds is a shrug (a like count) or a real problem (an account balance).

## Leader-Follower Replication

One node (the leader/primary) accepts all writes; one or more followers/replicas asynchronously (or synchronously) apply the same write stream and serve read traffic. This is the standard way to scale reads horizontally without sharding: writes stay serialized through one leader (avoiding write conflicts), while reads fan out across many followers. The tradeoff is exactly the consistency question above — synchronous replication (leader waits for a follower to confirm before acking the write) gives strong consistency at the cost of write latency and availability if a follower is slow; asynchronous replication is fast but reintroduces the eventual-consistency window on followers.

If the leader dies, something has to promote a follower to the new leader — and that "something" has to make sure two nodes don't both believe they're the leader simultaneously (**split brain**), which is where consensus algorithms come in.

## Sharding and Partitioning

Sharding splits data itself across multiple nodes, each owning a subset, so no single node needs to hold (or serve) all the data — this is how you scale writes, not just reads.

- **Range partitioning**: each shard owns a contiguous range of the key space (e.g. user IDs 1–1,000,000 on shard A, 1,000,001–2,000,000 on shard B). Range scans across a contiguous key range stay fast (they usually hit one shard), but a workload skewed toward one range (all-time-high user-ID growth means all new writes hit the newest, "hottest" shard) can create a hotspot.
- **Hash partitioning**: a hash of the key determines the shard (`shard = hash(userId) % numShards`). This spreads load evenly regardless of key distribution, but a range scan (`give me users 1000–2000`) now has to fan out to every shard, since consecutive keys are scattered across all of them.

## Consensus, Briefly

Any time multiple nodes need to agree on one fact — who the leader is, what order a set of operations happened in — without a single node dictating the answer (a single point of failure), you need a **consensus algorithm**. Raft and Paxos exist specifically to solve this safely even when some nodes crash or messages are delayed/lost, guaranteeing the cluster never ends up with two nodes simultaneously believing they're the leader. You don't need to implement Raft yourself day-to-day — real systems you'll actually deploy and depend on for this, like **etcd** (used by Kubernetes for cluster state) and **ZooKeeper** (used by Kafka historically, and many older distributed systems, for leader election and coordination), have already implemented it and expose a simple key-value/watch API on top. Knowing that a coordination service exists for this problem — and reaching for one instead of hand-rolling leader election with a timeout and a prayer — is the actually useful takeaway.
