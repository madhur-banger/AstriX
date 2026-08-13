> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

# Database Queries & Transactions

This file owns two things: how AstriX actually talks to MongoDB on a per-query basis (connection lifecycle, pool sizing, the ODM boundary), and every place in the codebase where more than one write has to succeed or fail together as a single atomic unit. The *shape* of the data — which collections exist, how they reference each other, which fields are indexed for which query — belongs to [`07-database-schema-design.md`](./07-database-schema-design.md); this file assumes that shape exists and focuses on the mechanics of reading and writing it safely under concurrency and partial failure.

---

## 1. The Landscape

Before looking at AstriX, it's worth naming the actual menu of options for "how does application code talk to a database," because the choice shapes everything downstream — how much boilerplate you write, how much the database can enforce on your behalf, and how easy the code is to test or swap later.

### 1.1 Data-access approaches

**(a) Raw driver calls.** No abstraction layer at all — you call the database vendor's own client library directly. For MongoDB, that's the official `mongodb` Node driver:

```js
const client = new MongoClient(uri);
const db = client.db("app");
const user = await db.collection("users").findOne({ email });
await db.collection("users").insertOne({ email, name, createdAt: new Date() });
```

Maximum control — you see exactly what goes over the wire, and there's no framework "magic" to work around when you need something unusual. The cost is that *everything* is boilerplate: no schema enforcement (a typo'd field name just silently writes a new field), no built-in validation, and any convention (timestamps, soft-delete flags, default values) has to be hand-rolled and repeated at every call site.

