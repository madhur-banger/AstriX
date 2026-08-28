# AstriX Backend Mastery - Complete Guide
## From Mental Model to Production Debugging

This is the definitive guide to understanding, building, debugging, and extending the AstriX backend. It consolidates everything: mental models, complete request traces, real debugging scenarios, and production patterns — all with TypeScript annotations.

---

# PART 1: QUICK REFERENCE & MENTAL MODEL

## The Backend Pipeline (Memorize This)

Every backend, in any language, follows this exact pipeline:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. TRANSPORT              TCP connection, TLS, HTTP parsing   │
│ 2. MIDDLEWARE CHAIN       Security headers, body parsing,     │
│                           cookies, CORS, rate limiting        │
│ 3. AUTHENTICATION         "who are you?" → req.user set       │
│ 4. ROUTER                 match HTTP verb + path              │
│ 5. CONTROLLER             "traffic cop": parse, validate      │
│ 6. AUTHORIZATION          "are you allowed?" RBAC check       │
│ 7. SERVICE LAYER          business rules + orchestration      │
│ 8. DATA ACCESS            ORM/ODM → database queries          │
│ 9. DATABASE               read/write actual data              │
│ 10. RESPONSE FORMATTING   controller shapes HTTP response     │
│ 11. ERROR PATH            any throw() → centralized handler   │
└──────────────────────────────────────────────────────────────┘
```

**Key insight:** You understand a backend when you can trace a single request through this pipeline, naming what happens at each step, without looking at code.

---

## The Core Distinction: Authentication vs Authorization

These are NOT the same thing, and conflating them is the #1 cause of security bugs:

```
AUTHENTICATION                    AUTHORIZATION
"who are you?"                    "are you allowed?"
────────────────                  ──────────────────
Happens ONCE per request          Happens PER-ENDPOINT
At the middleware layer           Inside the controller
via JWT verification              via roleGuard()
─────────────────────────────────────────────────────
Sets req.user                     Re-fetches user's role
(or blocks request entirely)      Per workspace (DB call)
                                  Checks role ⊆ permission (in-memory)
```

**In AstriX specifically:**
- **Authentication:** `passportAuthenticateJWT` (index.ts line 106)
- **Authorization Part 1:** `getMemberRoleInWorkspace()` (services/member.service.ts)
- **Authorization Part 2:** `roleGuard()` (utils/roleGuard.ts)

Once you see this split clearly, every controller reads the same way:

```ts
// Always: 1) Who am I? 2) Can I do this here?
const userId = req.user?._id;  // ← authenticated by middleware, guaranteed to exist
const { role } = await getMemberRoleInWorkspace(userId, workspaceId); // ← fresh from DB
roleGuard(role, [Permissions.CREATE_TASK]); // ← in-memory rule check
// Now do the thing
```

---

## Questions to Ask of Any Backend File

When you open an unfamiliar file and don't know what it does, ask these seven questions in order:

1. **What layer is this?** (folder name hints: routes/ = router, controllers/ = controller, services/ = service, models/ = data, middleware/ = middleware)
2. **What has already run by the time this code executes?** (is it behind `passportAuthenticateJWT`? behind Zod validation? behind role checks?)
3. **What does it assume about its inputs?** (a controller assumes `req.body` is raw and needs validation; a service assumes its caller already validated the shape)
4. **What does it throw, and where does that go?** (every throw reaches the centralized error handler — trace it)
5. **What does it write to the database, and what does it verify first?** (guard clauses come before mutations)
6. **Does this function's name tell the truth?** (is `changeMemberRoleService` actually protecting every invariant its name implies?)
7. **If I called this twice with the same input, what happens?** (idempotency — matters for retries/webhooks/queues)

---

## Database Call Summary for CREATE TASK Endpoint

| # | Operation | Layer | Queries DB? | Purpose |
|---|-----------|-------|-----------|---------|
| 1 | JWT verify + user lookup | Middleware | ✅ (UserModel) | "Who is this?" |
| 2 | Session validation | Middleware | ✅ (SessionModel) | "Is their login still valid?" |
| 3 | Zod validation | Controller | ❌ | "Is the input well-formed?" |
| 4 | Workspace lookup | Controller (auth service) | ✅ (WorkspaceModel) | "Does this workspace exist?" |
| 5 | Member + role lookup | Controller (auth service) | ✅ (MemberModel, populated) | "Are you in this workspace, and what's your role?" |
| 6 | Permission check | Controller | ❌ (in-memory table) | "Does that role have this permission?" |
| 7 | Project validation | Service | ✅ (ProjectModel) | "Does this project exist and belong here?" |
| 8 | Assignee member check | Service | ✅ (MemberModel) | "Is the person we're assigning to actually a member?" |
| 9 | Task insert | Service | ✅ (TaskModel write) | "Actually create the task" |

**Total: 7 database round trips for creating one task.** This is normal for a multi-tenant RBAC system, but it's exactly what to examine when performance is slow.

---

## Error Responses by Layer

Know where each error comes from, and what it maps to:

| Error | Layer | Status | Reason |
|-------|-------|--------|--------|
| No JWT token | Middleware (Passport) | 401 Unauthorized | Request never reaches controller |
| Invalid JWT signature | Middleware (Passport) | 401 Unauthorized | Ditto |
| Token expired | Middleware (Passport) | 401 Unauthorized | Ditto |
| Session revoked | Middleware (Passport) | 401 Unauthorized | Token still valid, but server-side revocation |
| Invalid JSON body | Middleware (express.json) | 400 Bad Request | Body can't be parsed |
| Zod validation fails | Controller | 400 Bad Request | Input shape/values invalid |
| User not in workspace | Controller (auth service) | 403 Forbidden | No `Member` record linking them |
| Permission denied | Controller (roleGuard) | 403 Forbidden | Role exists but doesn't have this action |
| Project not found | Service | 404 Not Found | Project ID bad or doesn't exist |
| Project wrong workspace | Service | 404 Not Found | Project exists but belongs elsewhere |
| Assignee not member | Service | 400 Bad Request | Can't assign to someone outside workspace |
| DB constraint violated | Service | 409 Conflict (or 500) | Unique key collision, FK violation, etc. |
| Unhandled exception | Error handler | 500 Internal Error | Bug in the code or something truly unexpected |

---

## Code Location Reference

**Middleware & Bootstrap**
- `index.ts:26-136` — App setup, middleware stack order, route mounting
- `index.ts:44-79` — middleware chain (helmet, json, cors, passport, etc.)
- `index.ts:103-110` — route mount points with auth gates

**Authentication & Sessions**
- `config/passport.config.ts:79-130` — JWT strategy definition
- `utils/jwt.ts` — token signing/verification
- `services/auth.service.ts` — login, verify password, create sessions

**Authorization**
- `services/member.service.ts:10-32` — fetch user's workspace role
- `utils/roleGuard.ts` — check role ⊆ required permissions
- `enums/role.enum.ts` — permission matrix definition

**Request Flow (CREATE TASK example)**
- `routes/task.route.ts:7-10` — route definition
- `controllers/task.controller.ts:13-36` — controller entry point
- `services/task.service.ts:8-56` — business logic & DB calls
- `models/task.model.ts` — schema definition with defaults

**Validation**
- `validation/task.validation.ts` — Zod schemas (request body + params)
- `middlewares/asyncHandler.middleware.ts` — try/catch wrapper for controllers

**Error Handling**
- `middlewares/errorHandles.middleware.ts:19-48` — centralized error handler
- `utils/appError.ts` — custom error class hierarchy

---

# PART 2: COMPLETE REQUEST TRACE

## Tracing `POST /api/task/project/proj_123/workspace/ws_456/create`

This is the anatomy of a real request, layer by layer, variable by variable.

### 0. The Request Arrives

```http
POST /api/task/project/proj_123/workspace/ws_456/create HTTP/1.1
Host: localhost:5000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyXzEyMyIsInNlc3Npb25JZCI6InNlc3NfNDU2IiwiaWF0IjoxNjkzNDAxMjM0LCJleHAiOjE2OTM0MDQ4MzR9.signature
Content-Type: application/json
Cookie: refreshToken=abc123

