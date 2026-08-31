# SQL and Relational Databases

Relational databases are the default data store for most of the software industry, and their vocabulary — ACID, normal forms, joins, query plans — shows up in interviews and production incidents regardless of what your own stack actually runs. This file covers the mental model a backend engineer needs even on a project, like AstriX, that never touches SQL.

## ACID Properties

ACID describes the guarantees a relational database transaction makes:

- **Atomicity** — a transaction's writes all happen or none do. If a transaction debits one account and credits another, a crash between the two leaves neither applied, never just one.
- **Consistency** — a transaction moves the database from one valid state to another, respecting constraints (foreign keys, unique indexes, `CHECK` constraints). The database rejects a write that would violate a declared constraint rather than silently applying it.
- **Isolation** — concurrent transactions behave, from each transaction's point of view, as if they ran one after another rather than interleaved. How strictly this is enforced is tunable — that's the isolation-level discussion below.
- **Durability** — once a transaction commits, it survives a crash. The database has fsynced it to disk (or to a write-ahead log) before returning success to the client.

These four properties are what let you write `BEGIN; UPDATE accounts SET balance = balance - 100 WHERE id = 1; UPDATE accounts SET balance = balance + 100 WHERE id = 2; COMMIT;` and trust that a power failure mid-transfer can never leave money missing or duplicated.

## Normalization: 1NF, 2NF, 3NF

Normalization is the process of structuring tables to eliminate redundant data and the update anomalies redundancy causes. Each normal form fixes one specific kind of redundancy. Here's a single example carried through all three.

**Starting point — a flat, unnormalized table:**

```sql
CREATE TABLE orders_flat (
  order_id       INT,
  customer_name  VARCHAR(100),
  customer_email VARCHAR(100),
  product_name   VARCHAR(100),
  product_price  DECIMAL(10,2)
);
```

A single order with three line items needs three rows, each repeating `customer_name` and `customer_email` verbatim. This is technically **1NF-compliant already** (every column holds a single atomic value, no comma-separated lists or repeating groups), but it's riddled with redundancy that the next two forms exist to remove.

**2NF — eliminate partial dependencies.** 2NF applies when a table has a composite primary key, and it requires every non-key column to depend on the *whole* key, not just part of it. Here, the natural key is `(order_id, product_name)`, but `customer_name` and `customer_email` depend only on `order_id` — a partial dependency. Split the order-level facts out:

```sql
CREATE TABLE orders (
  order_id       INT PRIMARY KEY,
  customer_name  VARCHAR(100),
  customer_email VARCHAR(100),
  order_date     DATE
);

CREATE TABLE order_items (
  order_id      INT REFERENCES orders(order_id),
  product_name  VARCHAR(100),
  product_price DECIMAL(10,2),
  PRIMARY KEY (order_id, product_name)
);
```

**3NF — eliminate transitive dependencies.** A transitive dependency is a non-key column that depends on *another non-key column* rather than directly on the primary key. In `orders`, `customer_email` really depends on which customer placed the order, not on the order itself — proven by the fact that the same customer's email is duplicated across every order they've ever placed. Pull customers into their own table:

```sql
CREATE TABLE customers (
  customer_id    INT PRIMARY KEY,
  customer_name  VARCHAR(100),
  customer_email VARCHAR(100)
);

CREATE TABLE orders (
  order_id    INT PRIMARY KEY,
  customer_id INT REFERENCES customers(customer_id),
  order_date  DATE
);
```

Now a customer's email lives in exactly one row. Change it once, and every order that references `customer_id` sees the new value with no rewrite. This is the payoff of normalization: it trades read-time joins for write-time correctness. Whether that trade is worth it — and MongoDB-style databases let you decline it — is a real design decision, not a free win either way.

## Joins

Given `customers`, `orders`, and `order_items` above, joins reassemble the graph that normalization split apart.

```sql
-- INNER JOIN: only customers who have placed at least one order
SELECT c.customer_name, o.order_id, o.order_date
FROM customers c
INNER JOIN orders o ON o.customer_id = c.customer_id;

-- LEFT JOIN: every customer, with NULLs for those who've never ordered
SELECT c.customer_name, o.order_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.customer_id;

-- RIGHT JOIN: every order, with NULLs if the customer row is somehow missing
SELECT c.customer_name, o.order_id
FROM customers c
RIGHT JOIN orders o ON o.customer_id = c.customer_id;

-- FULL OUTER JOIN: everything on both sides, matched where possible
SELECT c.customer_name, o.order_id
FROM customers c
FULL OUTER JOIN orders o ON o.customer_id = c.customer_id;
```

`INNER JOIN` keeps only matching rows on both sides. `LEFT JOIN` keeps every row from the left table, filling unmatched right-side columns with `NULL` — the workhorse for "give me all Xs, with their Ys if they have any." `RIGHT JOIN` is the mirror image and is rarely used in practice because you can always rewrite it as a `LEFT JOIN` by swapping table order. `FULL OUTER JOIN` keeps unmatched rows from both sides simultaneously — useful for reconciliation queries ("what's in table A but not B, and vice versa") but not supported by MySQL without emulating it via `UNION`.

## Indexing: B-Tree Basics and the Write Tradeoff

