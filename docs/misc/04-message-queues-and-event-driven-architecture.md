# Message Queues and Event-Driven Architecture

Queues decouple producers from consumers in time — a producer can fire an event and move on without waiting for whoever processes it, and a consumer can process at its own pace without the producer needing to know it exists. This file covers the real systems in this space, what actually differs between them, and the delivery-semantics vocabulary that determines what your consumer code has to defend against.

## Real Systems, Real Differences

**Kafka** is a distributed, log-based system. Messages ("records") are appended to a durable, ordered, partitioned log per topic and *retained* for a configurable period (or forever) rather than deleted on consumption — a consumer reads by tracking an offset into the log, and multiple independent consumer groups can each read the same topic from their own offset, including replaying from the beginning. This replayability is Kafka's defining feature: a new consumer can be added months later and reprocess history, which a traditional queue can't offer once a message is consumed and deleted.

**RabbitMQ** is a traditional message broker built around the AMQP model: producers publish to an *exchange*, which routes messages into *queues* based on bindings (direct, topic, fanout), and a message is normally removed from the queue once a consumer acknowledges it. There's no built-in replay — once consumed and acked, it's gone. In exchange, RabbitMQ gives you flexible routing (route by topic pattern, fan out to multiple queues, priority queues) that Kafka doesn't natively provide.

**AWS SQS** is a managed, simple point-to-point queue — no routing logic, no partitions to reason about, just `SendMessage`/`ReceiveMessage`/`DeleteMessage` against a queue AWS operates for you. **SNS** is AWS's managed pub/sub topic, usually paired with SQS (SNS fans a message out to multiple SQS queues, one per subscriber) to get pub/sub semantics on top of SQS's simple queue primitive. The tradeoff versus self-hosting Kafka or RabbitMQ is operational: no cluster to run, patch, or scale, at the cost of AWS's specific feature set and pricing model rather than open-ended configurability.

## Delivery Semantics

- **At-most-once** — a message might be lost, but is never redelivered. The consumer acks before processing (or processing happens once, with no retry on failure). Cheapest, riskiest.
- **At-least-once** — a message is never silently lost, but might be delivered more than once (producer retries after a timeout it isn't sure succeeded; consumer crashes after processing but before acking, so the broker redelivers). This is the default most real systems (SQS, RabbitMQ with manual acks, Kafka with manual offset commits) actually provide.
- **Exactly-once** — the message is processed once and only once, with no duplicates and no loss. In practice, true exactly-once across two independent systems (a broker and a database) requires either a distributed transaction spanning both or a specific integration (Kafka's transactional producer/consumer API, scoped to Kafka-to-Kafka). **The practical, portable version of "exactly-once" that almost every production system actually uses is at-least-once delivery plus an idempotent consumer** — the message might arrive twice, but processing it twice produces the same end state as processing it once.

```js
async function handleOrderPaidEvent(event) {
  const alreadyProcessed = await db.processedEvents.findOne({ eventId: event.id });
  if (alreadyProcessed) return; // duplicate delivery, no-op

  await db.orders.updateOne({ _id: event.orderId }, { status: "paid" });
  await db.processedEvents.insertOne({ eventId: event.id, processedAt: new Date() });
}
```

Storing a processed-event ID (or using a naturally idempotent write, like `SET status = 'paid'` rather than `balance += amount`) is what makes at-least-once delivery safe to treat as exactly-once from the business logic's perspective.

## Pub/Sub vs. Point-to-Point

**Point-to-point**: one message, consumed by exactly one consumer, even if multiple consumer instances are listening (a worker pool competing for jobs off the same queue — SQS and a RabbitMQ queue with multiple consumers both work this way). Good for distributing work across a pool of interchangeable workers.

**Pub/sub**: one message (event), delivered to *every* independent subscriber (each subscriber typically has its own queue or offset). Good for "something happened, and multiple unrelated parts of the system each need to react" — a `UserRegistered` event that both an email service and an analytics service need to see, independently, without either knowing the other exists.

## Dead-Letter Queues and Poison-Pill Messages

A **poison-pill message** is one that a consumer can never successfully process — malformed payload, a bug that throws on this specific input, a downstream dependency that will never accept it. Without a limit, a naive at-least-once consumer keeps retrying the same message forever, blocking the queue behind it (in an ordered system) or burning resources indefinitely.

A **dead-letter queue (DLQ)** is the standard fix: after a message fails processing N times (a configured `maxReceiveCount` in SQS, or a retry-count header checked manually), the broker or consumer routes it to a separate DLQ instead of retrying again. The main queue keeps flowing, and the DLQ becomes a place a human (or an automated alert) investigates without it blocking live traffic. Configuring a DLQ without also alerting on messages landing in it is a common gap — a silently growing DLQ means silently failing work that nobody's aware of.

```json
{
  "RedrivePolicy": {
    "deadLetterTargetArn": "arn:aws:sqs:us-east-1:123456789012:orders-dlq",
    "maxReceiveCount": 5
  }
}
```