{
  "title": "Fix login OAuth",
  "description": "Users can't log in via Google",
  "priority": "CRITICAL",
  "status": "TODO",
  "assignedTo": "user_789",
  "dueDate": "2026-08-30"
}
```

---

### 1. Middleware Stack (index.ts)

**Line 44: helmet()**
- Adds security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, etc.
- Happens on EVERY response, no data inspection

**Lines 50-51: express.json() + express.urlencoded()**
```ts
// TypeScript type signature (what actually happens internally):
// express.json(): (req: Request, res: Response, next: NextFunction) => void
app.use(express.json()); // Parses req.body as JSON, throws SyntaxError on invalid JSON
app.use(express.urlencoded({ extended: true })); // Also parses form data
```
- Reads the raw HTTP body bytes
- Parses JSON string → JavaScript object
- Attaches to `req.body`

**State after line 51:**
```ts
req.body = {
  title: "Fix login OAuth",
  description: "Users can't log in via Google",
  priority: "CRITICAL",
  status: "TODO",
  assignedTo: "user_789",
  dueDate: "2026-08-30"
};
```

**Line 64: cookieParser()**
```ts
// Parses Cookie header: "refreshToken=abc123" → req.cookies object
app.use(cookieParser()); // TypeScript: middleware that augments req.cookies
```

**State after line 64:**
```ts
req.cookies = {
  refreshToken: "abc123" // If client sent a cookie; otherwise empty object
};
```

**Lines 72-79: cors()**
```ts
// TypeScript type for CORS config:
interface CorsOptions {
  origin: string | string[] | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void);
  credentials: boolean; // CRITICAL: allows cookies cross-origin
  methods: string[];
  allowedHeaders: string[];
}