**(b) Query builder.** A library that constructs queries programmatically, with some type safety, but without a full object-document/object-relational mapping layer sitting between your code and the returned rows. The canonical SQL example is [Knex](https://knexjs.org/):

```js
const user = await knex("users").where({ email }).first();
await knex("users").insert({ email, name });
```

For MongoDB, the closest equivalent isn't a separate library — it's using the driver's own aggregation-pipeline builder directly instead of a full ODM, composing `$match`/`$lookup`/`$group` stages by hand for anything beyond a simple `find`. You get composability and some protection against string-concatenated queries, but no schema, no hooks, and the mapping from "row/document" back to a typed object is still your problem.

**(c) Full ODM/ORM.** A layer that maps application objects to documents/rows *and* owns schema definition, validation, and lifecycle hooks — Mongoose for MongoDB, or Prisma/TypeORM/Sequelize for SQL. This is what AstriX uses.

```js
// Mongoose
const UserSchema = new Schema({ email: { type: String, required: true, unique: true } });
const User = model("User", UserSchema);
const user = await User.findOne({ email });
```

```ts
// Prisma (SQL, but same category of tool)
const user = await prisma.user.findUnique({ where: { email } });
```

The ODM/ORM enforces a schema at the application layer (Mongoose validates types and required fields before a write reaches Mongo at all), gives you lifecycle hooks (pre-save password hashing, for instance), and turns a raw document/row into a typed, method-bearing object. The cost is an abstraction layer with its own behavior to learn — Mongoose's casting rules, its query builder chaining, its session/transaction API — and a real performance tax if you don't opt out of it for read-only paths (see §7 on `.lean()`).

**(d) Repository pattern.** Layered on top of any of the above: an explicit interface sits between services and the underlying data-access technology, so business logic depends on an abstraction (`UserRepository`) rather than directly on Mongoose or Prisma.

```ts
interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  create(data: NewUser): Promise<User>;
}

class MongooseUserRepository implements UserRepository {
  async findByEmail(email: string) {
    return UserModel.findOne({ email }).lean();
  }
  async create(data: NewUser) {
    return UserModel.create(data);
  }
}
```

The theoretical payoff is swappability — the database technology could change underneath the interface without touching business logic — and centralization of query logic that would otherwise be duplicated across services. The cost is a whole extra layer that needs its own tests, its own maintenance, and a translation step between "what the repository interface promises" and "what the underlying ODM actually does" (a Mongoose-specific concept like `.session()` for transactions has to be threaded through the interface too, or the abstraction leaks the moment you need a multi-document transaction). **AstriX does not have this layer** — verified directly: every service under `backend/src/services/` imports Mongoose models (`UserModel`, `WorkspaceModel`, etc.) and calls them directly. There is no `repositories/` folder, no `IUserRepository` interface, nothing between a service function and `mongoose.model(...)`.

### 1.2 Transaction models

Separately from "how do you issue a single query," there's "how do you guarantee multiple writes succeed or fail together." Three real approaches:

**No transactions at all — relying on single-document atomicity.** MongoDB *always* guarantees that a write to a single document is atomic, regardless of transaction usage — a `updateOne` that touches five fields on one document either applies all five or none, with no explicit transaction needed. A huge fraction of real-world writes never need more than this guarantee:

```js
await TaskModel.findByIdAndUpdate(taskId, { status: "done", completedAt: new Date() });
```

This is the cheapest option (no session overhead, no two-phase-commit-style locking) and it's suffient whenever "atomic" only needs to mean "this one document, all its fields, together."

**Application-level saga / compensating transactions.** Used when true ACID transactions aren't available or desirable across service or database boundaries — most commonly in a microservices architecture where each step lives in a different service with its own datastore, so no single database transaction could span all of them anyway. Each step defines an explicit "undo":

```js
// pseudocode - a booking saga across three independent services
async function bookTrip(order) {
  const flight = await flightsService.reserve(order.flight);
  try {
    const hotel = await hotelsService.reserve(order.hotel);
    try {
      await paymentsService.charge(order.card, order.total);
    } catch (err) {
      await hotelsService.cancel(hotel.id); // compensate step 2
      throw err;
    }
  } catch (err) {
    await flightsService.cancel(flight.id); // compensate step 1
    throw err;
  }
}
```

This buys cross-service atomicity-in-spirit without a distributed transaction coordinator, at the cost of every step needing a correct, tested "undo" — and a window where partial state is visible to the rest of the system before the compensation runs.

**True multi-document ACID transactions**, via `mongoose.startSession()` / `session.startTransaction()`. MongoDB has supported multi-document ACID transactions since version 4.0 (replica sets) / 4.2 (sharded clusters). A session groups a set of operations so they commit or abort together, with snapshot isolation for reads inside the transaction:

```js
const session = await mongoose.startSession();
try {
  session.startTransaction();
  await ModelA.create([{ ... }], { session });
  await ModelB.updateOne({ ... }, { ... }, { session });
  await session.commitTransaction();
} catch (err) {
  await session.abortTransaction();
  throw err;
} finally {
  session.endSession();
}
```

This is the strongest guarantee available inside a single MongoDB deployment — genuinely all-or-nothing across collections — but it isn't free: transactions hold locks for their duration, add round-trip overhead for `startTransaction`/`commitTransaction`, and (critically, see §3.4) require the target deployment to be a replica set or sharded cluster; a standalone `mongod` cannot run transactions at all. **This is what AstriX uses, selectively**, for exactly the operations where single-document atomicity isn't enough.

---

## 2. AstriX's Choice

AstriX uses **Mongoose as a full ODM** — schemas, validation, and lifecycle hooks live on the model definitions in `backend/src/models/`, and every service imports those models directly with no repository layer in between. For the subset of operations that write across more than one collection as a single logical unit — user registration, OAuth login-or-create, account deletion, workspace creation, and workspace deletion — AstriX reaches for a real multi-document ACID transaction via `mongoose.startSession()`/`startTransaction()`. Every other write (a task update, a project creation, a role change) relies on MongoDB's built-in single-document atomicity and skips the session machinery entirely.

---

## 3. AstriX Implementation

### 3.1 Connection setup and pool sizing

```ts
// backend/src/config/database.config.ts:1-19
import mongoose from "mongoose";
import { config } from "./app.config";
import { logger } from "../utils/logger";

const connectDatabase = async () => {
  try {
    await mongoose.connect(config.MONGO_URI, {
      maxPoolSize: config.MONGO_MAX_POOL_SIZE,
      minPoolSize: config.MONGO_MIN_POOL_SIZE,
    });
    logger.info("Connected to Mongo Database");
  } catch (error) {
    logger.error({ err: error }, "Error connecting to Mongo Database");
    process.exit(1);
  }
};

export default connectDatabase;
```

The pool bounds themselves are computed in `app.config.ts`, with the reasoning spelled out in the source comment:

```ts
// backend/src/config/app.config.ts:9-28 (excerpted — the object literal continues past line 28 with unrelated config)
// The Mongo driver's default maxPoolSize is 100 PER PROCESS. With several
// ECS tasks scaling out behind the ALB, that can exhaust a lower-tier Atlas
// cluster's total connection ceiling long before any single task is
// actually saturated - so bound it explicitly instead of inheriting the
// default. minPoolSize keeps a few connections warm so a freshly started
// task doesn't pay handshake latency on its first requests.
const DEFAULT_MONGO_MAX_POOL_SIZE = "15";
const DEFAULT_MONGO_MIN_POOL_SIZE = "2";

const appConfig = () => ({
  NODE_ENV,
  PORT,
  BASE_PATH,
  MONGO_URI: getEnv("MONGO_URI", ""),
  MONGO_MAX_POOL_SIZE: Number(
    getEnv("MONGO_MAX_POOL_SIZE", DEFAULT_MONGO_MAX_POOL_SIZE)
  ),
  MONGO_MIN_POOL_SIZE: Number(
    getEnv("MONGO_MIN_POOL_SIZE", DEFAULT_MONGO_MIN_POOL_SIZE)
  ),
  ...
```

`connectDatabase()` is awaited before the server starts listening — the exact code and reasoning for that ordering lives in the bootstrap file and is already covered in full in the master backend file, reused here because it's the other half of "connection lifecycle":

```ts
// backend/src/index.ts:176-182, 188-236 (excerpted — see 00-master-backend-architecture.md §3 for the complete bootstrap file)
mongoose.connection.on("error", (error) => {
  logger.error({ err: error }, "MongoDB connection error");
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
});

const startServer = async () => {
  // Connect BEFORE binding to the port - a task should never report itself
  // as listening/ready if it can't reach its database. connectDatabase()
  // already process.exit(1)s on failure, so getting past this line means
  // the connection is good.
  await connectDatabase();

  const server = app.listen(config.PORT, () => {
    logger.info(
      `Server listening on port ${config.PORT} in ${config.NODE_ENV} environment`
    );
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);

    // Stop accepting new connections and wait for in-flight requests to
    // finish before closing the DB connection and exiting - avoids
    // dropping requests mid-response when ECS replaces this task.
    server.close(async (closeError) => {
      if (closeError) {
        logger.error({ err: closeError }, "Error while closing HTTP server");
      }

      try {
        await mongoose.connection.close();
      } catch (dbCloseError) {
        logger.error(
          { err: dbCloseError },
          "Error while closing MongoDB connection"
        );
      }

      logger.info("Shutdown complete");
      process.exit(closeError ? 1 : 0);
    });

    // Belt-and-suspenders: force-exit if graceful shutdown hangs (e.g. a
    // connection that never drains) rather than leaving the process stuck
    // past the orchestrator's grace period.
    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};
```

Two connection-lifecycle listeners (`error`, `disconnected`) are wired once, globally, at bootstrap — not per-query — and the `/health` endpoint reads `mongoose.connection.readyState` as an in-memory flag rather than issuing a round-trip ping, so an ALB health check reflects real connectivity without adding load. Full detail on the health-check route and the rest of the bootstrap sequence is in [`00-master-backend-architecture.md`](./00-master-backend-architecture.md).

### 3.2 Every transaction in the codebase

A grep for `startSession`/`startTransaction` across `backend/src` turns up exactly six real usages (plus their corresponding test-side mocks, which aren't counted here):

| # | Location | Protects |
|---|---|---|
| 1 | `backend/src/seeders/role.seeder.ts:12-51` | Clearing and re-inserting the fixed set of roles/permissions as one atomic reset |
| 2 | `backend/src/services/auth.service.ts:96-166` (`registerUserService`) | Creating User + Account + Workspace + Member, and setting the user's `currentWorkspace`, as one atomic unit |
| 3 | `backend/src/services/auth.service.ts:239-329` (`loginOrCreateAccountService`) | OAuth login-or-create: creating User + Workspace + Member + linking the OAuth Account together |
| 4 | `backend/src/services/user.service.ts:100-130` (`deleteAccountService`) | Unassigning the user's tasks and deleting Member/Account/Session/PasswordResetToken/EmailVerificationToken/User records together |
| 5 | `backend/src/services/workspace.service.ts:28-73` (`createWorkspaceService`) | Creating Workspace + Member and updating the user's `currentWorkspace` together |
| 6 | `backend/src/services/workspace.service.ts:285-347` (`deleteWorkspaceService`) | Deleting Project + Task + Member records, updating the deleting user's `currentWorkspace`, and deleting the Workspace itself, together |

Every one of these follows the identical `try { startTransaction(); ...; commitTransaction() } catch { abortTransaction(); throw } finally { endSession() }` shape. Here is each one in full.

**The role seeder** (a one-shot script, not request-driven, but it uses the same session machinery):

```ts
// backend/src/seeders/role.seeder.ts:1-52
import "dotenv/config";
import mongoose from "mongoose";
import connectDatabase from "../config/database.config";
import RoleModel from "../models/roles-permission.model";
import { RolePermissions } from "../utils/role-permission";

const seedRoles = async () => {
  console.log("Seeding roles started...");

  await connectDatabase();

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    console.log("Clearing existing roles...");
    await RoleModel.deleteMany({}, { session });

    for (const roleName in RolePermissions) {
      const role = roleName as keyof typeof RolePermissions;
      const permissions = RolePermissions[role];

      // Check if the role already exists
      const existingRole = await RoleModel.findOne({ name: role }).session(
        session
      );
      if (!existingRole) {
        const newRole = new RoleModel({
          name: role,
          permissions: permissions,
        });
        await newRole.save({ session });
        console.log(`Role ${role} added with permissions.`);
      } else {
        console.log(`Role ${role} already exists.`);
      }
    }

    await session.commitTransaction();
    console.log("Transaction committed.");
    console.log("Seeding completed successfully.");
  } catch (error) {
    // Without this the transaction stayed open on failure, holding locks
    // until the server timed it out. Same try/catch/finally shape as the
    // transactional services (see auth.service.ts / workspace.service.ts).
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
```

**User registration** — the most involved of the six, five documents across four collections written as one unit:

```ts
// backend/src/services/auth.service.ts:90-166 (registerUserService)
export const registerUserService = async (body: {
  email: string;
  name: string;
  password: string;
}) => {
  const { email, name, password } = body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const existingUser = await UserModel.findOne({ email }).session(session);
    if (existingUser) {
      throw new BadRequestException("Email already exists");
    }

    const user = new UserModel({ email, name, password });
    await user.save({ session });

    const account = new AccountModel({
      userId: user._id,
      provider: ProviderEnum.EMAIL,
      providerId: email,
    });
    await account.save({ session });

    const workspace = new WorkspaceModel({
      name: "My Workspace",
      description: `Workspace created for ${user.name}`,
      owner: user._id,
    });
    await workspace.save({ session });

    const ownerRole = await RoleModel.findOne({ name: Roles.OWNER }).session(
      session
    );
    if (!ownerRole) {
      throw new NotFoundException("Owner role not found");
    }

    const member = new MemberModel({
      userId: user._id,
      workspaceId: workspace._id,
      role: ownerRole._id,
      joinedAt: new Date(),
    });
    await member.save({ session });

    user.currentWorkspace = workspace._id as mongoose.Types.ObjectId;
    await user.save({ session });

    await session.commitTransaction();

    // Best-effort, outside the transaction (it already committed - the
    // account exists regardless of what happens here). A hiccup creating
    // the verification token or sending the email must NOT turn into a
    // registration failure; the user can always request a new one later.
    try {
      await requestEmailVerificationService(user._id.toString());
    } catch (verificationError) {
      logger.error(
        { err: verificationError },
        "Failed to send verification email during registration"
      );
    }

    return {
      userId: user._id,
      workspaceId: workspace._id,
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
```

**OAuth login-or-create** — the same shape, with a branch that skips the writes entirely when the user already exists:

```ts
// backend/src/services/auth.service.ts:226-329 (loginOrCreateAccountService)
export const loginOrCreateAccountService = async (data: {
  provider: string;
  displayName: string;
  providerId: string;
  picture?: string;
  email?: string;
  // Whether the IdP itself confirmed the user controls this email. Only
  // gates auto-linking to a PRE-EXISTING account (see below) - a brand new
  // account is always fine to create regardless.
  emailVerified?: boolean;
}) => {
  const { providerId, provider, displayName, email, picture, emailVerified } =
    data;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const account = await AccountModel.findOne({
      provider,
      providerId,
    }).session(session);

    let user;

    if (account) {
      user = await UserModel.findById(account.userId).session(session);
      if (!user) {
        throw new Error("Account exists but user not found");
      }
    } else {
      user = await UserModel.findOne({ email }).session(session);

      if (user) {
        // Auto-linking a new OAuth identity to a PRE-EXISTING account by
        // email match. Without the IdP confirming it verified this email,
        // we can't tell "this is genuinely the same person" from "someone
        // registered an OAuth app / IdP account using someone else's
        // email" - refuse rather than risk linking (and thus granting
        // login access) to the wrong account.
        if (!emailVerified) {
          throw new UnauthorizedException(
            "This email is already registered. Log in with your password, or verify this email with your provider first."
          );
        }
      }

      if (!user) {
        user = new UserModel({
          email,
          name: displayName,
          profilePicture: picture || null,
          // A brand new account, not a link to an existing one - safe to
          // trust the IdP's verification status directly since there's no
          // pre-existing identity being taken over.
          isEmailVerified: !!emailVerified,
        });
        await user.save({ session });

        const workspace = new WorkspaceModel({
          name: "My Workspace",
          description: `Workspace created for ${user.name}`,
          owner: user._id,
        });
        await workspace.save({ session });

        const ownerRole = await RoleModel.findOne({
          name: Roles.OWNER,
        }).session(session);
        if (!ownerRole) {
          throw new NotFoundException("Owner role not found");
        }

        const member = new MemberModel({
          userId: user._id,
          workspaceId: workspace._id,
          role: ownerRole._id,
          joinedAt: new Date(),
        });
        await member.save({ session });

        user.currentWorkspace = workspace._id as mongoose.Types.ObjectId;
        await user.save({ session });
      }
      // If user exists (email match), we don't create new workspace

      // NOW: Create the OAuth account link
      const newAccount = new AccountModel({
        userId: user._id,
        provider,
        providerId,
      });
      await newAccount.save({ session });
    }

    await session.commitTransaction();
    return { user };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
```

**Account deletion** — the widest fan-out of any transaction here (six collections), and the only one guarded by a pre-check performed *before* the session even opens:

```ts
// backend/src/services/user.service.ts:59-130 (deleteAccountService, in full)
export const deleteAccountService = async (
  userId: string,
  password?: string
): Promise<void> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  // Require re-confirming the password before a destructive, irreversible
  // action - guards against a stolen/leaked access token being enough on
  // its own to delete the account. OAuth-only accounts have no password to
  // confirm, so being authenticated is the only bar for those.
  if (user.password) {
    if (!password) {
      throw new BadRequestException(
        "Password confirmation is required to delete your account"
      );
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw new UnauthorizedException("Incorrect password");
    }
  }

  // Deliberately blocked, not cascaded: a workspace can have other members
  // who'd lose it with no warning if we silently deleted every workspace
  // this user owns. Make them delete/transfer those explicitly first,
  // using the existing (permission-checked, transactional) workspace
  // deletion flow.
  const ownedWorkspaces = await WorkspaceModel.find({ owner: userId }).select(
    "name"
  );
  if (ownedWorkspaces.length > 0) {
    throw new BadRequestException(
      `Delete or transfer ownership of ${ownedWorkspaces.length} workspace(s) you own before deleting your account: ${ownedWorkspaces
        .map((w) => w.name)
        .join(", ")}`
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const memberships = await MemberModel.find({ userId }).session(session);
    const workspaceIds = memberships.map((m) => m.workspaceId);

    if (workspaceIds.length > 0) {
      // Unassign (don't delete) tasks in workspaces this user is just a
      // member of - the tasks themselves are still valid workspace history.
      await TaskModel.updateMany(
        { workspace: { $in: workspaceIds }, assignedTo: userId },
        { assignedTo: null }
      ).session(session);
    }

    await MemberModel.deleteMany({ userId }).session(session);
    await AccountModel.deleteMany({ userId }).session(session);
    await SessionModel.deleteMany({ userId }).session(session);
    await PasswordResetTokenModel.deleteMany({ userId }).session(session);
    await EmailVerificationTokenModel.deleteMany({ userId }).session(session);
    await UserModel.findByIdAndDelete(userId).session(session);

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
```

**Workspace creation** — the smallest of the six, three writes across three collections:

```ts
// backend/src/services/workspace.service.ts:19-73 (createWorkspaceService, in full)
export const createWorkspaceService = async (
  userId: string,
  body: {
    name: string;
    description?: string | undefined;
  }
) => {
  const { name, description } = body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await UserModel.findById(userId).session(session);
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const ownerRole = await RoleModel.findOne({ name: Roles.OWNER }).session(
      session
    );
    if (!ownerRole) {
      throw new NotFoundException("Owner role not found");
    }

    const workspace = new WorkspaceModel({
      name: name,
      description: description,
      owner: user._id,
    });
    await workspace.save({ session });

    const member = new MemberModel({
      userId: user._id,
      workspaceId: workspace._id,
      role: ownerRole._id,
      joinedAt: new Date(),
    });
    await member.save({ session });

    user.currentWorkspace = workspace._id as mongoose.Types.ObjectId;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      workspace,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};
```

Note this one calls `session.endSession()` in both the success path and the `catch` block, rather than a shared `finally` — functionally equivalent to the `finally`-based shape used everywhere else, just spelled differently.

**Workspace deletion** — the inverse of creation, tearing down every dependent collection plus fixing up the deleting user's `currentWorkspace` if it pointed at the workspace being removed:

```ts
// backend/src/services/workspace.service.ts:285-347 (deleteWorkspaceService, in full)
export const deleteWorkspaceService = async (
  workspaceId: string,
  userId: string
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const workspace =
      await WorkspaceModel.findById(workspaceId).session(session);
    if (!workspace) {
      throw new NotFoundException("Workspace not found");
    }

    // Check if the user owns the workspace
    if (!workspace.owner.equals(new mongoose.Types.ObjectId(userId))) {
      throw new ForbiddenException(
        "You are not authorized to delete this workspace"
      );
    }

    const user = await UserModel.findById(userId).session(session);
    if (!user) {
      throw new NotFoundException("User not found");
    }

    await ProjectModel.deleteMany({ workspace: workspace._id }).session(
      session
    );
    await TaskModel.deleteMany({ workspace: workspace._id }).session(session);

    await MemberModel.deleteMany({
      workspaceId: workspace._id,
    }).session(session);

    // Update the user's currentWorkspace if it matches the deleted workspace
    if (user?.currentWorkspace?.equals(workspaceId)) {
      const memberWorkspace = await MemberModel.findOne({ userId }).session(
        session
      );
      // Update the user's currentWorkspace
      user.currentWorkspace = memberWorkspace
        ? memberWorkspace.workspaceId
        : null;

      await user.save({ session });
    }

    await workspace.deleteOne({ session });

    await session.commitTransaction();

    session.endSession();

    return {
      currentWorkspace: user.currentWorkspace,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};
```

### 3.3 Everything else: single-document writes, no session

For contrast, project and task creation — by far the most frequent writes in the app — never touch a session at all, because each is a single document going into a single collection:

```ts
// backend/src/services/project.service.ts:7-27
export const createProjectService = async (
  userId: string,
  workspaceId: string,
  body: {
    emoji?: string;
    name: string;
    description?: string;
  }
) => {
  const project = new ProjectModel({
    ...(body.emoji && { emoji: body.emoji }),
    name: body.name,
    description: body.description,
    workspace: workspaceId,
    createdBy: userId,
  });

  await project.save();

  return { project };
};
```

```ts
// backend/src/services/task.service.ts:34-75 (createTaskService, excerpted)
export const createTaskService = async (
  workspaceId: string,
  projectId: string,
  userId: string,
  body: {
    title: string;
    description?: string;
    priority: string;
    status: string;
    assignedTo?: string | null;
    dueDate?: string;
  }
) => {
  const { title, description, priority, status, assignedTo, dueDate } = body;

  const project = await ProjectModel.findById(projectId);

  if (!project || project.workspace.toString() !== workspaceId.toString()) {
    throw new NotFoundException(
      "Project not found or does not belong to this workspace"
    );
  }

  if (assignedTo) {
    await assertAssigneeIsWorkspaceMember(workspaceId, assignedTo);
  }
  const task = new TaskModel({
    title,
    description,
    priority: priority || TaskPriorityEnum.MEDIUM,
    status: status || TaskStatusEnum.TODO,
    assignedTo,
    createdBy: userId,
    workspace: workspaceId,
    project: projectId,
    dueDate,
  });

  await task.save();

  return { task };
};
```

Both do a *read* first (to validate the parent project exists and belongs to the right workspace) and then a single `.save()` — the read is not part of any atomicity guarantee, it's just a validation step, and the actual write is exactly one document.

### 3.4 The Mongo-backed rate limiter — a distinct query pattern

Rate limiting is a query pattern worth calling out on its own: it isn't a Mongoose model at all, but a raw collection used as a shared counter store so every ECS task enforces the same limit against the same numbers, instead of each task keeping its own in-memory count:

```ts
// backend/src/utils/rate-limiter.ts:1-79
import rateLimit, {
  type LegacyStore,
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import MongoStore from "rate-limit-mongo";
import { config } from "../config/app.config";
import { logger } from "./logger";

// express-rate-limit's default store lives in the process's own memory. With
// N ECS tasks behind the ALB that makes every limit effectively N times
// looser than it reads (a 5-attempts-per-15-minutes login limit becomes
// 5 x N), and every deploy or task replacement resets all counters to zero.
// Backing the counters with Mongo - already a dependency, so no new
// infrastructure - makes them cluster-wide and survive task churn.
//
// One store instance is shared by every limiter, so there is exactly one
// extra Mongo connection per task rather than one per limiter. Each limiter
// namespaces its own keys (see `withKeyPrefix`), so sharing the collection
// does NOT merge their budgets.
const RATE_LIMIT_COLLECTION = "rateLimits";

// All limiters in this codebase use the same 15-minute window, which is what
// lets them share one store (the store's TTL is a per-instance setting).
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

let sharedStore: MongoStore | undefined;

const getSharedStore = (): MongoStore | undefined => {
  // No MONGO_URI means local dev or the test suite, neither of which has a
  // cluster to coordinate through. Fall back to express-rate-limit's own
  // in-memory store - still rate limited, just per-process.
  if (!config.MONGO_URI) {
    return undefined;
  }

  if (!sharedStore) {
    sharedStore = new MongoStore({
      uri: config.MONGO_URI,
      collectionName: RATE_LIMIT_COLLECTION,
      expireTimeMs: RATE_LIMIT_WINDOW_MS,
      errorHandler: (error) =>
        logger.error({ err: error }, "Rate limit store error"),
    });
  }

  return sharedStore;
};

// express-rate-limit passes the store nothing but the client key (the IP, by
// default), so two limiters sharing a collection would otherwise share a
// counter. Prefixing per limiter keeps each budget independent.
const withKeyPrefix = (store: MongoStore, prefix: string): LegacyStore => ({
  incr: (key, callback) => store.incr(`${prefix}:${key}`, callback),
  decrement: (key) => store.decrement(`${prefix}:${key}`),
  resetKey: (key) => store.resetKey(`${prefix}:${key}`),
});

/**
 * Builds a rate limiter whose counters are shared across every running
 * instance of the app.
 *
 * @param name - Namespace for this limiter's counters. Must be unique per
 *   limiter, or two limiters will spend each other's budget.
 */
export const createRateLimiter = (
  name: string,
  options: Partial<Options>
): RateLimitRequestHandler => {
  const store = getSharedStore();

  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    ...(store ? { store: withKeyPrefix(store, name) } : {}),
  });
};
```

This bypasses Mongoose entirely — `rate-limit-mongo` opens its own connection directly to the same `MONGO_URI` and manages the `rateLimits` collection itself (increment-and-read counters with a TTL, not a Mongoose schema). It's the one place in the backend where a query goes straight to the MongoDB driver layer rather than through a Mongoose model, and it exists specifically because the semantics needed (atomic increment-and-check, shared across processes, self-expiring) map onto a raw counter document better than onto an ODM-validated schema.

### 3.5 Reading inside a session, without a transaction: `authenticate`

Not every multi-query read needs a transaction — reads don't need atomicity the way multi-document writes do, since nothing is being mutated. The `authenticate` middleware is the clearest example of a data-access pattern that queries two collections in sequence with no session at all, because there's nothing to roll back if the second query comes back empty:

```ts
// backend/src/middlewares/auth.middleware.ts:1-57 (reused from Architecture.md §3.2 — same source, discussed here for its query pattern rather than its auth semantics)
import { Request, Response, NextFunction } from "express";
import {
  extractBearerToken,
  verifyAccessTokenAndGetPayload,
} from "../utils/jwt";
import { UnauthorizedException } from "../utils/appError";
import UserModel from "../models/user.model";
import SessionModel from "../models/session.model";

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      throw new UnauthorizedException("Token not found");
    }

    const payload = verifyAccessTokenAndGetPayload(token);

    const user = await UserModel.findById(payload.userId);

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (!user.isActive) {
      throw new UnauthorizedException("User is not active");
    }

    const session = await SessionModel.findById(payload.sessionId);

    if (!session) {
      throw new UnauthorizedException("Session not found");
    }
    if (!session.isValid) {
      throw new UnauthorizedException("Session has been revoked");
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Session has expired");
    }

    if (session.userId.toString() != user._id.toString()) {
      throw new UnauthorizedException("Invalid Session");
    }
    req.user = user;
    req.session = session;

    next();
  } catch (error) {
    next(error);
  }
};
```

Two sequential `findById` calls, each a fresh round trip, both indexed lookups by `_id` (Mongo's default primary-key index), running on *every single authenticated request* in the app. This is deliberately not batched into one query (e.g. via `$lookup`/populate) because the two checks are genuinely independent failure conditions with distinct error messages — but it's worth noticing as a query-volume cost: every protected route pays two extra round trips before the actual business logic runs.

### 3.6 Test-database strategy

The test suite doesn't mock Mongoose — it runs against a real, ephemeral MongoDB instance spun up per test run:

```ts
// backend/tests/setup/vitest.setup.ts:1-50 (in full)
import { beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";

let mongod: MongoMemoryReplSet;

// Tracks which models we've already forced into existence, so we don't
// redo this work before every single test - just the first time each
// model shows up.
const initializedModels = new Set<string>();

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});

// NEW: runs before every test. By the time THIS fires, the test file's own
// top-level imports (which register models like RoleModel, UserModel, etc.
// via `mongoose.model(...)`) have already executed - so mongoose.modelNames()
// is populated here, unlike in beforeAll above, which runs before the test
// file's imports resolve.
//
// `.init()` explicitly creates the collection and builds its indexes RIGHT
// NOW, as a plain (non-transactional) operation. That's the whole fix: it
// guarantees "does this collection exist" is already answered before any
// transaction gets anywhere near it, so the transaction never hits the
// implicit-creation-triggers-a-lock-wait path that was failing.
beforeEach(async () => {
  const pending = mongoose
    .modelNames()
    .filter((name) => !initializedModels.has(name));
  await Promise.all(
    pending.map(async (name) => {
      await mongoose.model(name).init();
      initializedModels.add(name);
    })
  );
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
```

The choice of `MongoMemoryReplSet` over the simpler `MongoMemoryServer` is not incidental — it's load-bearing. `mongoose.startSession()`/`startTransaction()` **requires a replica set or sharded cluster**; a standalone `mongod` (what `MongoMemoryServer` boots) physically cannot run a multi-document transaction. Since six real services in this codebase use transactions, a test double that couldn't support them would leave the most failure-prone code paths in the app (the atomic multi-collection writes) completely untested. `{ replSet: { count: 1 } }` is the minimum replica-set topology — one node — that still gets you real transaction support without paying for a multi-node cluster in every test run.

The `beforeEach` model-initialization step exists to work around a specific, real failure mode: MongoDB implicitly creates a collection the first time it's written to, but that implicit creation is itself an operation that can conflict with an in-flight transaction trying to write to the same not-yet-existent collection. Forcing every registered model's collection (and its indexes) to exist *before* any test body runs — as a plain, non-transactional `.init()` call — sidesteps that race entirely. `afterEach` wipes every collection's documents (not the collections/indexes themselves) between tests for isolation, and `afterAll` tears the in-memory replica set down.

---

## 4. Request/Data Flow — tracing `registerUserService`

Walking `registerUserService` end to end, tying the trace back to the exact code in §3.2:

1. **`const session = await mongoose.startSession();`** — a session object is created and bound to the current Mongoose connection. No transaction has started yet; this just reserves a logical "conversation" with the server that subsequent operations can be attached to via `.session(session)`.
2. **`session.startTransaction();`** — inside the `try` block, the transaction actually begins. From this point, every read against this session sees a consistent snapshot, and every write is provisional until commit.
3. **`UserModel.findOne({ email }).session(session)`** — the duplicate-email check runs *inside* the transaction's snapshot, so a race where two requests try to register the same email concurrently is caught consistently rather than racing against an uncommitted write from the other request.
4. **Four sequential writes, each explicitly passed the session**: `user.save({ session })`, `account.save({ session })`, `workspace.save({ session })`, `member.save({ session })`, and a final `user.save({ session })` to persist `currentWorkspace` once the workspace's `_id` is known. Between the writes, one more session-scoped read: `RoleModel.findOne({ name: Roles.OWNER }).session(session)`, to find the role to assign the new member — if this comes back empty, a `NotFoundException` is thrown immediately, before any further writes happen.
5. **`await session.commitTransaction();`** — if every write above succeeded, the transaction is committed as a single atomic unit. Either all five documents (new User, Account, Workspace, Member, and the User's `currentWorkspace` update) are durably visible, or — if this line is never reached — none of them are.
6. **After commit, outside the transaction entirely**: `requestEmailVerificationService(...)` runs in its own nested `try/catch`, deliberately *not* part of the transaction. The comment in the source is explicit about why: the registration has already committed by this point, so a failure sending the verification email must not be allowed to look like a registration failure — it's logged and swallowed, not rethrown.
7. **The `catch` block**: `await session.abortTransaction(); throw error;`. This is unconditional — any thrown error inside the `try` (the duplicate-email check, a missing owner role, a Mongoose validation failure on any of the four `.save()` calls) reaches this same branch, aborts the transaction explicitly, and rethrows the original error so the caller (the auth controller, then `asyncHandler`, then the global `errorHandler`) still sees the real failure reason.
8. **The `finally` block**: `session.endSession();` runs regardless of whether the transaction committed or aborted — releasing the session back to the driver's session pool so it doesn't leak across requests.

To answer the question plainly: **yes, `abortTransaction()` is called explicitly** in every one of the six transactional functions in this codebase — there is no code path here relying on an implicit abort-on-uncaught-exception or an abort triggered only by session cleanup. The `catch` block is unconditional and always present.

---

## 5. Design Decisions & Tradeoffs

**The criterion for "does this need a transaction" is observable directly from the six cases above: a transaction is used exactly when a single logical operation writes to more than one collection, and a partial completion would leave referentially-inconsistent data behind.** Checking each one against that rule:

- `registerUserService` — a User with no Account means the user can never log in with the credentials they just set; a Workspace with no Member means nobody owns it. Four collections, genuinely coupled.
- `loginOrCreateAccountService` — same coupling as registration, on the "new user via OAuth" branch; the "existing user" branch still opens a transaction even though it ends up writing to only one collection (a new `AccountModel`), because which branch will run isn't known until the session is already open.
- `deleteAccountService` — deleting the User but leaving orphaned Session/Account/Member rows pointing at a now-nonexistent user would corrupt every one of those collections' referential assumptions.
- `createWorkspaceService` / `deleteWorkspaceService` — a Workspace with no owning Member (create) or a Workspace deleted while its Projects/Tasks/Members survive (delete) are both broken states.
- `role.seeder.ts` — clearing and re-inserting the entire role set is only safe as one unit; a script interrupted halfway would leave the app with some roles missing entirely, which breaks every permission check that relies on `RoleModel.findOne({ name })` returning a result.

The rule holds without exception across every transactional case found. Conversely, `createProjectService` and `createTaskService` (§3.3) write to exactly one collection each — Mongo's built-in per-document atomicity is already the strongest guarantee that operation needs, so wrapping it in a session would only add latency and lock overhead for zero additional safety.

**Bounded connection pool over the driver default.** The Mongo driver's own default (`maxPoolSize: 100`) is sized for "one process, one database, nothing else sharing the connection budget" — exactly wrong for a horizontally-scaled ECS service where every task independently opens its own pool against the same Atlas cluster. Explicitly capping at 15 (with a floor of 2 warm connections) is a deliberate trade of per-task query concurrency for cluster-wide connection safety — see §7 for whether that specific number holds up as a 2026 best practice.

**No repository layer — what's given up.** Query logic that would live once behind a `WorkspaceRepository.findByOwner()` in a repository-pattern codebase is instead duplicated per call site: `WorkspaceModel.findById(workspaceId)` with a not-found check appears near-verbatim in `getWorkspaceByIdService`, `changeMemberRoleService`, `removeMemberFromWorkspaceService`, `resetWorkspaceInviteCodeService`, `updateWorkspaceByIdService`, and `deleteWorkspaceService` — six independent copies of the same lookup-and-guard. What's bought in exchange is the absence of an abstraction layer that would need its own tests and its own maintenance burden, for a benefit (swapping out Mongoose for a different persistence technology) that isn't actually on AstriX's roadmap. This is a reasonable trade for a single-database, single-team codebase at this size — the calculus would flip if the query-logic duplication above ever caused a real bug (two of the six copies drifting out of sync on what "not found" means, for instance).

---

## 6. Security Considerations

**`MONGO_URI` and log exposure.** The connection string is read once, in `app.config.ts:22`, and used in exactly two places in the source: `mongoose.connect(config.MONGO_URI, ...)` in `database.config.ts:7`, and `new MongoStore({ uri: config.MONGO_URI, ... })` in `rate-limiter.ts:39`. Nothing in the codebase ever logs `config.MONGO_URI` directly, and nothing dumps the full `config` object to a log line. The real exposure risk is indirect: `database.config.ts`'s `catch` block logs `{ err: error }` on a failed connection attempt, and the global `errorHandler` logs `{ err: error, path: req.path }` on every failed request. Whether a MongoDB connection-error object's `.message` embeds the connection string (with or without credentials) is a property of the underlying `mongodb` driver's error formatting, not of this application's code — modern driver versions redact credentials from error messages by default, but that's an assumption resting on the driver's behavior, not something this codebase tests or asserts on its own. This is worth treating as a gap to verify explicitly (e.g. a test that forces a connection failure and asserts the logged error never contains the password segment of the URI) rather than something safe to assume indefinitely.

**Partial-transaction-failure reliability.** As shown in §4, all six transactional functions call `abortTransaction()` unconditionally in their `catch` block, so an error thrown by *any* operation inside the transaction — a validation failure, a duplicate-key error, a thrown `NotFoundException` — reliably triggers an explicit abort before the error propagates. What's *not* exercised anywhere in this codebase, and is worth calling out honestly rather than assuming away, is the abort call itself failing (for instance, a network partition between the app and Mongo occurring between the triggering error and the `abortTransaction()` call). Mongoose/MongoDB transactions are designed so that a session tied to a lost connection eventually times out and is cleaned up server-side even if the client's own `abortTransaction()` never completes — but that server-side safety net is a property of MongoDB's session-timeout behavior, not something this codebase has its own test coverage for.

**Data-integrity gap in non-transactional multi-write flows.** Not every multi-step write in the codebase is wrapped in a transaction — only the six listed in §3.2 are. `removeMemberFromWorkspaceService` (`workspace.service.ts:204-245`) is a concrete counter-example: it runs a `MemberModel.findOneAndDelete(...)`, then a `TaskModel.updateMany(...)` to unassign that member's tasks, then conditionally a `UserModel.findById` + `.save()` to fix up `currentWorkspace` — three independent, non-transactional writes. If the `TaskModel.updateMany` call throws after the member document has already been deleted, the member is gone but their tasks stay assigned to a user who's no longer in the workspace — a real, currently-unprotected partial-completion state. This isn't a case where a rollback happens and this doc is claiming otherwise; the opposite is true: there genuinely is no rollback here, because there's no session in this function at all. It's flagged because it's the kind of case the criterion in §5 (multiple collections, one logical operation) would suggest belongs in a transaction, but doesn't currently have one — a real, verifiable gap, not a hypothetical.

**Resource exhaustion from unbounded `.find()` calls.** A grep across every service for `.find(` (excluding `findById`/`findOne`-family calls, which return at most one document by construction) turns up several queries with no `.limit()`: `SessionModel.find({ userId, isValid: true, ... })` in `getUserSessionsService` (a user's active-device list), `MemberModel.find({ userId })` in `getAllWorkspacesUserIsMemberService` and again in `deleteAccountService`, `MemberModel.find({ workspaceId })` in `getWorkspaceByIdService` and `getWorkspaceMembersService`, `WorkspaceModel.find({ owner: userId })` in `deleteAccountService`, and `RoleModel.find({})` in `getWorkspaceMembersService`. None of these are currently paginated. In practice, most are bounded by realistic real-world cardinality (a role set fixed by the app's own enum, a user's own workspace memberships), but `MemberModel.find({ workspaceId })` — the full member list of a single workspace — has no enforced ceiling at all: a workspace that grows to thousands of members would return every one of them in a single unpaginated response. This is a genuine, currently-unmitigated latent risk rather than an active incident, since AstriX's actual usage pattern (small team workspaces) keeps the numbers low today — but it's a gap worth flagging plainly rather than assuming away as "fine because nobody's hit it yet."

---

## 7. Best Practice Check

**Connection pooling.** AstriX's explicit `maxPoolSize: 15` / `minPoolSize: 2`, reasoned about directly against "N ECS tasks × pool size must stay under Atlas's total connection ceiling," is exactly the 2026 industry-standard shape for pooling in a containerized, horizontally-scaled Node service: never inherit the driver's single-process default, size the pool as (total connection budget) ÷ (expected replica count), and keep a small warm floor to avoid cold-connection latency on scale-out. This matches current practice cleanly — the one thing worth periodically re-checking (not a code gap, an operational one) is that `MONGO_MAX_POOL_SIZE × <current ECS task count>` still comfortably clears whatever the live Atlas tier's actual connection ceiling is, since that ceiling can change independently of this code if the Atlas tier is ever resized.

**Transaction-usage discipline.** Using ACID transactions only for the six genuinely multi-collection writes identified in §3.2/§5, and leaving every single-document write (the overwhelming majority of the app's write volume — project creation, task creation, task updates, role changes) on plain per-document atomicity, is current (2026) best practice, not a dated compromise. Transactions in MongoDB carry real cost — held locks for the transaction's duration, extra round trips for `startTransaction`/`commitTransaction`, and (for `MongoMemoryReplSet` in tests, see §3.6) even the topology requirement of a replica set — so reaching for one only where atomicity genuinely spans documents, rather than wrapping every write "just in case," is the currently-recommended posture, and AstriX's actual usage matches it precisely.

**Query-level performance.** Mixed. Field projection (`.select(...)`) is used in several places where it matters — `getCurrentUserService`'s `.select("-password")`, `getProjectByIdAndWorkspaceIdService`'s `.select("_id emoji name")` — which is good practice. `.lean()`, on the other hand, appears exactly once in the entire services layer (`getWorkspaceMembersService`'s roles lookup, `RoleModel.find({}, { name: 1, _id: 1 }).select("-permission").lean()`). Every other read-only query — including ones that populate related documents and return them straight to an HTTP response without ever saving them back — returns full hydrated Mongoose documents, paying the ODM's document-wrapping cost for data that's only ever serialized to JSON. In 2026, the common recommendation for Mongoose-based services is to default to `.lean()` on any query whose result is read-only (never `.save()`d), reserving hydrated documents for the genuinely small set of reads that go on to be mutated in place — AstriX's current pattern (hydrated by default, `.lean()` as a rare exception) is the inverse of that, and is a real, low-risk-to-fix gap rather than a structural one. On indexing: this file doesn't re-derive the full index inventory — that's [`07-database-schema-design.md`](./07-database-schema-design.md)'s job, and it hadn't been written yet as of this pass, so cross-reference it there directly. What's observable from the query patterns covered here is that the indexes backing the *transactional* and *authentication* hot paths line up with how those collections are actually queried — `SessionModel` carries both a `userId` index and a compound `{ userId: 1, isValid: 1 }` index matching exactly the shape of the `authenticate` middleware's lookup, and `TaskModel` carries `{ workspace: 1, project: 1 }` and `{ workspace: 1, status: 1 }` compound indexes matching the filter shapes used in `getAllTasksService`. None of the unpaginated `.find()` calls flagged in §6, by contrast, have a corresponding index specifically sized around "keep this fast at high document counts" — because until §6's gap is fixed with an actual `.limit()`, there isn't a page size for an index to serve efficiently.

---

## 8. Debug Drill

**Scenario 1 — "connection-pool-exhausted" errors under load, in a generic Mongoose/MongoDB-backed Node service.** Where to look first, and why:

1. **Count the actual concurrent connection demand.** Multiply the configured `maxPoolSize` by the number of running application replicas, and compare that against the database's actual connection ceiling for its current tier. A pool-exhaustion error under load is very often just this arithmetic not holding anymore — a replica count that scaled up, or a database tier that got downsized, without anyone revisiting the pool-size constant.
2. **Look for connections held longer than expected**, not just more of them. A slow, unindexed query holds its connection for the query's full duration; a burst of those under load can starve the pool even without a raw connection-count problem. Check for missing indexes on whatever query pattern spiked traffic.
3. **Look for sessions or cursors that never get released.** A `mongoose.startSession()` without a `finally { session.endSession() }` (or a change stream/cursor left open) leaks a connection out of the pool permanently until the process restarts. Audit every `startSession()` call site for exactly this shape.
4. **Check whether load is actually load, or a retry storm.** A client-side timeout that's shorter than the server's actual response time under load causes retries that add more concurrent connection demand on top of the load that caused the slowdown in the first place — a self-reinforcing spiral that looks like "the pool is too small" but is really "the pool is being asked to serve N+retries requests instead of N."

**Scenario 2 — a multi-step operation partially completed instead of cleanly rolling back.** Where to look first, and why:

1. **Find the function and check whether it actually opens a session at all.** The single most common cause of "partial completion" in a Mongoose codebase isn't a broken transaction — it's the absence of one. Grep the function for `startSession`/`.session(...)`; if it isn't there, every write inside it is independently committed the moment it runs, and there is nothing to roll back by design.
2. **If a session is present, check that every write in the function actually passes it.** A single `.save()` or `.updateMany()` missing its `.session(session)` argument is invisible to the transaction — it commits immediately regardless of whether the surrounding transaction later aborts, which produces exactly the "partially completed" symptom even though a transaction is technically in use.
3. **Check the `catch` block calls `abortTransaction()` unconditionally**, not just on specific error types — a `catch` that only aborts for certain error subclasses leaves the transaction open (and its provisional writes uncommitted-but-unreleased) for anything else that throws.
4. **Confirm `endSession()` runs in every exit path**, success and failure alike — normally via `finally`. A session that's never ended doesn't cause data corruption on its own, but it does leak a server-side session resource, and under sustained load that leak can itself become the pool-exhaustion problem from Scenario 1.