Without an index, finding a row means scanning every row in the table (`Seq Scan` in Postgres terms). An index is a separate, sorted data structure — almost always a **B-tree** — that maps column values to row locations, so a lookup becomes O(log n) instead of O(n).

```sql
CREATE INDEX idx_orders_customer_id ON orders (customer_id);
```

A B-tree keeps its entries sorted and balanced across nodes, so both equality lookups (`WHERE customer_id = 42`) and range scans (`WHERE order_date BETWEEN '2026-01-01' AND '2026-02-01'`) stay fast as the table grows — the tree's depth grows logarithmically, not linearly, with row count.

The tradeoff: **every index speeds up reads and slows down writes.** Every `INSERT`, `UPDATE`, or `DELETE` has to update not just the table's heap storage but every index that covers a changed column, in the same transaction. A table with eight indexes pays that cost eight times per write. This is why you don't index every column "just in case" — an index that's never used in a `WHERE`, `JOIN`, or `ORDER BY` clause is pure write-path tax with zero read-path benefit, and a wide, write-heavy table (an audit log, an events table) is often better served by fewer indexes than a read-heavy lookup table.

## Reading a Query Plan

Postgres's `EXPLAIN` shows how the planner intends to execute a query, without running it; `EXPLAIN ANALYZE` actually runs it and reports real timings alongside the plan.

```sql
EXPLAIN ANALYZE
SELECT c.customer_name, o.order_id
FROM customers c
JOIN orders o ON o.customer_id = c.customer_id
WHERE c.customer_id = 42;
```

```
Nested Loop  (cost=0.29..8.61 rows=3 width=40) (actual time=0.021..0.028 rows=3 loops=1)
  ->  Index Scan using customers_pkey on customers c  (cost=0.14..0.16 rows=1 width=24) (actual time=0.010..0.011 rows=1 loops=1)
        Index Cond: (customer_id = 42)
  ->  Index Scan using idx_orders_customer_id on orders o  (cost=0.15..8.42 rows=3 width=20) (actual time=0.008..0.012 rows=3 loops=1)
        Index Cond: (customer_id = 42)
Planning Time: 0.112 ms
Execution Time: 0.051 ms
```

Read it bottom-up, inside-out: each `Index Scan` is a leaf operation, and outer nodes (`Nested Loop`) combine their results. `cost=0.29..8.61` is the planner's *estimate* (startup cost .. total cost, in arbitrary units); `actual time=...` (only present with `ANALYZE`) is what really happened. The gotcha that bites people in production: when `rows` (estimated) and `actual rows` diverge wildly, the planner's statistics are stale — usually fixed by running `ANALYZE tablename;` — and a wildly wrong row estimate is the most common reason Postgres picks a `Seq Scan` over an available index, or picks the wrong join algorithm entirely.

## Transactions and Isolation Levels

Isolation levels trade correctness guarantees for concurrency. Each level up prevents one more class of anomaly, at the cost of more locking or more transaction aborts.

| Level | Prevents | Still allows |
|---|---|---|
| Read Uncommitted | nothing | dirty reads, non-repeatable reads, phantom reads |
| Read Committed (Postgres default) | dirty reads | non-repeatable reads, phantom reads |
| Repeatable Read | dirty reads, non-repeatable reads | phantom reads (Postgres's implementation actually also blocks phantoms via MVCC snapshots, stricter than the SQL standard requires) |
| Serializable | all of the above | nothing — behaves as if transactions ran strictly one at a time |

- A **dirty read** is seeing another transaction's uncommitted write — which might get rolled back a moment later.
- A **non-repeatable read** is re-reading the same row twice in one transaction and getting different values, because another transaction committed a change in between.
- A **phantom read** is re-running the same range query twice and getting a different *set of rows*, because another transaction inserted or deleted a matching row in between.

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT balance FROM accounts WHERE id = 1;
-- application logic checks balance >= 100
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

The gotcha: `SERIALIZABLE` doesn't achieve safety by blocking more — Postgres implements it optimistically, letting transactions proceed and then **aborting one with a serialization failure at commit time** if it detects a conflict. That means serializable transactions must be wrapped in retry logic in application code; treating a serialization failure as a fatal error instead of a "retry this transaction" signal is a common production bug.

## Where This Shows Up in AstriX

AstriX uses MongoDB via Mongoose, not a relational database, which is a real trade, not a downgrade. What's given up: joins become application-level `.populate()` calls or a second query rather than a single planned execution, and there's no cross-collection transaction without explicitly opening one — AstriX does this via `mongoose.startSession()`/`startTransaction()` for the handful of writes that touch more than one collection atomically (user registration, OAuth login-or-create, account deletion, workspace creation/deletion). What's gained: schema flexibility per collection and a horizontal-scaling story (sharding) that doesn't require the application to reason about cross-shard joins. [`docs/backend/07-database-schema-design.md`](../backend/07-database-schema-design.md) covers how AstriX modeled its ten Mongoose collections (verified: reference-based, zero embedded subdocuments), and [`docs/backend/08-database-queries-and-transactions.md`](../backend/08-database-queries-and-transactions.md) covers the transaction mechanics and indexing in full depth on the Mongo side.