app.use(cors({
  origin: config.FRONTEND_ORIGIN, // "http://localhost:3000"
  credentials: true, // Allows req.cookies to be sent/read cross-origin
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
```

**Line 85: passport.initialize()**
```ts
// Initializes Passport.js globally, makes req.isAuthenticated(), req.user available
// Does NOT authenticate yet — just sets up the machinery
app.use(passport.initialize()); // TypeScript: middleware that augments req with passport methods
```

---

### 2. JWT Authentication Middleware (config/passport.config.ts)

Mounted at **index.ts line 106** on protected routes:

```ts
// TypeScript: This is what "passportAuthenticateJWT" actually is:
export const passportAuthenticateJWT = passport.authenticate("jwt", {
  session: false, // Don't use sessions, rely only on JWT + our custom session DB check
}); // Returns a middleware function
```

**JWT Strategy Registration** (lines 79-130 in passport.config.ts):

```ts
// First, the JWT verification happens INSIDE passport-jwt automatically:
// 1. Extract token from "Authorization: Bearer <token>"
const jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();

// 2. Verify signature using secret + algorithm
const jwtOptions: StrategyOptionsWithoutRequest = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: config.JWT.ACCESS_TOKEN_SECRET, // From .env
  audience: ["user"], // Optional: token must claim aud="user"
  algorithms: ["HS256"], // HMAC with SHA-256
};

// 3. If signature is valid, passport calls our callback with the DECODED payload
passport.use(
  new JwtStrategy(jwtOptions, async (payload: JwtPayload, done: VerifyCallback) => {
    // payload is now: { userId, sessionId, aud, iat, exp } — cryptographically verified
    // iat = issued-at timestamp, exp = expiration timestamp
    // If exp is in the past, passport-jwt throws before this callback even runs

    try {
      // Now the SECOND layer: is this session still valid server-side?
      const user = await findUserByIdService(payload.userId); // DB CALL #1
      // TypeScript: user is User | null
      if (!user) return done(null, false); // 401 — user was deleted

      const session = await SessionModel.findById(payload.sessionId); // DB CALL #2
      // TypeScript: session is SessionDocument | null
      if (!session || !session.isValid) return done(null, false); // 401 — session revoked or expired

      // Success: attach to request
      (user as any).sessionId = payload.sessionId; // Store for later use in controller
      return done(null, user); // Passport sets req.user = user, calls next()
    } catch (error) {
      return done(error, false); // 500 or 401 depending on error
    }
  })
);
```

**After JWT middleware succeeds:**

```ts
// req.user is now guaranteed to be:
req.user = {
  _id: ObjectId("user_123"), // Mongoose ObjectId type
  name: "John Developer",
  email: "john@example.com",
  profilePicture: "https://...",
  sessionId: "sess_456", // Attached by the strategy
  // ... other user fields
  // Note: password is NOT included (excluded by schema's select: false)
};
```

**If JWT middleware fails:**
- Request never reaches the controller
- Passport's default behavior: send 401 with `{ message: "Unauthorized" }`
- No chance for business logic to run

---

### 3. Route Matching (routes/task.route.ts)

```ts
// TypeScript: Router.post() signature
// router.post(path: string | RegExp, ...handlers: RequestHandler[]): Router
taskRoutes.post(
  "/project/:projectId/workspace/:workspaceId/create",
  // Route pattern: literal strings + named params (:projectId, :workspaceId)
  createTaskController // Request handler (will be wrapped in asyncHandler)
);
```

**For our request path:** `/project/proj_123/workspace/ws_456/create`

Express matches:
- `/project/` — literal match ✓
- `proj_123` → `:projectId` parameter ✓
- `/workspace/` — literal match ✓
- `ws_456` → `:workspaceId` parameter ✓
- `/create` — literal match ✓

**State after route match:**
```ts
// TypeScript: Express automatically populates req.params
req.params = {
  projectId: "proj_123", // Always a string, even if URL-encoded
  workspaceId: "ws_456"
};
```

---

### 4. Controller: Orchestration (controllers/task.controller.ts lines 13-36)

```ts
// TypeScript signature:
// Request: Express request (with user, body, params)
// Response: Express response (with status(), json())
// Both fully typed by @types/express
export const createTaskController = asyncHandler(
  async (req: Request, res: Response) => {
    // STEP A: Extract authenticated user's ID (guaranteed to exist by middleware)
    const userId = req.user?._id; // Optional chaining: req.user?.property
    // TypeScript: userId is ObjectId | undefined (but undefined shouldn't happen here due to middleware)

    // STEP B: Parse and validate the request body shape
    const body = createTaskSchema.parse(req.body);
    // createTaskSchema is a Zod object schema (see validation/task.validation.ts)
    // .parse() returns typed data or throws ZodError
    // TypeScript: body is now { title: string; description?: string; priority: TaskPriorityEnum; status: TaskStatusEnum; ... }

    // STEP C: Parse and validate URL parameters
    const projectId = projectIdSchema.parse(req.params.projectId);
    // projectIdSchema is z.string().trim().min(1)
    // projectId is string after Zod removes whitespace and validates length

    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    // workspaceId is string, validated

    // STEP D: Authorization layer 1 — fetch this user's role in this workspace
    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    // role is: "OWNER" | "ADMIN" | "MEMBER" | throws UnauthorizedException if not a member
    // DB CALL #3 (workspace lookup) + #4 (member + role lookup)

    // STEP E: Authorization layer 2 — check the role has this specific permission
    roleGuard(role, [Permissions.CREATE_TASK]);
    // Pure in-memory check: RolePermissions[role].includes(Permissions.CREATE_TASK)
    // Throws UnauthorizedException if permission missing, otherwise returns void (no-op)

    // STEP F: Delegate to service layer for actual business logic
    const { task } = await createTaskService(
      workspaceId, // "ws_456"
      projectId,   // "proj_123"
      userId,      // ObjectId("user_123")
      body         // { title, description, priority, status, assignedTo, dueDate }
    );
    // Returns { task: TaskDocument }
    // DB CALL #5, #6, #7 happen inside this service call

    // STEP G: Shape and send HTTP response
    return res.status(HTTPSTATUS.OK).json({
      message: "Task created successfully",
      task, // Mongoose automatically serializes ObjectIds to strings in JSON
    });
    // TypeScript: HTTPSTATUS.OK is 200 (number enum)
  }
);
```

---

### 5. Service Layer: Business Logic (services/task.service.ts lines 8-56)

```ts
// TypeScript: The service is a pure async function, knows nothing about HTTP
export const createTaskService = async (
  workspaceId: string, // "ws_456"
  projectId: string,   // "proj_123"
  userId: ObjectId,    // ObjectId("user_123")
  body: {
    // Zod has already validated this shape
    title: string;
    description?: string;
    priority: TaskPriorityEnum; // "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
    status: TaskStatusEnum;     // "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED"
    assignedTo?: string | null;
    dueDate?: string;
  }
): Promise<{ task: TaskDocument }> => {
  // PRECONDITION CHECK 1: Verify project exists AND belongs to this workspace
  const project = await ProjectModel.findById(projectId); // DB CALL #5
  // TypeScript: project is ProjectDocument | null

  if (!project || project.workspace.toString() !== workspaceId.toString()) {
    // .toString() needed because one is ObjectId (Mongoose type), one is string
    // This is a REAL Mongoose gotcha: ObjectId !== string always returns true
    throw new NotFoundException(
      "Project not found or does not belong to this workspace"
    );
    // Throws here, asyncHandler catches, error handler formats as 404 JSON response
  }

  // PRECONDITION CHECK 2: If user is assigning to someone else, verify they're in the workspace
  if (body.assignedTo) {
    const isMember = await MemberModel.exists({
      userId: body.assignedTo, // "user_789" from request body
      workspaceId, // "ws_456"
    }); // DB CALL #6
    // TypeScript: isMember is boolean (exists() only returns true/false, doesn't hydrate full document)

    if (!isMember) {
      throw new BadRequestException(
        "Assigned user is not a member of this workspace"
      );
      // 400 because the request is invalid (references a non-member)
    }
  }

  // NOW that all preconditions are checked, create the document in memory (not saved yet)
  const task = new TaskModel({
    // TypeScript: Constructor accepts partial object, Mongoose fills in defaults
    title: body.title, // "Fix login OAuth"
    description: body.description, // "Users can't log in via Google"
    priority: body.priority || TaskPriorityEnum.MEDIUM, // Zod already validates enum
    status: body.status || TaskStatusEnum.TODO,
    assignedTo: body.assignedTo || null, // "user_789" or null
    createdBy: userId, // ObjectId("user_123") — who made the request
    workspace: workspaceId, // ObjectId from workspaceId string (mongoose handles conversion)
    project: projectId,
    dueDate: body.dueDate ? new Date(body.dueDate) : null,
  });
  // At this point, Mongoose schema validation runs (required fields, enum membership, etc)
  // But the document is still IN MEMORY, not yet in MongoDB

  // Actually write to database
  await task.save(); // DB CALL #7 (MongoDB INSERT)
  // TypeScript: .save() returns Promise<TaskDocument>
  // Mongoose auto-sets: _id (new ObjectId), taskCode (via generateTaskCode()), createdAt, updatedAt

  return { task };
  // TaskDocument now has all fields including _id, timestamps, etc
};
```

---

### 6. Data Layer & Database

**Mongoose Schema** (models/task.model.ts):

```ts
// TypeScript: Mongoose schema definition with typed document interface
interface TaskDocument extends Document {
  taskCode: string;
  title: string;
  description: string | null;
  project: mongoose.Types.ObjectId;
  workspace: mongoose.Types.ObjectId;
  status: TaskStatusEnum;
  priority: TaskPriorityEnum;
  assignedTo: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<TaskDocument>(
  {
    taskCode: {
      type: String,
      unique: true, // MongoDB creates unique index; E11000 error if duplicate
      default: generateTaskCode, // Callback function, called on every new document
      // Generates something like "task-a1b" (prefix + 3 hex chars)
    },
    title: {
      type: String,
      required: true, // Mongoose validation: throw if undefined
      trim: true, // Auto-remove whitespace
    },
    description: {
      type: String,
      trim: true,
      default: null, // Explicitly null if not provided
    },
    project: {
      type: Schema.Types.ObjectId, // MongoDB reference type
      ref: "Project", // Tells Mongoose this points to the Project model
      required: true,
    },
    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(TaskStatusEnum), // ["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]
      default: TaskStatusEnum.TODO, // Validation: throw if not in enum
    },
    priority: {
      type: String,
      enum: Object.values(TaskPriorityEnum),
      default: TaskPriorityEnum.MEDIUM,
    },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null, // Optional assignment
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    dueDate: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // Auto-adds createdAt and updatedAt fields
  }
);

const TaskModel = mongoose.model<TaskDocument>("Task", taskSchema);
```

**When task.save() executes, MongoDB INSERT happens:**

```javascript
// MongoDB operation (as if you ran this in the shell):
db.tasks.insertOne({
  _id: ObjectId("66cd1234567890abcdef0123"), // Auto-generated
  taskCode: "task-a1b", // Generated by generateTaskCode()
  title: "Fix login OAuth",
  description: "Users can't log in via Google",
  project: ObjectId("proj_123"),
  workspace: ObjectId("ws_456"),
  status: "TODO",
  priority: "CRITICAL",
  assignedTo: ObjectId("user_789"),
  createdBy: ObjectId("user_123"),
  dueDate: ISODate("2026-08-30T00:00:00Z"),
  createdAt: ISODate("2026-08-27T14:32:10.123Z"), // Auto-set by timestamps:true
  updatedAt: ISODate("2026-08-27T14:32:10.123Z"), // Auto-set by timestamps:true
  __v: 0 // Mongoose version key (internal)
});

// If this fails (e.g., task with same taskCode already exists):
// MongoDB throws: MongoError { code: 11000, message: "E11000 duplicate key error..." }
```

---

### 7. Response Sent to Client

**Happy path:**

```http
HTTP/1.1 200 OK
Content-Type: application/json
Access-Control-Allow-Origin: http://localhost:3000
Access-Control-Allow-Credentials: true
Date: Thu, 27 Aug 2026 14:32:10 GMT
Content-Length: 487

{
  "message": "Task created successfully",
  "task": {
    "_id": "66cd1234567890abcdef0123",
    "taskCode": "task-a1b",
    "title": "Fix login OAuth",
    "description": "Users can't log in via Google",
    "project": "proj_123",
    "workspace": "ws_456",
    "status": "TODO",
    "priority": "CRITICAL",
    "assignedTo": "user_789",
    "createdBy": "user_123",
    "dueDate": "2026-08-30T00:00:00.000Z",
    "createdAt": "2026-08-27T14:32:10.123Z",
    "updatedAt": "2026-08-27T14:32:10.123Z"
  }
}
```

**TypeScript note:** Mongoose serializes ObjectIds to strings in JSON automatically, so `task.project` (which is `ObjectId("proj_123")` in the database) becomes `"proj_123"` string in the response.

---

### 8. Error Path: What if Something Breaks?

**Example: Invalid priority enum value**

```json
// Client sends (by mistake):
{ "title": "Task", "priority": "URGENT", "status": "TODO" }
```

**Execution flow:**

```ts
// 1. Controller calls Zod:
const body = createTaskSchema.parse(req.body);
// Zod finds "URGENT" ∉ [LOW, MEDIUM, HIGH, CRITICAL]
// Zod throws ZodError

// 2. asyncHandler catches it:
try {
  await controller(req, res, next);
} catch (error) { // ZodError caught here
  next(error); // Send to error handler
}

// 3. Global error handler processes it:
if (error instanceof ZodError) {
  const errors = error.issues.map((e) => ({
    field: e.path.join("."), // "priority"
    message: e.message,      // "Invalid enum value. Expected 'LOW' | 'MEDIUM' | ..."
  }));
  return res.status(400).json({
    message: "Validation failed",
    errors,
    errorCode: "VALIDATION_ERROR",
  });
}
```

**Response to client:**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "message": "Validation failed",
  "errors": [
    {
      "field": "priority",
      "message": "Invalid enum value. Expected 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'"
    }
  ],
  "errorCode": "VALIDATION_ERROR"
}
```

**Key insight:** The request stops at validation — database is never touched, service layer is never entered. This is the whole point of layering.

---

### 9. Complete Round-Trip Tally

| Step | Operation | DB Call? | Purpose |
|------|-----------|----------|---------|
| Middleware | helmet, json parsing | ❌ | Security + body parsing |
| Auth: JWT verify | Check signature (in-memory) | ❌ | Decode & trust token |
| Auth: User lookup | UserModel.findById | ✅ #1 | "Does this user exist?" |
| Auth: Session check | SessionModel.findById | ✅ #2 | "Is this login still valid?" |
| Route match | Extract URL params | ❌ | Get projectId, workspaceId |
| Validation (Zod) | Parse body + params | ❌ | "Is input well-formed?" |
| Authz: Workspace lookup | WorkspaceModel.findById | ✅ #3 | "Does workspace exist?" |
| Authz: Member + role | MemberModel.findOne().populate | ✅ #4 | "Are you in it, and what's your role?" |
| Authz: Permission check | In-memory table lookup | ❌ | "Does role have CREATE_TASK?" |
| Business: Project check | ProjectModel.findById | ✅ #5 | "Does project exist in this workspace?" |
| Business: Assignee check | MemberModel.exists | ✅ #6 | "Is assignee a member?" |
| Write | TaskModel.save() | ✅ #7 | Insert into MongoDB |
| Response | res.status().json() | ❌ | Send HTTP response |

**7 database round trips total.**

---

# PART 3: REAL DEBUGGING SCENARIOS

## Scenario 1: CORS Error in Frontend, But Postman Works

**Symptom:**
```
Access to XMLHttpRequest at 'http://localhost:5000/api/task/...' 
from origin 'http://localhost:3001' has been blocked by CORS policy
```

**Root cause:** CORS config mismatch

**In index.ts lines 72-79:**
```ts
app.use(cors({
  origin: config.FRONTEND_ORIGIN, // What is this configured to?
  credentials: true,
  // ...
}));
```

**Debug 1: Check .env**
```bash
# .env
FRONTEND_ORIGIN=http://localhost:3000  # But app is running on 3001!
```

**Fix:**
```bash
# .env
FRONTEND_ORIGIN=http://localhost:3000,http://localhost:3001
# OR for development:
FRONTEND_ORIGIN=*  # (never do this in production)
```

**Debug 2: Add logging**
```ts
// Add this BEFORE cors():
app.use((req, res, next) => {
  console.log("Incoming request origin:", req.headers.origin);
  console.log("Allowed CORS origin:", config.FRONTEND_ORIGIN);
  next();
});

app.use(cors({ /* ... */ }));
```

**Debug 3: Frontend checklist**
```javascript
// Make sure frontend is sending credentials
fetch('/api/task/...', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include', // ← CRITICAL! Without this, cookies don't send
  body: JSON.stringify({...})
});
```

---

## Scenario 2: 400 Validation Error, But Input Looks Correct

**Response:**
```json
{
  "message": "Validation failed",
  "errors": [
    {
      "field": "priority",
      "message": "Invalid enum value"
    }
  ]
}
```

**Debug 1: Check case sensitivity**

In validation/task.validation.ts:
```ts
const prioritySchema = z.enum(
  Object.values(TaskPriorityEnum) as [string, ...string[]]
);

// TaskPriorityEnum values: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
// All UPPERCASE
```

**Client sends:**
```json
{ "priority": "high" }  // lowercase — MISMATCH!
```

**Fix in frontend:**
```typescript
// Option 1: Send correct case
const priority = "HIGH";

// Option 2: Use enum from shared types
import { TaskPriorityEnum } from '@/types';
const priority = TaskPriorityEnum.HIGH;

// Option 3: Accept client input and uppercase it (risky)
const priority = (req.body.priority as string).toUpperCase(); // But this validates afterwards!
```

**Debug 2: Enable detailed error logging**

In controller:
```ts
export const createTaskController = asyncHandler(
  async (req: Request, res: Response) => {
    console.log("Raw request body:", JSON.stringify(req.body, null, 2));
    
    try {
      const body = createTaskSchema.parse(req.body);
      console.log("Validated body:", body);
    } catch (error) {
      console.error("Zod error details:", error.format()); // Zod has detailed error formatting
      throw error;
    }
    
    // ... rest
  }
);
```

**Terminal output shows:**
```
Raw request body:
{
  "title": "New task",
  "priority": "urgent",  // ← Ah! Here's the problem
  "status": "TODO"
}
Zod error details:
{
  priority: {
    _errors: [
      "Invalid enum value. Expected 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', received 'urgent'"
    ]
  }
}
```

---

## Scenario 3: 403 Permission Denied When User Should Succeed

**Response:**
```json
{
  "message": "You are not a member of this workspace",
  "errorCode": "ACCESS_UNAUTHORIZED"
}
```

**Debug in MongoDB shell:**
```javascript
// Check: Is this user actually a member of this workspace?
db.members.findOne({
  userId: ObjectId("user_123"),
  workspaceId: ObjectId("ws_456")
});

// If returns null → user is NOT a member
// If returns document → user IS a member (but may have wrong role)
```

**Debug in code:**

Add logging to services/member.service.ts:
```ts
export const getMemberRoleInWorkspace = async (
  userId: string,
  workspaceId: string
) => {
  console.log(`Checking membership: userId=${userId}, workspaceId=${workspaceId}`);
  
  const workspace = await WorkspaceModel.findById(workspaceId);
  console.log(`Workspace found:`, workspace ? "YES" : "NO");
  if (!workspace) throw new NotFoundException("Workspace not found");

  const member = await MemberModel.findOne({
    userId,
    workspaceId,
  }).populate("role");
  console.log(`Member found:`, member ? "YES" : "NO");
  console.log(`Member role:`, member?.role?.name);
  if (!member) {
    throw new UnauthorizedException("You are not a member of this workspace", ...);
  }

  return { role: member.role?.name };
};
```

**Terminal output:**
```
Checking membership: userId=user_123, workspaceId=ws_456
Workspace found: YES
Member found: NO  ← This is your problem!
```

**Fix: Add user to workspace**
```javascript
// In MongoDB:
db.members.insertOne({
  userId: ObjectId("user_123"),
  workspaceId: ObjectId("ws_456"),
  role: ObjectId("<ADMIN_role_id>"),
  joinedAt: new Date()
});
```

---

## Scenario 4: Task Created But Missing User Info

**Response:**
```json
{
  "task": {
    "title": "Fix login",
    "assignedTo": "user_789",  // ← Just ID, not full user object!
    "createdBy": "user_123"
  }
}
```

**Root cause:** Mongoose didn't `.populate()` the references

**In service/task.service.ts, createTaskService returns raw task:**
```ts
return { task }; // task has ObjectIds, not populated data
```

**Fix: Populate before returning**

```ts
export const createTaskService = async (/* ... */) => {
  // ... validation ...
  const task = new TaskModel({ /* ... */ });
  await task.save();

  // Populate assigned user and creator
  const populatedTask = await TaskModel.findById(task._id)
    .populate("assignedTo", "_id name profilePicture") // Select only these fields
    .populate("createdBy", "_id name profilePicture");  // Exclude password, etc

  return { task: populatedTask };
};
```

**Now the response includes:**
```json
{
  "task": {
    "title": "Fix login",
    "assignedTo": {
      "_id": "user_789",
      "name": "Jane Developer",
      "profilePicture": "https://..."
    },
    "createdBy": {
      "_id": "user_123",
      "name": "John Developer",
      "profilePicture": "https://..."
    }
  }
}
```

---

## Scenario 5: Unhandled Exception Leaking Internal Details

**Response:**
```json
{
  "message": "Internal Server Error",
  "error": "TypeError: Cannot read property 'includes' of undefined"
}
```

**Root cause:** Error object's stack trace is leaking to the client (security risk!)

**In middlewares/errorHandles.middleware.ts:**
```ts
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  console.error(`Error on PATH: ${req.path}`, error); // Log FULL error server-side

  // ... handle specific error types ...

  // Final catch-all currently does this:
  return res.status(500).json({
    message: "Internal Server Error",
    error: error?.message, // ← This can leak implementation details!
  });
};
```

**Fix: Never expose implementation details to client**

```ts
return res.status(500).json({
  message: "Internal Server Error",
  // error: error?.message, // Remove this!
  // In development, you might optionally expose it:
  ...(config.NODE_ENV === "development" ? { debug: error?.message } : {}),
});
```

---

## Scenario 6: Database Connection Timeout

**Error:**
```
MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017
```

**Debug 1: Is MongoDB running?**
```bash
# Mac/Linux:
ps aux | grep mongod
# Should show a running mongod process

# If not:
brew services start mongodb-community  # Mac
mongod --config /usr/local/etc/mongod.conf # Or manually
```

**Debug 2: Can you connect to it?**
```bash
mongosh "mongodb://localhost:27017/astrix"
# If connection succeeds, MongoDB is running
# If it fails, check the connection string in .env
```

**Debug 3: Add logging to database config**

In config/database.config.ts:
```ts
const connectDatabase = async () => {
  try {
    console.log(`Attempting to connect to MongoDB at: ${process.env.MONGO_URI}`);
    await mongoose.connect(process.env.MONGO_URI!);
    console.log("✅ Connected to MongoDB successfully");
  } catch (error) {
    console.error("❌ MongoDB connection failed:");
    console.error(`   Error: ${error.message}`);
    console.error(`   URI: ${process.env.MONGO_URI}`);
    process.exit(1); // Fail hard if DB isn't available
  }
};
```

---

## Scenario 7: JWT Token Rejected Even Though It's Valid

**Response:**
```json
{
  "message": "Unauthorized"
}
```

**Debug 1: Is the token being sent?**

Add logging to passport config:
```ts
passport.use(new JwtStrategy(jwtOptions, async (payload, done) => {
  console.log("JWT payload received:", payload);
  
  if (!payload.userId) {
    console.log("❌ No userId in token!");
    return done(null, false);
  }

  const user = await findUserByIdService(payload.userId);
  console.log(`User lookup: ${user ? "✅ FOUND" : "❌ NOT FOUND"}`);

  if (!user) return done(null, false);

  const session = await SessionModel.findById(payload.sessionId);
  console.log(`Session lookup: ${session ? "✅ FOUND" : "❌ NOT FOUND"}`);
  console.log(`Session valid: ${session?.isValid}`);

  if (!session || !session.isValid) {
    return done(null, false);
  }

  return done(null, user);
}));
```

**Terminal output:**
```
JWT payload received: { userId: 'user_123', sessionId: 'sess_456', iat: 1693401234, exp: 1693404834 }
User lookup: ✅ FOUND
Session lookup: ❌ NOT FOUND  ← HERE'S THE PROBLEM
```

**Root cause:** Session document was deleted or invalidated

**Fix:**
```javascript
// Re-create the session:
db.sessions.insertOne({
  userId: ObjectId("user_123"),
  userAgent: "Mozilla/5.0...",
  ipAddress: "127.0.0.1",
  isValid: true,
  expiresAt: ISODate("2026-09-03T14:32:10Z") // Future date
});
```

---

# PART 4: BACKEND ARCHITECTURE & DESIGN PATTERNS

## Mental Model: Why Each Layer Exists

### Layer 1: Middleware Chain (index.ts)

```ts
// Why does this matter?
// - Security headers (helmet) prevent XSS/clickjacking attacks
// - Body parsing (express.json) converts raw bytes to JS objects
// - Cookie parsing enables refresh token mechanism
// - CORS gates requests from untrusted origins
// - Middleware ORDER is not arbitrary — each runs in sequence

// Wrong order example: if cookieParser() ran AFTER routes,
// any route reading req.cookies would see undefined
```

**Key insight:** Express's middleware chain is a LINEAR pipeline. Each middleware runs in order and can modify `req` or short-circuit with `res`. The order you see in `index.ts` is the *only* order that works.

---

### Layer 2: Authentication (config/passport.config.ts)

```ts
// Why Passport.js at all?
// - It's a standard, battle-tested library (used by millions of apps)
// - It abstracts multiple strategies (JWT, OAuth, local, etc.) behind one interface
// - It handles the cryptographic details you'd otherwise get wrong

// Why JWT + Session database hybrid?
// - Pure JWT: stateless verification is fast, but tokens can't be revoked
// - Pure sessions: revocation works, but every request needs a DB lookup
// - Hybrid: JWT for speed (signature check is in-memory), session check for revocation
// This is the right tradeoff for most applications

export const passportAuthenticateJWT = passport.authenticate("jwt", { session: false });
// This middleware runs on EVERY protected route before controllers see the request
// It sets req.user if successful, or sends 401 if not
// Controllers NEVER have to handle "unauthenticated" cases — if they run, req.user exists
```

---

### Layer 3: Validation (validation/*.ts)

```ts
// Why Zod?
// - Declarative: describe the shape once, use it for validation + TypeScript types
// - Composable: small schemas (titleSchema, emailSchema) combine into larger ones
// - Errors are detailed and structured (field-by-field)
// - Throws an exception that your error handler knows how to format

// Why validate in the CONTROLLER, not as middleware?
// - Pro: simplicity, no extra middleware chaining
// - Con: auth happens before validation (a malformed request still gets a 401 if unauthenticated)
// - This is intentional: don't leak schema info to unauthenticated clients

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(255),
  // Each field is a composable validator
  // Errors tell the client exactly what's wrong
});
```

---

### Layer 4: Authorization (services/member.service.ts + utils/roleGuard.ts)

```ts
// Why is this TWO separate functions?

// Part A: getMemberRoleInWorkspace()
// - Answers a DATA question: "What role does this user have HERE?"
// - Requires DB lookups (membership, role, permissions)
// - Should be called ONCE per request, in the controller
// - Throws if user isn't a member at all

// Part B: roleGuard()
// - Answers a RULE question: "Does that role permit this action?"
// - Pure in-memory check, NO DB access
// - Should be called for EACH permission-gated action
// - Throws if permission missing

// Separating them means:
// 1. Authorization rules are unit-testable (no DB needed)
// 2. Role fetching is clearly separated from permission-checking
// 3. If you add "custom roles per workspace" later, you only change part A

export const roleGuard = (role: string, requiredPermissions: string[]) => {
  const permissions = RolePermissions[role]; // In-memory object
  const hasPermission = requiredPermissions.every((p) => permissions.includes(p));
  if (!hasPermission) throw new UnauthorizedException(...);
};
// This function is testable in milliseconds, zero infrastructure needed
```

---

### Layer 5: Service Layer (services/*.service.ts)

```ts
// Why do services exist if controllers already call functions?
// - Controllers handle HTTP (requests, responses, status codes)
// - Services handle business rules (validation, calculations, orchestration)
// - This separation means you can:
//   - Test services without Express
//   - Reuse services from CLI commands or webhook handlers
//   - Swap transport layers (replace Express with Fastify) without changing services

// The guard-clause pattern (found in every service here):
export const createTaskService = async (workspaceId, projectId, userId, body) => {
  // Validate preconditions FIRST
  const project = await ProjectModel.findById(projectId);
  if (!project || project.workspace.toString() !== workspaceId.toString()) {
    throw new NotFoundException(...); // Fail fast
  }

  // ONLY after all guards pass, do the actual work
  const task = new TaskModel({ /* ... */ });
  await task.save();
  return { task };
};
// This is called "fail-fast": check everything that could go wrong before doing anything

// Why check project.workspace even though controller already checked membership?
// - Defense in depth: every layer re-validates what matters to IT
// - URL params can be forged: if client says "create task in project X in workspace Y",
//   we don't trust them — we verify project X actually belongs to workspace Y
// - This is what stops IDOR (Insecure Direct Object Reference) vulnerabilities
```

---

### Layer 6: Data Layer (models/*.model.ts)

```ts
// Mongoose schemas are where the LAST line of defense lives

// Why have defaults in the schema AND in the service?
export const taskSchema = new Schema({
  taskCode: { type: String, unique: true, default: generateTaskCode },
  priority: { type: String, enum: [...], default: MEDIUM },
  status: { type: String, enum: [...], default: TODO },
  timestamps: true, // Auto-sets createdAt, updatedAt
});

// These defaults run when:
// 1. A document is constructed (new TaskModel({ /* no priority */ }))
// 2. BEFORE .save() is called
// 3. On the application layer, AFTER Zod validation

// Why does this matter?
// - If you insert directly in MongoDB (bypassing Mongoose), defaults don't run
// - Database as a "last resort" verification: if bad data somehow makes it here, schema validation catches it
// - This is why "default" exists in schema: it's not just about convenience, it's defense

// The unique index on taskCode
// - Prevents duplicate task codes
// - But what if a collision happens? MongoDB throws E11000 error
// - The error handler currently doesn't handle this specifically (a real gap in this repo)
```

---

## Design Patterns Used

### 1. Layered Architecture (Route → Controller → Service → Model)

Already covered. This is the structure everything else hangs on.

### 2. Higher-Order Function (asyncHandler)

```ts
// Without it:
router.post("/tasks", async (req, res, next) => {
  try {
    // business logic
  } catch (err) {
    next(err); // Repeated in EVERY controller
  }
});

// With it:
router.post("/tasks", asyncHandler(async (req, res) => {
  // business logic
  // Any throw is caught automatically
}));

// Why HOF instead of a decorator?
// - TypeScript decorators are still experimental
// - HOFs are plain functions, zero overhead
// - It's the idiomatic Express pattern
```

### 3. Strategy Pattern (Passport)

```ts
// Multiple authentication strategies behind a common interface
passport.use(new JwtStrategy(/* ... */)); // For access tokens
passport.use(new GoogleStrategy(/* ... */)); // For OAuth
passport.use(new LocalStrategy(/* ... */)); // For password auth

// Calling code doesn't care which strategy:
passport.authenticate("jwt"); // or "google" or "local"

// Why?
// - Swapping auth methods doesn't change controller code
// - New strategy? Just register it once, everywhere that uses passport.authenticate picks it up
```

### 4. Exception Hierarchy

```ts
// Base class carries the shape every error needs
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorCode: string
  ) {
    super(message);
  }
}

// Subclasses just set defaults
export class NotFoundException extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, ErrorCodeEnum.NOT_FOUND);
  }
}

// Error handler processes them all the same way:
if (error instanceof AppError) {
  return res.status(error.statusCode).json({
    message: error.message,
    errorCode: error.errorCode,
  });
}

// Why?
// - New error type? Just extends AppError, works automatically
// - Status codes are always consistent (NotFoundException always 404)
// - No duplicated error handling logic
```

### 5. Guard Clause / Fail-Fast Pattern

```ts
// Instead of nested if-statements (pyramid of doom):
if (user) {
  if (member) {
    if (hasPermission) {
      if (project) {
        // Do the thing
      }
    }
  }
}

// Use guards to fail fast:
if (!user) throw new UnauthorizedException(...);
if (!member) throw new UnauthorizedException(...);
if (!hasPermission) throw new UnauthorizedException(...);
if (!project) throw new NotFoundException(...);

// Do the thing

// Why?
// - Easier to read (no indentation rabbit hole)
// - Every condition has its own error message
// - Early exit means less work for the happy path
```

### 6. Single Source of Truth (SSOT) for Permissions

```ts
// Define once:
export enum Permissions {
  VIEW_ONLY = "VIEW_ONLY",
  CREATE_TASK = "CREATE_TASK",
  // ... etc
}

// Build the permission matrix from it:
export const RolePermissions = {
  OWNER: [Permissions.CREATE_TASK, Permissions.DELETE_TASK, ...],
  ADMIN: [Permissions.CREATE_TASK, ...],
  MEMBER: [Permissions.VIEW_ONLY, Permissions.CREATE_TASK, ...],
};

// Use in roleGuard:
roleGuard(role, [Permissions.CREATE_TASK]);

// Use in schema defaults:
permissions: { type: [String], default: () => RolePermissions[this.name] }

// Why?
// - Permission list isn't duplicated
// - If you need to add a permission, it exists in one place
// - Tests can verify the matrix hasn't accidentally changed
```

### 7. TTL (Time-To-Live) Index for Session Cleanup

```ts
// Mongoose schema:
expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }

// MongoDB does this automatically:
// - Every document with an expiresAt in the past is deleted
// - Zero application code needed
// - Runs every 60 seconds by default

// Why?
// - Sessions expire naturally without a background job
// - DB cleanup is automatic
// - It's a built-in MongoDB feature (much faster than app-level cleanup)
```

---

## The Checklist: Design Every Endpoint Like This

When you're building a new endpoint, ask these questions IN ORDER:

1. **Shape validation** — Is the input well-formed?
   ```ts
   const body = someSchema.parse(req.body);
   ```

2. **Identity** — Do we know who's asking?
   ```ts
   const userId = req.user?._id; // Guaranteed by auth middleware
   ```

3. **Membership/Tenancy** — Does this identity have any relationship to this resource?
   ```ts
   const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
   if (!role) throw new UnauthorizedException(...);
   ```

4. **Permission** — Is this specific action allowed?
   ```ts
   roleGuard(role, [Permissions.CREATE_TASK]);
   ```

5. **Isolation** — Do the resource IDs in the URL actually belong to each other?
   ```ts
   const project = await ProjectModel.findById(projectId);
   if (project.workspace !== workspaceId) throw new NotFoundException(...);
   ```

6. **Conditional integrity** — Do optional references resolve correctly?
   ```ts
   if (body.assignedTo) {
     const isMember = await MemberModel.exists({ userId: body.assignedTo, workspaceId });
     if (!isMember) throw new BadRequestException(...);
   }
   ```

7. **The write** — Only NOW do you actually modify data
   ```ts
   const task = new TaskModel({ /* ... */ });
   await task.save();
   ```

8. **Response shaping** — Controller decides HTTP status + envelope, service returns domain object
   ```ts
   return res.status(200).json({ message: "...", task });
   ```

9. **Error typing** — Every throw carries an intentional status code
   ```ts
   throw new NotFoundException(...); // → 404
   throw new UnauthorizedException(...); // → 401/403
   throw new BadRequestException(...); // → 400
   ```

**If you follow this checklist, your endpoint will be:**
- Secure (every layer checks what matters to it)
- Debuggable (errors are specific and typed)
- Testable (each layer is independent)
- Maintainable (the pattern is consistent everywhere)

---

## Real Bugs in This Codebase (Use These as Exercises)

### Bug 1: Wrong Exception Type

**Location:** services/task.service.ts line 38

```ts
// Current:
throw new Error("Assigned user is not mnember of this workspace");
// Problems:
// 1. Bare Error, not AppError — falls through to 500 handler
// 2. Typo: "mnember" instead of "member"
// 3. Should be 400 (bad request), not 500

// Fix:
throw new BadRequestException("Assigned user is not a member of this workspace");
```

### Bug 2: Unhandled Mongo Duplicate Key Error

**Location:** middlewares/errorHandles.middleware.ts

```ts
// Current: No handling for E11000
// When taskCode is duplicated, MongoDB throws:
// { code: 11000, message: "E11000 duplicate key error..." }

// This falls through to the generic 500 handler, leaking internals

// Fix:
if (error.code === 11000) {
  const field = Object.keys(error.keyPattern || {})[0];
  return res.status(409).json({
    message: `${field} must be unique`,
    errorCode: ErrorCodeEnum.CONFLICT,
  });
}
```

### Bug 3: No Rate Limiting

**Location:** index.ts

```ts
// Current: App.set("trust proxy", 1) is configured (for ALB)
// But NO rate limiting middleware is actually used

// Add this:
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  skipSuccessfulRequests: true, // Only count failures
  message: "Too many login attempts, please try again later",
});

router.post("/auth/login", authLimiter, loginController);
router.post("/auth/register", authLimiter, registerController);
```

### Bug 4: Unsafe Regex in Search

**Location:** services/task.service.ts

```ts
// Current:
query.title = { $regex: filters.keyword, $options: "i" };
// Problem: filters.keyword comes from req.query, unescaped
// A malicious client could send a ReDoS (regular expression denial of service) payload

// Fix:
const escapedKeyword = filters.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
query.title = { $regex: escapedKeyword, $options: "i" };

// Or better: use MongoDB text search
// db.tasks.createIndex({ title: "text", description: "text" });
// query.$text = { $search: filters.keyword };
```

### Bug 5: Missing Unique Check on Email

**Location:** models/user.model.ts

```ts
// Current:
email: { type: String, required: true, unique: true, lowercase: true }

// But if the schema doesn't have an index, unique: true doesn't actually work!
// Add this to make sure the index exists:
// db.users.createIndex({ email: 1 }, { unique: true });

// Or in the schema with sparse option (for null values):
email: { type: String, required: true, unique: true, lowercase: true, sparse: true }
```

---

## Performance Considerations

### Database Queries Are Sequential, Not Parallel

```ts
// Current createTaskService does this (sequential):
const project = await ProjectModel.findById(projectId); // Wait for this
// ...then...
const isMember = await MemberModel.exists({ /* ... */ }); // Then do this
// ...then...
await task.save(); // Then this

// This means: query time = T1 + T2 + T3

// Better: Parallel queries where possible
const [project, isMember] = await Promise.all([
  ProjectModel.findById(projectId),
  MemberModel.exists({ userId: body.assignedTo, workspaceId }),
]);
// This means: query time = max(T1, T2) — much faster if queries are independent
```

### Caching RBAC Checks

```ts
// Current: Every request fetches workspace membership from DB
// With 100 req/sec, that's 100 DB queries just for RBAC

// Better: Cache role lookups in Redis with 5-min TTL
// interface CachedRole { role: string; expiresAt: number; }
// const cacheKey = `role:${userId}:${workspaceId}`;
// const cached = await redis.get(cacheKey);
// if (cached) return JSON.parse(cached); // Hit
// const role = await getMemberRoleInWorkspace(userId, workspaceId);
// await redis.set(cacheKey, JSON.stringify(role), "EX", 300); // 5 min TTL
```

### Database Indexes

```ts
// Every query that filters (find/findOne) should have an index
// Current indexes (good):
// - User.email (unique)
// - Member.{userId, workspaceId}
// - Task.workspace
// - Session.userId + Session.expiresAt (TTL)

// Missing indexes (add these):
// - Task.{workspace, project} together (for getAllTasksService filters)
// - Role.name (for roleGuard lookups)
// - Project.workspace (for project list queries)

// In Mongoose:
userSchema.index({ email: 1 });
memberSchema.index({ userId: 1, workspaceId: 1 });
taskSchema.index({ workspace: 1, project: 1 });
```

---

## Production Readiness Checklist

- [ ] Structured logging (pino, winston, not just console.log)
- [ ] Error tracking (Sentry, Datadog, New Relic)
- [ ] Database connection pooling (Mongoose does this, but verify pool size)
- [ ] Request rate limiting (express-rate-limit with Redis backend for multi-server)
- [ ] HTTPS/TLS (always, never HTTP in production)
- [ ] CORS origin validation (never `*` in production)
- [ ] Environment variables validation on startup (getEnv() fails hard if missing)
- [ ] Password hashing (bcrypt, never plaintext) — already done ✅
- [ ] Secrets rotation (JWT secrets should be rotatable)
- [ ] Audit logging (who did what, when, from where)
- [ ] Database backups (daily, tested restores)
- [ ] Monitoring/alerting (request latency, error rates, DB connection pool usage)

---

# PART 5: BUILDING FROM SCRATCH EXERCISES

## Exercise 1: Add a `GET /workspace/:id/members/count` Endpoint

**Requirement:** Return `{ count: number }` — how many members are in this workspace?

**Build from scratch, touching:**
1. Route in `routes/workspace.route.ts`
2. Controller in `controllers/workspace.controller.ts`
3. Service in `services/workspace.service.ts`
4. Maybe a validation schema (though params are minimal here)

**Follow the checklist:**
- [ ] Validation (just a workspaceId param)
- [ ] Identity (req.user established by middleware)
- [ ] Membership (are they in this workspace?)
- [ ] Permission (VIEW_ONLY is enough to list members)
- [ ] Isolation (does this workspace exist?)
- [ ] DB query (count members)
- [ ] Response shape (controller decides format)
- [ ] Error typing (NotFoundException if workspace doesn't exist)

**Solution sketch:**
```ts
// routes/workspace.route.ts
workspaceRoutes.get("/:id/members/count", getMembersCountController);

// controllers/workspace.controller.ts
export const getMembersCountController = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const workspaceId = workspaceIdSchema.parse(req.params.id);

  const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
  roleGuard(role, [Permissions.VIEW_ONLY]);

  const { count } = await getMembersCountService(workspaceId);
  return res.status(200).json({ count });
});

// services/workspace.service.ts
export const getMembersCountService = async (workspaceId: string) => {
  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) throw new NotFoundException("Workspace not found");

  const count = await MemberModel.countDocuments({ workspaceId });
  return { count };
};
```

---

## Exercise 2: Implement Logout

**Requirement:** When a user logs out, their current session should be invalidated (tokens revoked).

**What changes:**
1. `POST /auth/logout` endpoint that invalidates the session
2. Future requests using that session's refresh token should be rejected

**Think through:**
- The JWT strategy already checks `session.isValid` — so to revoke, just set it to false
- Should we delete the session or just mark it invalid? (Invalid is safer — audit trail)
- What token do we use to identify which session to invalidate? (The refresh token, or better, the sessionId from the JWT payload)

**Solution sketch:**
```ts
// controllers/auth.controller.ts
export const logoutController = asyncHandler(async (req, res) => {
  const sessionId = req.user?.sessionId; // Set by JWT strategy
  if (!sessionId) throw new UnauthorizedException("No session to logout");

  await SessionModel.findByIdAndUpdate(sessionId, { isValid: false });

  res.clearCookie("refreshToken"); // Clear the cookie too
  return res.status(200).json({ message: "Logged out successfully" });
});

// Add to routes/auth.route.ts:
authRoutes.post("/logout", passportAuthenticateJWT, logoutController);
```

---

## Exercise 3: Fix the Transaction Gap in Workspace Creation

**Current problem** (from services/workspace.service.ts):
```ts
const workspace = new WorkspaceModel({ /* ... */ });
await workspace.save(); // Write #1

const member = new MemberModel({ /* ... */ });
await member.save(); // Write #2 — if this fails, workspace is orphaned

user.currentWorkspace = workspace._id;
await user.save(); // Write #3
```

If write #2 fails partway through, you have a workspace with no member record — inaccessible.

**Fix using MongoDB transactions:**

```ts
// services/workspace.service.ts
export const createWorkspaceService = async (userId: string, body) => {
  const session = await mongoose.startSession(); // Start transaction
  try {
    await session.withTransaction(async () => {
      const user = await UserModel.findById(userId);
      if (!user) throw new NotFoundException("User not found");

      const ownerRole = await RoleModel.findOne({ name: Roles.OWNER });
      if (!ownerRole) throw new NotFoundException("Owner role not found");

      // All writes happen within the transaction
      const workspace = new WorkspaceModel({ name: body.name, description: body.description, owner: user._id });
      await workspace.save({ session }); // Participate in transaction

      const member = new MemberModel({
        userId: user._id,
        workspaceId: workspace._id,
        role: ownerRole._id,
        joinedAt: new Date(),
      });
      await member.save({ session });

      user.currentWorkspace = workspace._id;
      await user.save({ session });

      return { workspace };
    });
  } finally {
    await session.endSession();
  }
};

// Now: if ANY write fails, MongoDB rolls back all of them
// Result: either workspace + member + user update all succeed, or none do
// No orphaned documents
```

---

## Exercise 4: Add Request Logging

**Requirement:** Log every request (method, path, status, latency)

**Add to index.ts:**

```ts
// Custom request logging middleware
// TypeScript: middleware signature is (req, res, next) => void or Promise<void>
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now(); // Capture time when request starts

  // Hook into res.end to log when response is sent
  const originalEnd = res.end;
  res.end = function (...args: any[]) {
    const latency = Date.now() - startTime;
    const level = res.statusCode >= 400 ? "error" : res.statusCode >= 300 ? "warn" : "info";
    
    console.log(
      `[${level.toUpperCase()}] ${req.method} ${req.path} ${res.statusCode} ${latency}ms`
    );

    // Call the original res.end
    originalEnd.apply(res, args);
  };

  next();
});
```

**Better version using a logging library (pino):**

```ts
import pino from "pino";
import pinoHttp from "pino-http";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty", // Pretty-print in development
    options: { colorize: true },
  },
});

app.use(pinoHttp({ logger }));
```

---

## Exercise 5: Add Pagination to Task List

**Requirement:** `GET /workspace/:id/tasks?page=1&limit=10` returns paginated results

**Current:** `getAllTasksService` already supports pagination, but it's not used

**What to add:**

```ts
// controllers/task.controller.ts — add new endpoint
export const listTasksController = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const workspaceId = workspaceIdSchema.parse(req.params.id);

  const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
  roleGuard(role, [Permissions.VIEW_ONLY]);

  // Parse pagination params with defaults
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  // Clamp limit to prevent someone requesting 1M results at once

  const result = await getAllTasksService(workspaceId, {}, { pageNumber: page, pageSize: limit });

  return res.status(200).json({
    message: "Tasks fetched",
    data: result.tasks,
    pagination: result.pagination, // { pageNumber, pageSize, totalCount, totalPages }
  });
});

// routes/task.route.ts
taskRoutes.get("/workspace/:id/list", listTasksController);
```

---

## Final Capstone: Implement `PATCH /workspace/:id` to Rename

Build this entirely from scratch using the checklist. Should:
1. Validate new name (required, string, 1-255 chars)
2. Check auth (must be logged in)
3. Check membership (must be in workspace)
4. Check permission (only OWNER can rename workspace)
5. Verify workspace exists
6. Update it
7. Return the updated workspace

---

# Quick Reference Tables

## HTTP Status Codes Used

| Code | Meaning | When Thrown |
|------|---------|-------------|
| 200 | OK | Request succeeded |
| 201 | Created | Resource created (POST) |
| 400 | Bad Request | Input is invalid (Zod, missing required field) |
| 401 | Unauthorized | Not authenticated (no JWT, or JWT invalid) |
| 403 | Forbidden | Authenticated but not authorized (wrong role/permission) |
| 404 | Not Found | Resource doesn't exist or doesn't belong here (IDOR protection) |
| 409 | Conflict | Database constraint violated (unique key collision) |
| 500 | Internal Error | Unhandled exception (server bug) |

## TypeScript Patterns You'll See

```ts
// Optional chaining — safely access nested properties
const userId = req.user?._id; // undefined if req.user is null/undefined

// Nullish coalescing — use right side if left is null/undefined
const value = input ?? "default";

// Type assertions — tell TypeScript "trust me, this is this type"
(user as any).sessionId = payload.sessionId; // Sometimes needed with Mongoose

// Generic type parameters — make functions reusable across types
async function findById<T extends Document>(id: string): Promise<T | null> { /* ... */ }

// Union types — value can be one of several types
type Role = "OWNER" | "ADMIN" | "MEMBER";

// Discriminated unions — type narrowing based on a field
type Error = { type: "NotFound" } | { type: "Unauthorized"; message: string };

// Readonly — prevent mutation
interface Config { readonly apiKey: string; }
// Now config.apiKey = "new" throws a TypeScript error
```

---

# Summary

You now have:

1. **Mental model** (the pipeline in your head before you read code)
2. **Real trace** (exact variable values at each step for a real request)
3. **Debugging playbook** (7 scenarios + how to debug each)
4. **Architecture knowledge** (why each layer exists)
5. **Design patterns** (what patterns are used, why)
6. **Production readiness** (what's missing before shipping)
7. **Exercises** (hands-on to make it yours)

**Next steps:**
- Pick one endpoint from this codebase
- Trace it end-to-end using the mental model
- Reproduce a bug from the real bugs section
- Build one new endpoint from the exercises
- Explain it to someone else (that's when you know you truly understand it)

Everything generalizes. Once this pipeline is automatic, you can debug any backend in any language.