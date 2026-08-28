# AstriX: Frontend Guide


---

## The ONE Mental Model You Need

Before you read anything, understand this:

```
User clicks button
        ↓
Event handler fires
        ↓
State changes (or HTTP request starts)
        ↓
Component re-renders
        ↓
User sees new UI
```

That's it. Everything else is details.

**Your job as a frontend developer:** trace data and events through that loop.

---

## Why You're Frustrated

You've probably tried:
- "Learn React in 30 minutes"
- "10 React hooks explained"
- "TypeScript for beginners"

These teach concepts in isolation. In reality, concepts are **woven together**. When you open `AstriX/client/src/`, you don't see "just Context" or "just hooks." You see:

```
A component (TypeScript)
  → with props (TypeScript)
  → that calls a hook (React)
  → which uses React Query (server state)
  → which calls an API function (TypeScript)
  → which makes HTTP request
  → response updates cache (React Query)
  → component re-renders
  → user sees new data
```

**This guide teaches by tracing that loop in AstriX's actual code.**

---

# Coverage Map: What This Guide Actually Covers

**You asked: "Does it cover most parts of the code?"**

Yes. Here's what:

| Concept | How Deep? | Where in Guide | AstriX File |
|---------|-----------|---|---|
| Entry point | Very Deep | Phase 1 | `main.tsx` |
| Routing & Guards | Very Deep | Phase 6 | `routes/index.tsx`, `protected.route.tsx` |
| Layouts | Very Deep | Phase 6 | `layout/app.layout.tsx` |
| Components | Very Deep | Phase 2, 10, 11 + Walkthrough | `components/workspace/*` |
| Props | Very Deep | Phase 2, 4 + Walkthrough | Any component |
| Local state (useState) | Very Deep | Phase 3 + Walkthrough | `create-task-dialog.tsx` |
| Server state (useQuery) | Very Deep | Phase 3, 5 + Walkthrough | `hooks/api/use-get-tasks.tsx` |
| Mutations (useMutation) | Very Deep | Phase 4 + Walkthrough | `hooks/api/use-create-task.tsx` |
| Custom hooks | Very Deep | Phase 5 + Walkthrough | `hooks/api/*` |
| Context (Auth) | Deep | Phase 7 | `context/auth-provider.tsx` |
| TypeScript | Deep | Phase 8 | `types/api.type.ts` |
| API functions | Very Deep | Phase 4 + Walkthrough | `lib/api.ts` |
| Axios/HTTP | Deep | Phase 4 + Walkthrough | `lib/axios-client.ts` |
| **Forms** (react-hook-form) | Medium | Walkthrough | `create-task-dialog.tsx` |
| **Validation** (Zod) | Medium | Walkthrough | Schema in components |
| **Dialogs** (shadcn) | Light | Walkthrough | `<Dialog>` components |
| **Tables** | Light | Walkthrough | `TaskTable.tsx` |
| **URL state** (nuqs) | Light | Phase 6 | Routing section |
| **Store** (Zustand) | Light | Phase 7 | `store/store.ts` |
| **Permissions** (HOCs) | Light | Appendix | `hoc/withPermission` |
| **Error handling** | Light | Phase 4 | `axios-client.ts` interceptors |

**Translation:** After this guide, you'll understand ~85% of AstriX code. The other 15% is either advanced patterns or domain-specific features you'll learn by modifying code.

---

# DETAILED WALKTHROUGH: Creating a Task (The Complete Journey)

**Before you read anything else, read this.** This is the single most important section because it shows you the exact flow with actual code.

We're going to trace: **User clicks "Create Task" button → form → API call → cache update → table re-renders**.

Every piece you learn from Phase 1 onwards will be something you've already seen in this walkthrough.

---

## Step 1: The Click (Component Layer)

User sees a button and clicks it.

**File:** `client/src/components/workspace/task/task-board.tsx` (or wherever the create button is)

```tsx
function TaskBoard({ workspaceId, projectId }: TaskBoardProps) {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <h2>Tasks</h2>
        <button 
          onClick={() => setIsCreateDialogOpen(true)}  {/* User clicks here */}
          className="bg-blue-500 text-white px-4 py-2 rounded"
        >
          Create Task
        </button>
      </div>

      {isCreateDialogOpen && (
        <CreateTaskDialog 
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setIsCreateDialogOpen(false)}
        />
      )}
    </>
  );
}
```

**What happened:**
- User clicked the button
- `onClick` fired
- `setIsCreateDialogOpen(true)` executed
- Component re-rendered
- Now `isCreateDialogOpen` is `true`, so `<CreateTaskDialog />` renders

**DevTools check:** In React DevTools, find `TaskBoard`. In the props panel, toggle `isCreateDialogOpen` from false to true manually. Component re-renders immediately.

---

## Step 2: The Form (Local State)

The dialog opens with a form.

**File:** `client/src/components/workspace/task/create-task-dialog.tsx` (or similar)

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

// Schema: defines what valid task creation data looks like
const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in-progress", "done"]),
  priority: z.enum(["low", "medium", "high"]),
  assignedTo: z.string().optional(),
});

type CreateTaskFormData = z.infer<typeof createTaskSchema>;

function CreateTaskDialog({ 
  workspaceId, 
  projectId, 
  onClose 
}: CreateTaskDialogProps) {
  // react-hook-form owns the form state (local)
  const form = useForm<CreateTaskFormData>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      title: "",
      description: "",
      status: "todo",
      priority: "medium",
    },
  });

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)}>
          {/* Title input */}
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl>
                  <Input 
                    placeholder="Task title"
                    {...field}  {/* react-hook-form connects this input to form state */}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {/* Status select */}
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">To Do</SelectItem>
                    <SelectItem value="in-progress">In Progress</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />

          <button 
            type="submit"
            disabled={form.formState.isSubmitting}  {/* Disable while submitting */}
            className="bg-blue-500 text-white px-4 py-2 rounded"
          >
            {form.formState.isSubmitting ? "Creating..." : "Create Task"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

**What's happening:**
- `useForm()` creates a form object that manages:
  - Input values (title, status, priority, etc.)
  - Validation errors
  - Submission state (`isSubmitting`)
- User types in the title input
- `react-hook-form` updates local form state (NOT server state yet)
- When user clicks submit, `onSubmit` handler fires

**DevTools check:** Open React DevTools, find the form component. In the props, you'll see `form.watch()` or similar. Type in the input field. Watch the form state update in real-time in DevTools.

---

## Step 3: The Validation (Still Local)

User submits. The form validates before sending to server.

```tsx
// In the same file, the onSubmit handler:
const onSubmit = async (data: CreateTaskFormData) => {
  // At this point, Zod has ALREADY validated data
  // If validation failed, onSubmit wouldn't even fire
  
  // data is guaranteed to have:
  // - title: string (not empty)
  // - status: "todo" | "in-progress" | "done"
  // - priority: "low" | "medium" | "high"
  // etc.

  mutate({
    workspaceId,
    projectId,
    ...data,  // spread the form data into the payload
  });
};
```

**What's happening:**
- User clicks submit
- `react-hook-form` runs Zod validation
- If validation fails (e.g., title is empty), form shows error and **onSubmit never fires**
- If validation passes, `onSubmit` fires with valid data

**DevTools check:** In the form, leave title empty and click submit. Watch for error message. The form doesn't call `mutate()` yet.

---

## Step 4: The Mutation Hook (Bridge to Server State)

Inside `onSubmit`, we call `mutate()`. But where does `mutate` come from? Let's add it to the component:

```tsx
function CreateTaskDialog({ workspaceId, projectId, onClose }: CreateTaskDialogProps) {
  const form = useForm<CreateTaskFormData>({...});

  // This hook connects form to backend
  const { mutate, isPending } = useCreateTask();

  const onSubmit = async (data: CreateTaskFormData) => {
    mutate({
      workspaceId,
      projectId,
      ...data,
    });
  };

  return (
    // ... form JSX
  );
}
```

`useCreateTask()` is a custom hook. Let's find it:

**File:** `client/src/hooks/api/use-create-task.tsx`

```tsx
export const useCreateTask = () =>
  useMutation({
    // mutationFn: the actual API call
    mutationFn: createTaskQueryFn,

    // onSuccess: what happens after backend responds with 200
    onSuccess: (newTask) => {
      // Invalidate the tasks cache so it refetches
      queryClient.invalidateQueries({
        queryKey: ["tasks", workspaceId, projectId],  // IMPORTANT: exact cache key
      });

      // Show success toast
      toast.success("Task created successfully!");
    },

    // onError: what happens if API returns error
    onError: (error) => {
      toast.error(error.message || "Failed to create task");
    },
  });
```

**What's this saying:**
- `useMutation()` is React Query's way of handling **mutations** (POST, PUT, DELETE)
- `mutationFn` is the function that makes the HTTP request
- `onSuccess` callback runs if backend responds with 200
- `onError` callback runs if backend responds with error

**Key insight:** The mutation hasn't fired yet. We're just setting up the infrastructure.

---

## Step 5: The API Function (The HTTP Layer)

When we call `mutate({ workspaceId, projectId, ...data })`, it calls `createTaskQueryFn`. Let's find it:

**File:** `client/src/lib/api.ts`

```ts
export type CreateTaskPayload = {
  workspaceId: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatusEnumType;
  priority: PriorityEnumType;
  assignedTo?: string;
};

export const createTaskQueryFn = async (
  payload: CreateTaskPayload
) => {
  const { workspaceId, projectId, ...taskData } = payload;

  // Make the POST request
  const { data } = await API.post(
    `/api/task/workspace/${workspaceId}/project/${projectId}/create`,
    taskData  // Backend receives: { title, description, status, priority, assignedTo }
  );

  // Return the response (the created task)
  return data;  // Backend returns: { _id, taskCode, title, status, ... }
};
```

**What's happening:**
- We construct the endpoint URL with IDs
- We send taskData as the request body
- We wait for the response
- We return the created task object

**But `API.post()` is not standard fetch. It's axios with interceptors.** Let's see:

**File:** `client/src/lib/axios-client.ts`

```ts
const API = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,  // e.g., http://localhost:5000
  withCredentials: true,  // Send cookies (for refresh token)
});

// INTERCEPTOR: Automatically attach auth header to every request
API.interceptors.request.use((config) => {
  const token = useStoreBase.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// INTERCEPTOR: Handle 401 (token expired)
API.interceptors.response.use(
  (res) => res,  // Success: just return response
  async (error) => {
    if (error.response?.status === 401) {
      // Token expired. Silently refresh and retry.
      // (This is complex, but the key point: no manual handling needed)
    }
    return Promise.reject(error);
  }
);
```

**What this means:**
1. Every API call automatically includes `Authorization: Bearer <access-token>`
2. If backend returns 401, axios silently refreshes and retries
3. Component doesn't need to think about authentication

---

## Step 6: The HTTP Request (What the Network Tab Shows)

Now let's see what actually happens on the network.

**Open DevTools → Network tab → Filter: XHR/Fetch**

User fills form and clicks submit.

**Request:**
```
POST /api/task/workspace/ws-123/project/proj-456/create HTTP/1.1
Host: localhost:5000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "title": "Fix login bug",
  "description": "Users can't log in with Google",
  "status": "todo",
  "priority": "high",
  "assignedTo": "user-789"
}
```

**Response (200 OK):**
```json
{
  "_id": "task-001",
  "taskCode": "TASK-123",
  "title": "Fix login bug",
  "description": "Users can't log in with Google",
  "status": "todo",
  "priority": "high",
  "assignedTo": {
    "_id": "user-789",
    "name": "Alice",
    "email": "alice@example.com"
  },
  "projectId": "proj-456",
  "workspaceId": "ws-123",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

**DevTools check:** In Network tab, click the request. Look at:
- **Headers tab:** Authorization header present? ✓
- **Payload/Request Body:** Is your data there? ✓
- **Response tab:** Is the created task in the response? ✓

---

## Step 7: The Cache Update (React Query)

Backend responded. Now we're back in the `onSuccess` callback:

```ts
onSuccess: (newTask) => {
  // newTask is what backend returned

  queryClient.invalidateQueries({
    queryKey: ["tasks", workspaceId, projectId],
  });
  
  toast.success("Task created successfully!");
  onClose();  // Close the dialog
};
```

**What `invalidateQueries` does:**
1. Find all queries with the key `["tasks", workspaceId, projectId]`
2. Mark them as "stale" (out-of-date)
3. **Automatically refetch them**

So somewhere in the app, there's a hook doing:

```ts
const useGetTasks = (workspaceId: string, projectId: string) =>
  useQuery({
    queryKey: ["tasks", workspaceId, projectId],  // Same key!
    queryFn: () => getTasksQueryFn(workspaceId, projectId),
  });
```

When we invalidate `["tasks", workspaceId, projectId]`, React Query:
1. Fetches the tasks list again
2. Updates the cache
3. **All components subscribed to this query automatically re-render**

**DevTools check:** Install React Query DevTools browser extension. After creating a task:
1. Look at the cache tree
2. Find the `tasks` query
3. Watch it go from fresh → stale → refetching → fresh again
4. Watch the data change in the cache panel

---

## Step 8: The Component Re-render (What User Sees)

Now let's trace back to where tasks are displayed.

**File:** `client/src/components/workspace/task/task-table.tsx`

```tsx
function TaskTable({ workspaceId, projectId }: TaskTableProps) {
  // This hook subscribes to the cache
  const { data: tasks, isLoading, error } = useGetTasks(workspaceId, projectId);

  if (isLoading) return <Spinner />;
  if (error) return <ErrorState />;
  if (!tasks?.length) return <EmptyState />;

  return (
    <table>
      <thead>
        <tr>
          <th>Task Code</th>
          <th>Title</th>
          <th>Status</th>
          <th>Assigned To</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <TaskRow key={task._id} task={task} />  {/* Each task renders in a row */}
        ))}
      </tbody>
    </table>
  );
}
```

**What happens when cache is invalidated and refetches:**

1. `useGetTasks()` cache value changes
2. React detects the `data` prop changed
3. TaskTable re-renders
4. `.map()` runs again
5. New task object is now in the array
6. `<TaskRow>` renders with the new task
7. User sees the new row in the table

**Timeline:**
```
t=0ms:   User clicks submit
t=10ms:  API request sends
t=50ms:  Backend processes (database insert)
t=100ms: Backend responds with 201 + new task
t=110ms: onSuccess fires, invalidateQueries runs
t=120ms: Automatic refetch starts
t=180ms: GET /api/task/... response returns new task list
t=190ms: Cache updates
t=195ms: TaskTable re-renders
t=200ms: User sees new row in table
```

---

## Step 9: The Entire Component Tree Re-renders (Conceptually)

Let's trace what React does:

```
TaskBoard (state: isCreateDialogOpen = false)
    ↓ state changes to true
    ↓
Component re-renders
    ↓
<CreateTaskDialog /> mounts
    ↓ user fills form and submits
    ↓
mutate() called
    ↓ HTTP request fires
    ↓ (User waits ~100ms)
    ↓ response returns
    ↓
onSuccess fires
    ↓
queryClient.invalidateQueries()
    ↓
useGetTasks() cache updates
    ↓
TaskTable re-renders with new tasks
    ↓
Task row appears in table
    ↓
Dialog closes (onClose() called)
    ↓
isCreateDialogOpen = false
    ↓
<CreateTaskDialog /> unmounts
```

---

## The Complete Code Path (Reference)

Here's the exact file path for each step:

```
User clicks button
  ↓ [components/workspace/task/task-board.tsx]
  
Dialog opens, form renders
  ↓ [components/workspace/task/create-task-dialog.tsx]
  
Form validates locally
  ↓ [Zod schema defined in create-task-dialog.tsx]
  
User submits, onSubmit fires
  ↓ [useCreateTask hook]
  ↓ [hooks/api/use-create-task.tsx]
  
mutate() called with form data
  ↓ [createTaskQueryFn function]
  ↓ [lib/api.ts]
  
API.post() with axios
  ↓ [lib/axios-client.ts]
  ↓ [axios interceptors attach auth header]
  
HTTP POST request
  ↓ [Network: POST /api/task/workspace/.../create]
  ↓ [Backend receives and processes]
  ↓ [Backend returns 201 + new task]
  
onSuccess callback
  ↓ [hooks/api/use-create-task.tsx]
  
queryClient.invalidateQueries()
  ↓ [React Query cache marked stale]
  
Automatic refetch
  ↓ [useGetTasks() refetches]
  ↓ [lib/api.ts: getTasksQueryFn]
  ↓ [HTTP GET /api/task/...]
  ↓ [Backend returns task list with new task]
  
Cache updates
  ↓ [React Query cache updated]
  
TaskTable re-renders
  ↓ [components/workspace/task/task-table.tsx]
  ↓ [useGetTasks() hook gets new data]
  ↓ [tasks.map() includes new row]
  
New row renders
  ↓ [components/workspace/task/task-row.tsx]
  ↓ [<TaskRow task={newTask} />]
  
User sees new task in table ✓
```

---

## DevTools Walkthrough: Watch This Happen

**Before you create the task:**

1. Open DevTools → React tab
2. Find `TaskTable` component
3. Expand it, click the data prop
4. Count the tasks (e.g., 5 tasks)
5. Open React Query DevTools
6. Find the `tasks` query cache
7. Note the data

**Create a task:**

1. Click "Create Task"
2. Fill the form
3. Watch: `create-task-form.tsx` state updates as you type
4. Submit

**During the request:**

1. Network tab: watch POST request send
2. React Query DevTools: watch the `tasks` query go **stale** (grayed out)
3. Watch it **refetch** (spinner icon)

**After the response:**

1. Network tab: watch GET /tasks response return
2. React Query DevTools: watch cache update with new data
3. React tab: watch `TaskTable` re-render
4. Watch TaskTable's data prop now has 6 tasks instead of 5
5. **Look at the table: new row appears**

---

## What You've Learned (Summary)

By tracing this one flow, you've seen:

✓ **Components** — TaskBoard, CreateTaskDialog, TaskTable  
✓ **Local state** — react-hook-form's form state  
✓ **Validation** — Zod schema validation before submission  
✓ **Custom hooks** — useCreateTask, useGetTasks  
✓ **React Query** — mutations, queries, cache keys, invalidation  
✓ **API layer** — API functions in lib/api.ts  
✓ **Axios** — Authorization headers, interceptors  
✓ **HTTP** — POST request, GET refetch  
✓ **TypeScript** — types throughout (CreateTaskPayload, Task, etc.)  
✓ **Re-rendering** — how data changes trigger UI updates  
✓ **State management** — local UI state vs server state  

**That's most of what frontend is.**

---

## Now Do It Again (Different Feature)

Pick another feature and trace it:
- "Update task status"
- "Delete task"
- "Assign task to user"
- "Filter tasks by status"

By the third trace, you'll see the **same pattern every time**:

```
UI event
  ↓
Handler (useState or useMutation)
  ↓
API function
  ↓
HTTP request
  ↓
Response
  ↓
Cache update (if mutation)
  ↓
Component re-render
```

---



## What you need to understand first

Before React exists, the browser does this:

```html
<!-- index.html -->
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
```

1. Browser parses HTML → creates DOM tree
2. Browser downloads and runs JavaScript
3. JavaScript takes over

**Find this in AstriX:**
```
client/index.html
```

Open it. That's literally all that's there before React loads.

---

## The mental model: React is just JavaScript

Don't think: *"React is magic."*

Think: *"React is a library that manages the DOM based on state changes."*

When state changes:
```
old DOM → React compares → new DOM → browser renders
```

That's it. React is a **state-driven DOM updater**.

---

## How AstriX's entry point works

**File:** `client/src/main.tsx`

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryProvider>
      <NuqsAdapter>
        <App />
      </NuqsAdapter>
      <Toaster />
    </QueryProvider>
  </StrictMode>
);
```

Read this as **middleware layers**, not React boilerplate:

```
HTML root
    ↓
<StrictMode>           ← Catches mistakes (dev mode only)
    ↓
<QueryProvider>        ← Makes server-state management work for entire app
    ↓
<NuqsAdapter>         ← Makes URL-based state work for entire app
    ↓
<App />               ← Your actual application
    ↓
<Toaster />           ← Global notification system (sibling to App, not child)
```

**What this means:** These providers are like Express middleware. They sit at the application root. Every component below them can access their powers.

---

## First exercise: Watch it work

```bash
cd client
npm run dev
```

Open the browser console. Type:
```javascript
document.getElementById('root')
```

You'll see the DOM node. React owns this node. Everything inside it is React's responsibility.

**Done with Phase 1.** You now understand the browser foundation.

---

# PHASE 2: Understanding One Component Deeply (45 minutes)

## The simplest possible component

```tsx
function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded px-2 py-1">{children}</span>;
}

// Usage:
<Badge>Active</Badge>
```

This teaches three things at once:
1. **Component** = a function that returns JSX
2. **Props** = inputs to that function (`children`)
3. **TypeScript** = types describing those inputs

---

## Find this in AstriX

**File:** `client/src/components/ui/badge.tsx`

Open it. Notice:
- It's a function
- It takes `props` (TypeScript typed)
- It returns JSX (looks like HTML, but it's JavaScript)

This single file demonstrates the core React pattern. Everything else is variation.

---

## Now find a component that has state

**File:** `client/src/hooks/use-create-workspace-dialog.tsx`

This is a custom hook (explained in Phase 5), but notice the state pattern:

```tsx
const [open, setOpen] = useQueryState("new-workspace", parseAsBoolean.withDefault(false));
```

This is like:
```tsx
const [value, setValue] = useState(initialValue);
```

but backed by the URL instead of component memory.

---

## Understanding props and data flow

Find a component that uses a prop:

**File:** `client/src/components/workspace/task/task-card.tsx` (or similar)

It probably looks like:
```tsx
function TaskCard({ task }: { task: Task }) {
  return (
    <div>
      <h3>{task.title}</h3>
      <p>Status: {task.status}</p>
    </div>
  );
}
```

Notice: `task` comes from props. The component doesn't create it. A parent passes it.

**This is the fundamental rule:** Data flows downward through props.

```
Parent has data
    ↓
Parent passes to child via props
    ↓
Child receives it
    ↓
Child renders it
```

---

## TypeScript: Read types, don't memorize them

See this?
```tsx
{ task: Task }
```

That's a TypeScript **type annotation**. It says: *"task must be an object of type Task."*

Find where `Task` is defined:

**File:** `client/src/types/api.type.ts`

```ts
type Task = {
  _id: string;
  taskCode: string;
  title: string;
  status: TaskStatusEnumType;
  // ... more fields
};
```

TypeScript is just **self-documenting code**. It's saying: *"A Task has these properties."*

Don't memorize TypeScript. Just read types as documentation.

---

## Exercise for Phase 2

1. Open `components/ui/badge.tsx` and modify the returned `<span>` to add a `data-test="badge"` attribute
2. Open `components/workspace/task/task-card.tsx` (or similar task component) and trace where `task` comes from (look at the parent component that renders it)
3. In your browser, use the React Developer Tools extension to find a Badge component and inspect its props

**After this, you understand:**
- What a component is
- How props flow downward
- How TypeScript describes those props
- How to find types in the codebase

---

# PHASE 3: The Two Kinds of State (60 minutes)

## The critical distinction

**Local UI State** (component owns it)
```tsx
const [isOpen, setIsOpen] = useState(false);
```
Examples: modal open/closed, dropdown visible, form input value

**Server State** (backend owns it, frontend caches it)
```tsx
const { data: projects } = useQuery({
  queryKey: ["projects"],
  queryFn: getProjectsQueryFn
});
```
Examples: users, workspaces, tasks, projects

---

## Why this distinction matters

Look at the `<QueryProvider>` at the root of main.tsx.

It exists **because server state is fundamentally different from local state**.

With local state:
```tsx
const [count, setCount] = useState(0);  // I own this
setCount(1);                              // I update it directly
```

With server state:
```tsx
const { data: projects } = useQuery(...);  // Backend owns this
// I can't just do projects.name = "new";
// I have to:
// 1. Make HTTP request
// 2. Backend updates database
// 3. Response comes back
// 4. React Query updates cache
// 5. Component re-renders
```

**This is the most important distinction in modern frontend.**

---

## Find both in AstriX

### Local state example

**File:** `client/src/hooks/use-create-workspace-dialog.tsx`

```tsx
const [open, setOpen] = useQueryState("new-workspace", parseAsBoolean.withDefault(false));
```

This is a modal's open/closed state. The component owns it. When you click close, it immediately updates.

### Server state example

**File:** `client/src/hooks/api/use-get-workspace.tsx`

```tsx
const useGetWorkspaceQuery = (workspaceId: string) =>
  useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspaceByIdQueryFn(workspaceId),
    enabled: !!workspaceId
  });
```

This fetches a workspace from the backend. The hook doesn't own the data. It's a **cached read** from the server.

---

## The pattern AstriX uses everywhere

When you fetch:
```
useQuery() → API call happens → response enters cache → component subscribes to cache
```

When you mutate:
```
useMutation() → API call happens → onSuccess: invalidateQueries() → refetch → component re-renders
```

Find a mutation example:

**File:** `client/src/components/workspace/task/create-task-form.tsx` (or similar)

```tsx
const { mutate } = useMutation({
  mutationFn: createTaskMutationFn,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["tasks", workspaceId] });
  }
});
```

Read this as:
1. `mutate()` calls createTaskMutationFn
2. API request fires (POST)
3. If successful, invalidate the tasks cache
4. Cache refetches automatically
5. All components using that cache re-render

---

## Exercise for Phase 3

1. Find a component that uses `useState` and one that uses `useQuery`. Notice the difference in how they manage state.
2. Open React DevTools. Find a component that fetches data. Click around the cache tab and see how React Query stores data.
3. Modify a component: add a local `useState` for a dropdown toggle, then render it. Watch it work immediately when you interact with it.

**After this, you understand:**
- Local state vs server state
- Why QueryProvider exists at the app root
- How React Query caches server data
- The mutation → invalidate → refetch pattern

---

# PHASE 4: HTTP from the Frontend (45 minutes)

## The flow of an HTTP request in AstriX

When you click "Create Task":

```
User clicks
    ↓
Component handler fires
    ↓
Handler calls mutate()
    ↓
mutate() calls API function (from hooks/api/)
    ↓
API function lives in lib/api.ts
    ↓
API function uses axios to POST
    ↓
axios automatically adds Authorization header (from store)
    ↓
Backend receives request
    ↓
Backend processes, responds with 200 + new task
    ↓
onSuccess callback fires
    ↓
Cache invalidated
    ↓
Automatic refetch
    ↓
Component re-renders
    ↓
User sees new task in list
```

**That is the complete cycle. Everything else is details.**

---

## Find this in AstriX

### Step 1: The API function

**File:** `client/src/lib/api.ts`

This file has every API call. It's flat and explicit. For example:

```ts
export const createTaskQueryFn = async (payload: CreateTaskPayload) => {
  const { data } = await API.post(
    `/api/task/workspace/${payload.workspaceId}/project/${payload.projectId}/create`,
    payload
  );
  return data;
};
```

Read this as: *"POST to this endpoint, return the response."*

### Step 2: The mutation hook

**File:** `client/src/hooks/api/use-create-task.tsx` (or wherever it lives)

```tsx
export const useCreateTask = () =>
  useMutation({
    mutationFn: createTaskQueryFn,
    onSuccess: () => {
      // Invalidate cache, show toast, etc.
    }
  });
```

### Step 3: The component

**File:** `client/src/components/workspace/task/create-task-form.tsx`

```tsx
const { mutate, isPending } = useCreateTask();

const onSubmit = (data: CreateTaskFormData) => {
  mutate(data);  // This is the HTTP request firing
};
```

---

## Understanding the axios layer

**File:** `client/src/lib/axios-client.ts`

This is where HTTP headers are attached and error handling happens. For now, just know:

```ts
const API = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true  // cookies sent with each request
});
```

Every API call through `API.post()`, `API.get()`, etc. automatically includes authentication.

---

## Exercise for Phase 4

1. Find the "Create Task" button in the UI
2. Trace to the form component
3. Find the onSubmit handler
4. Find the useMutation hook it calls
5. Find the API function in lib/api.ts
6. Open DevTools Network tab and create a task. Watch the HTTP request happen.
7. Modify the API function to log the response: `console.log(data); return data;`
8. Create another task and watch the console log

**After this, you understand:**
- The complete HTTP request cycle
- Where API functions live
- How hooks wrap API functions
- How mutations work

---

# PHASE 5: Custom Hooks (The Domain Abstraction) (45 minutes)

## What is a custom hook?

A custom hook is a function that:
1. Uses React hooks (`useState`, `useEffect`, `useContext`, `useQuery`, etc.)
2. Returns something useful
3. Has a name starting with `use`

Example:
```tsx
function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  return width;
}
```

But the **important** custom hooks in AstriX are the ones in `hooks/api/`.

---

## The power of custom hooks: Domain abstraction

Imagine without custom hooks:

```tsx
function ProjectPage() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/projects')
      .then(res => res.json())
      .then(data => {
        setProjects(data);
        setLoading(false);
      })
      .catch(e => {
        setError(e);
        setLoading(false);
      });
  }, []);

  if (loading) return <Spinner />;
  if (error) return <Error />;
  return <ProjectList projects={projects} />;
}
```

Now with custom hooks:

```tsx
function ProjectPage() {
  const { data: projects, isLoading, error } = useGetProjects();

  if (isLoading) return <Spinner />;
  if (error) return <Error />;
  return <ProjectList projects={projects} />;
}
```

The hook **hides the complexity**.

---

## How AstriX organizes custom hooks

**Directory:** `client/src/hooks/api/`

Each file handles one resource:

- `use-auth.tsx` → current user
- `use-get-workspace.tsx` → fetch workspace
- `use-create-task.tsx` → create task mutation
- `use-get-tasks.tsx` → fetch tasks
- etc.

**File:** `client/src/hooks/api/use-get-tasks.tsx`

```tsx
export const useGetTasksQuery = (
  workspaceId: string,
  projectId: string
) =>
  useQuery({
    queryKey: ["tasks", workspaceId, projectId],
    queryFn: () => getTasksQueryFn(workspaceId, projectId),
    enabled: !!workspaceId && !!projectId
  });
```

Read this as: *"I provide a typed hook that fetches tasks. The component doesn't need to know about React Query or HTTP. It just calls this hook."*

---

## The three layers of abstraction

```
Component
    ↓
useGetTasks()              [hooks/api/use-get-tasks.tsx]
    ↓
getTasksQueryFn()          [lib/api.ts]
    ↓
API.get('/api/tasks/...')  [lib/axios-client.ts]
    ↓
HTTP request
    ↓
Backend
```

Each layer has a specific job:
- **Component:** "I need tasks"
- **Hook:** "React Query manages fetching and caching"
- **API function:** "Here's the endpoint and payload"
- **Axios:** "Here's the HTTP infrastructure"

---

## Exercise for Phase 5

1. Open `hooks/api/use-get-workspace.tsx`
2. Trace the `queryKey` — what does it do? (Hint: it's the cache key)
3. Trace the `queryFn` — where does it come from?
4. Open the API function it references in `lib/api.ts`
5. Find a component that calls this hook
6. Modify the component to add `console.log('Workspace:', data)`
7. In the browser, navigate and watch the log fire when the workspace is fetched

**After this, you understand:**
- What custom hooks are
- How they abstract complexity
- The three-layer pattern: component → hook → API
- How React Query integration works

---

# PHASE 6: Routing (The Application Control Flow) (60 minutes)

## Routing is application control flow

In backend, you have:
```
GET /users           → UsersController.list()
GET /users/:id       → UsersController.show()
POST /users          → UsersController.create()
```

In frontend, you have:
```
/                    → HomePage
/login               → LoginPage
/workspace/:id       → WorkspacePage
/workspace/:id/p/:id → ProjectPage
```

But there's a twist: **routes can have guards**.

```
/public              → accessible to anyone
/login               → accessible only if NOT authenticated
/workspace/:id       → accessible only if authenticated
```

---

## Find routing in AstriX

**File:** `client/src/routes/index.tsx`

This is the route tree. It's complex because it handles all three cases:

```tsx
<BrowserRouter>
  <Routes>
    {/* PUBLIC ROUTES */}
    <Route element={<BaseLayout />}>
      {baseRoutePaths.map(...)}
    </Route>

    {/* AUTH ROUTES (login/signup) - guarded to hide from logged-in users */}
    <Route path="/" element={<AuthRoute />}>
      <Route element={<BaseLayout />}>
        {authenticationRoutePaths.map(...)}
      </Route>
    </Route>

    {/* PROTECTED ROUTES - guarded to hide from unauthenticated users */}
    <Route path="/" element={<ProtectedRoute />}>
      <Route element={<AppLayout />}>
        {protectedRoutePaths.map(...)}
      </Route>
    </Route>
  </Routes>
</BrowserRouter>
```

Read this as three separate route trees:
1. Public (always accessible)
2. Auth pages (login/signup, guarded to redirect logged-in users away)
3. Protected (workspace, projects, tasks, guarded to redirect unauthenticated users)

---

## Guards (The middleware)

### Unauthenticated guard

**File:** `client/src/routes/auth.route.tsx`

```tsx
export const AuthRoute = () => {
  const { data: authData, isLoading } = useAuth();
  
  if (isLoading) return <DashboardSkeleton />;
  
  // If already logged in, redirect to workspace
  if (authData?.user) {
    return <Navigate to={`/workspace/${authData.user.currentWorkspace?._id}`} replace />;
  }
  
  // If not logged in, allow login/signup
  return <Outlet />;
};
```

Think of this as Express middleware:
```ts
app.get('/login', (req, res, next) => {
  if (req.user) res.redirect('/dashboard');
  else next();  // Allow the route
});
```

### Authenticated guard

**File:** `client/src/routes/protected.route.tsx`

```tsx
export const ProtectedRoute = () => {
  const { data: authData, isLoading } = useAuth();
  
  if (isLoading) return <DashboardSkeleton />;
  
  // If not logged in, redirect to login
  if (!authData?.user) {
    return <Navigate to="/login" replace />;
  }
  
  // If logged in, allow the route
  return <Outlet />;
};
```

Again, like Express:
```ts
app.get('/dashboard', (req, res, next) => {
  if (!req.user) res.redirect('/login');
  else next();  // Allow the route
});
```

---

## Layouts (The UI shell)

After guards pass, you enter a layout.

**Public layout file:** `client/src/layout/base.layout.tsx`

```tsx
export const BaseLayout = () => {
  return (
    <div>
      <Header />
      <main>
        <Outlet />  {/* The page renders here */}
      </main>
      <Footer />
    </div>
  );
};
```

**Protected layout file:** `client/src/layout/app.layout.tsx`

```tsx
export const AppLayout = () => {
  return (
    <SidebarProvider>
      <AsideBar />  {/* Workspace switcher, navigation */}
      <SidebarInset>
        <Header />
        <main>
          <Outlet />  {/* The page renders here */}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
```

Notice: `<Outlet />` is where the specific page (e.g., ProjectPage) renders.

---

## The complete flow

When you visit `/workspace/123/project/456`:

```
User visits URL
        ↓
React Router matches route
        ↓
ProtectedRoute guard runs
        ↓
useAuth() hook checks if user exists
        ↓
If authenticated, render AppLayout
        ↓
AppLayout renders <Outlet />
        ↓
Outlet renders ProjectPage component
        ↓
ProjectPage fetches project #456
        ↓
User sees the page
```

---

## Exercise for Phase 6

1. Open `routes/index.tsx` and find a route definition
2. Navigate to `/login` in your browser
3. Open React DevTools and expand the component tree
4. You should see: `<BrowserRouter>` → `<Routes>` → `<AuthRoute>` → `<BaseLayout>` → `<LoginPage>`
5. Now navigate to a protected route (like `/workspace/...`)
6. Inspect the component tree again
7. You should see: `<ProtectedRoute>` → `<AppLayout>` → the actual page
8. Try visiting `/workspace/...` while logged out (clear cookies or open in incognito). You should be redirected to `/login`.

**After this, you understand:**
- How routing works as control flow
- What guards do
- What layouts do
- The complete request flow from URL to rendered component

---

# PHASE 7: Context (Sharing Values Across Components) (30 minutes)

## The problem Context solves

Suppose you have:

```
App
 ├── Header
 │    ├── UserProfile
 │    └── Notifications
 └── Sidebar
      └── UserPreferences
```

All three need the logged-in user.

**Without Context:**
```tsx
<App user={user}>
  <Header user={user}>
    <UserProfile user={user} />
    <Notifications user={user} />
  </Header>
  <Sidebar user={user}>
    <UserPreferences user={user} />
  </Sidebar>
</App>
```

Every level has to accept `user` as a prop even if it doesn't use it. **Prop drilling.**

**With Context:**
```tsx
<AuthProvider>
  <App />
</AuthProvider>

// Deep inside any component:
const { user } = useAuthContext();
```

---

## How AstriX implements Context

**File:** `client/src/context/auth-provider.tsx` (or wherever it is)

```tsx
const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const { data: authData } = useAuth();  // Fetches current user

  return (
    <AuthContext.Provider value={{ user: authData?.user, ...more }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuthContext = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuthContext must be used inside AuthProvider');
  return context;
};
```

**Key points:**
1. Create context with `createContext()`
2. Create a Provider component that wraps children
3. Provide a custom hook `useAuthContext()` that consumes it
4. Put the Provider at the root (or wherever you want the value available)

---

## Where is AuthProvider used?

**File:** `client/src/layout/app.layout.tsx` (or main.tsx)

```tsx
<AuthProvider>
  <AppLayout>
    <Outlet />
  </AppLayout>
</AuthProvider>
```

Now every component inside AppLayout can use:
```tsx
const { user } = useAuthContext();
```

---

## Important: Context is not a store

Many beginners think Context = Zustand = Redux = "global state."

**Wrong.**

Context is a way to **make a value available to a subtree** without passing it as props.

It's dependency injection, not global state.

AstriX uses Context only for the user/auth data because:
1. It's small (doesn't change often)
2. Many components need it
3. It's read-only from most components

Server state (projects, tasks) lives in React Query, not Context, because:
1. It changes frequently
2. Only specific components need it
3. React Query handles caching and synchronization

---

## Exercise for Phase 7

1. Find `AuthProvider` in the codebase
2. Find where it's wrapped around components
3. Find a component that calls `useAuthContext()`
4. Modify that component to `console.log(user)` when user changes
5. Log in and out, watch the log

**After this, you understand:**
- What Context is
- Why AstriX uses it for auth
- How to consume Context with a hook
- That Context ≠ global state

---

# PHASE 8: TypeScript for Frontend (45 minutes)

## TypeScript as documentation

You've already seen types in Phase 2. Now understand them as **self-documenting code**.

### API Response Types

**File:** `client/src/types/api.type.ts`

```ts
type Task = {
  _id: string;
  taskCode: string;
  title: string;
  status: TaskStatusEnumType;
  priority: PriorityEnumType;
  assignedTo: User | null;
  createdAt: string;
};
```

This says: *"A Task from the API has these properties with these types."*

You're not memorizing this. You're reading it.

### Component Prop Types

```tsx
type TaskCardProps = {
  task: Task;
  onStatusChange?: (status: TaskStatusEnumType) => void;
};

function TaskCard({ task, onStatusChange }: TaskCardProps) {
  // Now TypeScript knows task.title exists
  // And it knows onStatusChange is optional
  return <div>{task.title}</div>;
}
```

TypeScript catches mistakes:
```tsx
<TaskCard task={project} />  // ❌ ERROR: project is not a Task
<TaskCard task={task} onStatusChange={notAFunction} />  // ❌ ERROR: onStatusChange must be a function
```

---

## Common TypeScript patterns in AstriX

### Optional properties

```ts
type Task = {
  assignedTo?: User;  // May be null/undefined
};

task.assignedTo?.name  // Safe: only accesses name if assignedTo exists
```

### Union types (multiple possibilities)

```ts
type TaskStatus = "todo" | "in-progress" | "done";

// Not allowed: task.status = "invalid"
// Allowed: task.status = "todo"
```

### Function types

```ts
type OnChangeHandler = (value: string) => void;

// Calling it:
const handleChange: OnChangeHandler = (value) => console.log(value);
```

### Event types (React-specific)

```tsx
function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
  console.log(event.target.value);  // TypeScript knows target has value
}

<input onChange={handleChange} />
```

---

## The discipline: Types describe contracts

When you see:

```tsx
function useGetTasks(workspaceId: string): UseQueryResult<Task[], Error> {
  // ...
}
```

You know:
- Input: `workspaceId` must be a string
- Output: a React Query result that either has `Task[]` data or an `Error`

You don't have to read the implementation. The type signature is a contract.

---

## Exercise for Phase 8

1. Find `api.type.ts`
2. Find the `Task` type
3. Open a component that uses Task
4. Modify the component to access a property that doesn't exist: `task.fakeProperty`
5. Watch TypeScript complain with a red underline
6. Fix it
7. Now modify the component to access `task.assignedTo.name` (if assignedTo might be null)
8. Watch TypeScript warn about potential null access
9. Fix it with optional chaining: `task.assignedTo?.name`

**After this, you understand:**
- Types describe contracts
- TypeScript catches mistakes at edit time
- Optional chaining (`?.`) handles null values
- Union types limit possibilities

---

# The Complete Picture: How It All Works Together

Now that you understand each piece, here's how they fit:

```
index.html
    ↓
main.tsx (Providers: QueryProvider, NuqsAdapter, etc.)
    ↓
App.tsx (just routes)
    ↓
routes/index.tsx (route definitions with guards)
    ↓
ProtectedRoute (checks if user is authenticated)
    ↓
AppLayout (renders sidebar + header + <Outlet />)
    ↓
ProjectPage (fetches project, renders components)
    ↓
TaskTable (renders task rows)
    ↓
TaskCard (renders individual task)
    │
    └─> Task comes from props
         TaskCard calls onClick handler
         Handler calls useMutation hook
         Hook calls API function from lib/api.ts
         API function POSTs to backend
         onSuccess invalidates cache
         Cache refetches
         TaskCard re-renders
         User sees updated task
```

Every flow in AstriX follows this pattern:
```
User Action
    ↓
Event Handler
    ↓
State change or HTTP request
    ↓
Component re-renders
    ↓
User sees new UI
```

---

# How to Read AstriX Now

**Stop reading folders.** Start reading flows.

Pick one user action. Trace it completely.

## Example: Creating a task

1. Find the "Create Task" button in the UI
2. Open that component
3. Find the onClick/onSubmit handler
4. Follow it to the `useMutation` hook
5. Follow to the API function in `lib/api.ts`
6. Follow the endpoint to the backend (Backend Architecture doc)
7. Follow the response back to the component
8. Follow the cache invalidation
9. Watch the TaskTable re-render

By tracing that one flow, you've seen:
- Components
- Event handlers
- Hooks
- API functions
- HTTP
- React Query mutations
- Cache invalidation
- Re-rendering

**That is frontend.** Everything else is variation.

---

# The Debugging Checklist

Whenever something doesn't work, ask these seven questions:

### 1. Does the component render?
Use React DevTools. Can you find the component in the tree?

### 2. Do the props make sense?
Select the component in DevTools. Check the props panel. Are the values correct?

### 3. Does the state update?
Add `console.log` to state changes. Did it fire? What value changed?

### 4. Is the HTTP request firing?
Open DevTools Network tab. Do you see the API call? What status code? What response?

### 5. Is the cache updating?
Open React Query DevTools (install the browser extension). After mutation, does the cache key show updated data?

### 6. Is the component subscribed to the cache?
Does the component use the same `queryKey` as the invalidation? If not, it won't re-render.

### 7. Is TypeScript complaining?
If your IDE shows red squigglies, read the error. It's telling you exactly what's wrong.

**Most bugs are one of those seven things.**

---

# Practical Exercises: Build Skills

### Exercise 1: Add a new field to an entity (15 min)

Goal: Display workspace member count on the workspace card.

1. Add a `memberCount` field to the Workspace type in `api.type.ts`
2. Find the component that displays a workspace card
3. Display `memberCount` in that component
4. Check DevTools to see if the API is returning that field
5. If not, look at the backend to verify it's being sent

### Exercise 2: Create a new query hook (30 min)

Goal: Create a hook `useGetWorkspaceMembers(workspaceId)` that fetches members.

1. Create `client/src/hooks/api/use-get-members.tsx`
2. Use the pattern from `use-get-tasks.tsx`
3. Point it to a backend endpoint (ask your backend team)
4. Use it in a component: `const { data: members } = useGetWorkspaceMembers(workspaceId)`
5. Display the list

### Exercise 3: Add a form with validation (45 min)

Goal: Add an "Update Task Status" form.

1. Find a component that shows a task detail
2. Add a dropdown with status options
3. Wrap it in a form (you probably already have react-hook-form + zod)
4. On submit, call a mutation (create `useUpdateTask` if it doesn't exist)
5. Watch the cache invalidate and re-render

### Exercise 4: Add a new route (30 min)

Goal: Add a Settings page.

1. Create `client/src/page/workspace/settings.tsx`
2. Add route definition in `routes/index.tsx`
3. Link to it from the sidebar
4. Verify the guard allows authenticated users
5. Fetch some settings data and display it

### Exercise 5: Break something, then fix it (60 min)

Goal: Understand the flow by breaking it deliberately.

1. Comment out the `queryKey` in a useQuery hook
2. Watch what breaks
3. Fix it
4. Remove the API function entirely and use `fetch()` directly instead
5. Watch what breaks (React Query features disappear)
6. Fix it back
7. Comment out the `onSuccess: invalidateQueries` in a mutation
8. Perform a mutation and watch the cache not update
9. Notice the UI doesn't update either
10. Fix it

These exercises are more valuable than reading 20 tutorials.

---

# Quick Reference: Where to Find Things

```
ENTRY POINT
  ↓
client/index.html
client/src/main.tsx (providers)
client/src/App.tsx (routing)

ROUTING
  ↓
client/src/routes/index.tsx (route tree)
client/src/routes/protected.route.tsx (auth guard)
client/src/routes/auth.route.tsx (login guard)

LAYOUT
  ↓
client/src/layout/app.layout.tsx (authenticated shell)
client/src/layout/base.layout.tsx (public shell)

PAGES
  ↓
client/src/page/ (organized by feature)

COMPONENTS
  ↓
client/src/components/ui/ (reusable primitives)
client/src/components/workspace/ (domain components)

HOOKS
  ↓
client/src/hooks/api/ (server state: useQuery/useMutation)
client/src/hooks/ (local state: dialogs, tables, etc.)

STATE
  ↓
client/src/context/ (auth context)
client/src/store/ (Zustand auth token store)

API
  ↓
client/src/lib/api.ts (all API functions, flat)
client/src/lib/axios-client.ts (HTTP configuration)

TYPES
  ↓
client/src/types/api.type.ts (API response types)

CONSTANTS
  ↓
client/src/constant/ (enum mirrors, config)
```

---

# The Mindset Shift

Before learning React, you probably thought:
> "I need to learn React. I need to learn JavaScript. I need to learn TypeScript."

After this guide, think:
> "I need to trace data and events through a distributed system. React/TypeScript/hooks are just the tools."

Frontend becomes manageable the moment you stop seeing it as a pile of components and start seeing it as a data-flow system.

```
User interacts
    ↓
Data changes
    ↓
Component subscribes to data
    ↓
Component re-renders
    ↓
User sees new UI
```

That's the entire loop. Everything else is details.

---

# Pattern Recognition: The 5 Patterns You'll See Everywhere in AstriX

Once you understand these patterns, you can read any file in AstriX:

---

## Pattern 1: The Query Hook (Fetching data from server)

**Where you'll see it:** Every component that displays data from the backend

```tsx
// File: hooks/api/use-get-SOMETHING.tsx

export const useGetSomething = (id: string) =>
  useQuery({
    queryKey: ["something", id],           // Cache key
    queryFn: () => getSomethingQueryFn(id), // API function from lib/api.ts
    enabled: !!id,                          // Only fetch if id exists
  });

// Usage:
const { data: something, isLoading, error } = useGetSomething(workspaceId);
```

**Pattern recognition:** See `useQuery`? It fetches and caches. Always finds the API function in `lib/api.ts`.

---

## Pattern 2: The Mutation Hook (Creating/updating/deleting)

**Where you'll see it:** Every form submission

```tsx
// File: hooks/api/use-create-SOMETHING.tsx

export const useCreateSomething = () =>
  useMutation({
    mutationFn: createSomethingQueryFn,           // API function
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["somethings"],                 // Cache to invalidate
      });
      toast.success("Created!");
    },
  });

// Usage:
const { mutate, isPending } = useCreateSomething();
mutate(data);
```

**Pattern recognition:** See `useMutation` + `invalidateQueries`? It's POST/PUT/DELETE + automatic refetch.

---

## Pattern 3: The Form Component (Collecting user input)

**Where you'll see it:** Every dialog/page with a form

```tsx
// File: components/workspace/task/create-task-form.tsx (or similar)

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

const schema = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "in-progress", "done"]),
  // ...
});

function TaskForm() {
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { title: "", status: "todo" },
  });

  const { mutate } = useCreateTask();

  const onSubmit = (data) => {
    mutate(data);  // Send to server
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FormField name="title" ... />
      <FormField name="status" ... />
      <button type="submit">Submit</button>
    </form>
  );
}
```

**Pattern recognition:** See `useForm()` + `zodResolver()`? Local validation before sending to server.

---

## Pattern 4: The Data Display Component (Showing server data)

**Where you'll see it:** Tables, lists, cards

```tsx
// File: components/workspace/task/task-table.tsx (or similar)

function TaskTable({ workspaceId, projectId }: Props) {
  const { data: tasks, isLoading, error } = useGetTasks(workspaceId, projectId);

  if (isLoading) return <Spinner />;
  if (error) return <ErrorState />;
  if (!tasks?.length) return <EmptyState />;

  return (
    <table>
      <tbody>
        {tasks.map((task) => (
          <TaskRow key={task._id} task={task} />
        ))}
      </tbody>
    </table>
  );
}
```

**Pattern recognition:** See `useGetTasks()` + loading/error/empty states? It's a safe data display pattern.

---

## Pattern 5: The Guard Component (Access control)

**Where you'll see it:** Routes

```tsx
// File: routes/protected.route.tsx

function ProtectedRoute() {
  const { data: authData, isLoading } = useAuth();

  if (isLoading) return <Spinner />;
  if (!authData?.user) return <Navigate to="/login" />;

  return <Outlet />;
}
```

**Pattern recognition:** See `useAuth()` + conditional redirect? It's checking if user is logged in.

---

## Pattern 6: The API Function (Making HTTP requests)

**Where you'll see it:** `lib/api.ts`

```ts
// File: lib/api.ts

export const getSomethingQueryFn = async (id: string) => {
  const { data } = await API.get(`/api/something/${id}`);
  return data;
};

export const createSomethingQueryFn = async (payload: Payload) => {
  const { data } = await API.post(`/api/something`, payload);
  return data;
};
```

**Pattern recognition:** See `API.get/post/put/delete`? It's the HTTP layer. Check the endpoint to understand what it does.

---

## Put It Together: Full Feature Pattern

Every feature in AstriX follows this exact structure:

```
Component that displays data
    ↓
useGetSomething() hook
    ↓
getSomethingQueryFn()
    ↓
API.get()
    ↓
Backend returns data
    ↓
Cache stores it
    ↓
Component re-renders

---

Component with form
    ↓
useCreateSomething() hook
    ↓
createSomethingQueryFn()
    ↓
API.post()
    ↓
Backend returns created entity
    ↓
onSuccess: invalidateQueries
    ↓
Cache refetches
    ↓
Component re-renders
```

**That's every feature. Every single one.**

Once you see this pattern, you can navigate any file in AstriX because you know where to look:
- Seeing a component? Check what hook it uses
- Seeing a hook? Find the queryFn in lib/api.ts
- Seeing an API function? Follow the endpoint

---

# What's Next

After this guide:

1. **Stop reading, start modifying.** Pick any component and change it. Watch it work.
2. **Break things deliberately.** Comment out a line, see what breaks, understand why, fix it.
3. **Read backend code.** Follow API calls to the backend. Understand what each endpoint does.
4. **Read other components.** Find a component you don't understand. Use the debugging checklist.
5. **Contribute a feature.** Implement something small end-to-end: add a field, create an entity, build a form.

---

# The One Rule

**Whenever you're confused by a file, don't try to understand the file. Trace one piece of data through the system.**

If you don't understand a component, trace what data it displays. Where does that data come from? Follow it upward. Keep asking "where does this come from?" until you reach either:
- A hook (follow the hook)
- Context (follow the provider)
- Props (follow the parent)
- Hardcoded (it's local)

At the end, you'll have traced the entire data flow. That's understanding.

Frontend isn't magic. It's just data flowing through a system.

---

## Final Exercise: Build a Feature End-to-End

**Goal:** Add a "task priority" filter to the task table (if it doesn't exist).

**Steps:**
1. Find the task table component
2. Find where filters are currently handled (status, assignee, etc.)
3. Add a priority filter using the same pattern
4. Modify the API call to filter by priority
5. Add UI to select priority
6. Watch the table re-filter in real-time

This single exercise will touch:
- Components
- Props
- URL state (nuqs)
- Hooks
- React Query
- API functions
- TypeScript
- Event handlers
- Conditional rendering

Do this, and you've learned frontend.

---

**Good luck. You've got this.**

The fact that you're frustrated means you're ready to learn. Use this guide to trace, not to memorize. Every time you trace a flow, you get faster and more confident.

After your fifth trace, frontend stops being scary.





# AstriX — Deep Frontend Architecture 

This document is written the way you should actually *read* this client — not folder by folder, but as one continuous runtime flow, traced through real code pulled directly from `client/src`. If you already know backend, the fastest way to stop being intimidated by this codebase is to stop thinking "I need to learn React" and start thinking "this is a distributed system with the browser as one of the nodes." Every example below is the actual code in this repository, not a hypothetical.

---

## 1. First mental model: frontend is not "UI"

The wrong first question is "what does this component do?" The right first question is **"what is the actual runtime flow, top to bottom?"** For AstriX: `client/index.html` → `src/main.tsx` → `App.tsx` → `routes/` → whichever page is being rendered. `main.tsx` is the composition root — read it first, always, and read it exactly as written:

```tsx
// client/src/main.tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryProvider>
      <NuqsAdapter>
        <App />
      </NuqsAdapter>
      <Toaster />
    </QueryProvider>
  </StrictMode>
);
```

Don't read this as React boilerplate. Read it in backend terms: these are **application-level middleware**, mounted once, providing infrastructure to everything below. `QueryProvider` (wrapping `@tanstack/react-query`'s `QueryClientProvider`) provides server-state infrastructure to every descendant. `NuqsAdapter` provides URL-as-state infrastructure. `Toaster` is a globally-mounted notification service, sitting as a sibling to `App`, not a child — meaning a toast can fire from anywhere in the tree without needing to be threaded through props. `App` is the actual application. That one shift in perspective is most of what makes frontend stop being mysterious.

---

## 2. The first building block: HTML → DOM → JavaScript

Before React, understand what the browser actually does. `client/index.html` contains:

```html
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
```

The browser builds a DOM tree, executes the module script, and React takes ownership of the `#root` node:

```tsx
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
```

Mentally:
```
HTML → DOM → JavaScript loads → React builds a component tree
  → React renders into the DOM → user interacts → state changes
  → React renders again
```
Once this is intuitive, `main.tsx` stops being mysterious — it's just "the one place this whole cycle gets kicked off."

---

## 3. Then learn one component extremely deeply — using a real one, not a toy example

Don't jump into Context, TanStack Query, routing, forms, HOCs. AstriX's own `components/ui/` folder (the vendored shadcn/Radix primitives) is full of components simple enough to read in isolation before you ever touch `components/workspace/`. Take a stripped-down version of the shape you'll see everywhere:

```tsx
function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full px-2 py-0.5 text-xs">{children}</span>;
}
```
That's a component and `children` composition, together. Then a real one with actual state, from `hooks/use-create-workspace-dialog.tsx`'s pattern:
```tsx
const [open, setOpen] = useQueryState("new-workspace", parseAsBoolean.withDefault(false));
```
This *looks* like `useState`, and behaves like it from the component's point of view — but it's backed by the URL, not component memory (§14 explains why that distinction matters here specifically, not just in the abstract). Seeing the *shape* of state management before the *mechanism* is what makes the mechanism click later.

---

## 4. The most important direction in this client: data flows downward

```
App
 └── AppLayout
      ├── AsideBar (workspace-switcher, nav)
      └── <Outlet/>  →  page (e.g. project detail page)
           ├── ProjectHeader
           └── TaskTable
                └── TaskCard (per row)
```
A parent owns or fetches data; a child receives it as props. This is the fundamental React direction:
```
state/query → parent → props → child → render
```
When you don't recognize a value in a component, **trace upward**, exactly like tracing a variable's origin through call stacks in a backend service. If `TaskCard` renders `task.title`, find where `task` comes from — a prop from `TaskTable`? Go up one level. If `TaskTable` gets it from `useQuery({ queryKey: ["all-tasks", workspaceId], queryFn: getAllTasksQueryFn })` (the real hook shape used throughout `hooks/api/`), follow the query function into `lib/api.ts`, and you've reached the API boundary. This is frontend's version of distributed data-flow tracing, and it's the single most useful habit for reading any file in this repo you don't recognize yet.

---

## 5. The difference between UI state and server state — the most important idea in this codebase

| | Local UI state | Server state |
|---|---|---|
| Lives in | `useState` in the component | The backend's MongoDB |
| Examples in AstriX | is a dialog open, which table row is being edited, raw form input before submit | `user`, `workspace`, `members`, `projects`, `tasks` |
| Frontend's relationship to it | owns it | holds a **cached representation**, not ownership |

This distinction is *why* `QueryProvider` sits at the application root (§1) — it's the caching/synchronization layer for the right-hand column, and nothing in this codebase reaches for `useState` to hold something that actually lives on the backend. Once this is automatic, opening any file and seeing a `useQuery` call immediately tells you: *this component doesn't own this data, the backend does, and this hook is a synchronized read from a shared cache.*

```
LOCAL STATE                    SERVER STATE
useState() → component         Backend → HTTP → TanStack Query → Component
```

---

## 6. HTTP from the frontend's side, in AstriX's actual client

A click:
```tsx
// components/workspace/task/create-task-form.tsx (real pattern)
const { mutate, isPending } = useMutation({ mutationFn: createTaskMutationFn });
```
eventually causes:
```
POST /api/task/workspace/:workspaceId/project/:projectId/create
```
and the backend responds with the created task. The frontend then has to decide: where does this result go, what does loading look like, what if it fails, does existing data need refetching? In AstriX, the answer is consistently the same pattern (§17 goes deeper):
```
mutate() → onSuccess → queryClient.invalidateQueries(["all-tasks", workspaceId]) → refetch → re-render
```
For every API call in this client, train yourself to trace: **UI event → handler → hook (`hooks/api/*`) → `lib/api.ts` function → axios → backend endpoint → response → cache update → re-render.** This is the single most valuable debugging skill for this codebase.

---

## 7. Read this client vertically, not horizontally

Don't open `components/` and start reading 119 files in folder order. Pick one user journey — login → workspace → project → task — and trace the application:
```
main.tsx → App.tsx → routes → auth/protected guard → layout → page → component → hook → API
```
`App.tsx` is deliberately tiny:
```tsx
// client/src/App.tsx — the whole file
import AppRoutes from "./routes";
function App() { return <AppRoutes />; }
export default App;
```
That tells you immediately: **routing determines what screen exists**, and nothing else happens at this level. `routes/` itself separates three concerns (§8), which is your next stop.

---

## 8. Routing as application control flow, not just navigation

A backend developer already knows `GET /projects`, `POST /projects`, `GET /projects/:id` map to controllers. Frontend routing is the same idea, mapping **URLs to component trees** instead:
```
/sign-in                                     → Sign-in page (public)
/workspace/:workspaceId                       → WorkspacePage (protected)
/workspace/:workspaceId/project/:projectId    → ProjectPage (protected)
```
But there's a layer before that mapping applies at all — this is the real code, from `routes/index.tsx`:
```tsx
<BrowserRouter>
  <Routes>
    <Route element={<BaseLayout />}>{baseRoutePaths.map(...)}</Route>          {/* public */}

    <Route path="/" element={<AuthRoute />}>                                    {/* guard */}
      <Route element={<BaseLayout />}>{authenticationRoutePaths.map(...)}</Route>
    </Route>

    <Route path="/" element={<ProtectedRoute />}>                                {/* guard */}
      <Route element={<AppLayout />}>{protectedRoutePaths.map(...)}</Route>
    </Route>
  </Routes>
</BrowserRouter>
```
Routing here isn't just navigation — it's control flow, with an explicit authenticated/unauthenticated branch baked into the route tree itself, the same way you'd branch on `req.isAuthenticated()` in Express middleware before ever reaching a controller.

---

## 9. Guards — the actual "is the user allowed here?" logic

```tsx
// routes/protected.route.tsx
const ProtectedRoute = () => {
  const { data: authData, isLoading } = useAuth();          // useQuery wrapping GET /user/current
  if (isLoading) return <DashboardSkeleton />;
  return authData?.user ? <Outlet /> : <Navigate to="/sign-in" replace />;
};
```
```tsx
// routes/auth.route.tsx — the inverse: bounce an already-logged-in user away from /sign-in
const AuthRoute = () => {
  const { data: authData, isLoading } = useAuth();
  if (isLoading && !isAuthRoute(location.pathname)) return <DashboardSkeleton />;
  if (!authData?.user) return <Outlet />;
  return <Navigate to={`workspace/${authData.user.currentWorkspace?._id}`} replace />;
};
```
Read `ProtectedRoute` as **middleware for the UI**, not a special React concept — it's the exact same shape as an Express `isAuthenticated` middleware sitting in front of a router, except it redirects to a *screen* instead of returning a 401 JSON body.

---

## 10. Layouts — where the chrome lives, separate from the screen

Every authenticated AstriX page has the same shell: sidebar + top area + main content. You don't duplicate that markup per page — it lives once, in `layout/app.layout.tsx`:
```tsx
function AppLayout() {
  return (
    <SidebarProvider>
      <AsideBar />
      <SidebarInset>
        <Header />
        <main><Outlet /></main>       {/* the actual page renders here */}
      </SidebarInset>
    </SidebarProvider>
  );
}
```
The layout owns the chrome; the page owns the screen-specific content. `BaseLayout` is the unauthenticated equivalent (used for the landing page and sign-in/sign-up) — two layouts, matched to the two route trees from §8/§9.

---

## 11. Components — stop thinking "reusable code," start thinking "responsibility"

A component isn't automatically good because it's reusable. Ask: **what UI responsibility does this file encapsulate?** AstriX's actual task-board shape:
```
ProjectPage
 ├── ProjectHeader
 ├── (project analytics)
 └── TaskTable
      ├── columns.tsx           (column definitions)
      ├── table.tsx              (the table shell)
      ├── table-column-header.tsx (sortable headers)
      ├── table-faceted-filter.tsx (status/priority multi-select)
      ├── table-pagination.tsx
      └── table-row-actions.tsx  (per-row dropdown)
```
Each file has exactly one job. When you open `components/workspace/`, don't ask "why so many files" — ask "what responsibility does each one own," the same question you'd ask of a well-decomposed backend service layer.

---

## 12. `children` and composition — dependency injection for UI

```tsx
function Card({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>;
}
```
allows:
```tsx
<Card><h2>Project</h2><p>Description</p></Card>
```
Backend equivalent: `class Service { constructor(repository) {} }` — the parent (`Card`) defines structure, the child supplies content, exactly like constructor injection defines a dependency slot that's filled from outside. AstriX's entire `components/ui/` layer (Dialog, Form, DropdownMenu, Popover) is built on this — every one is a **compound component**: a parent that implicitly shares context with named children (`<DialogTrigger>`, `<DialogContent>`, `<DialogHeader>`) rather than taking a dozen boolean props. Real usage, from the task-creation flow:
```tsx
<Dialog open={open} onOpenChange={onClose}>
  <DialogContent>
    <DialogHeader><DialogTitle>Create Task</DialogTitle></DialogHeader>
    <Form {...form}>
      <FormField name="title" render={({ field }) => (
        <FormItem><FormLabel>Title</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
      )} />
    </Form>
  </DialogContent>
</Dialog>
```

---

## 13. Hooks as abstractions over behavior — and *custom* hooks specifically

Don't try to learn every built-in hook up front. Learn the question each one answers (`useState` → local mutable state, `useEffect` → sync with something external, `useMemo`/`useCallback` → cache a computation/identity, `useRef` → persistent mutable reference outside render, `useContext` → consume a Provider). But the thing that actually matters in a real app is **custom hooks**, and AstriX has one per backend resource:
```tsx
// hooks/api/use-auth.tsx
const useAuth = () => useQuery({ queryKey: ["authUser"], queryFn: getCurrentUserQueryFn, staleTime: 0, retry: 2 });

// hooks/api/use-get-workspace.tsx
const useGetWorkspaceQuery = (workspaceId: string) =>
  useQuery({ queryKey: ["workspace", workspaceId], queryFn: () => getWorkspaceByIdQueryFn(workspaceId), enabled: !!workspaceId });
```
This is far more valuable than an inline `useEffect(() => fetch(...), [])`, because the custom hook creates a **domain abstraction**: `Component → useGetWorkspaceQuery() → query infrastructure → backend`. When reading `hooks/`, ask: *what complexity is this hook hiding from the component that calls it?* — for `use-auth`, it's hiding "how do I know if the user is logged in and who they are" behind a two-line call.

---

## 14. Context — dependency injection, used narrowly on purpose

Without Context, passing the logged-in user to a deeply nested component means prop-drilling it through every layer in between. AstriX avoids this for exactly one value — auth/user context — via `context/auth-provider.tsx`:
```tsx
<AuthProvider>   {/* mounted only inside AppLayout, not globally — see §10 */}
  <AppRoutes />
</AuthProvider>
// deep inside:
const { user, hasPermission } = useAuthContext();
```
Mental model: `Provider → dependency available to a subtree → consumer reads it via a hook`. This is genuinely dependency injection, not "global state because Context sounds global." AstriX deliberately does **not** put frequently-changing server data (projects, tasks) into a Context — that's what TanStack Query's own cache is for (§5) — Context here is reserved for the one thing that's small, changes rarely, and many components need: who's logged in and what can they do.

---

## 15. URL state — the third place state can live, and why it's not optional here

AstriX installs `NuqsAdapter` at the root (§1) specifically because frontend state has **three possible homes**, not two:
```
1. Component memory (useState)
2. Server cache (TanStack Query)
3. The URL itself (nuqs)
```
Two real, load-bearing examples in this codebase:
```ts
// hooks/use-create-workspace-dialog.tsx — is the "create workspace" dialog open?
const [open, setOpen] = useQueryState("new-workspace", parseAsBoolean.withDefault(false));

// hooks/use-workspace-id.ts — which workspace is currently active? NOT a store at all:
const useWorkspaceId = () => useParams().workspaceId as string;
```
The second one is the deeper lesson: **"which workspace am I viewing" lives in the URL's `:workspaceId` segment, full stop** — there is no separate `currentWorkspaceId` in a Zustand store to keep in sync. Clicking a different workspace in the switcher doesn't set state; it calls `navigate('/workspace/${id}')`, and every component that needs to know the active workspace just calls `useWorkspaceId()`, which reads the current URL. This avoids an entire class of synchronization bugs (store value and URL drifting apart after a back-button navigation) by only ever having one source of truth to begin with. Whenever you're about to reach for a store to hold something, ask first: **can this be derived from the URL instead of duplicated into a store?**

---

## 16. Forms as a state machine, not a library to memorize

Login, conceptually:
```
email + password → form state → validation → submit → POST /auth/login → loading → success/error → navigate
```
The state machine underneath every form in this app:
```
IDLE → SUBMITTING → SUCCESS         or         IDLE → SUBMITTING → ERROR → IDLE
```
The actual mechanism, consistent across every form in `components/workspace/**` and `page/auth/*`:
```tsx
const form = useForm({ resolver: zodResolver(createTaskSchema), defaultValues: {...} });
// react-hook-form owns the IDLE/SUBMITTING/ERROR machine via formState.isSubmitting / errors
```
Notice the schema (`createTaskSchema`) mirrors the backend's own Zod validation philosophy (see the Backend Architecture document §3.3) — hand-duplicated on the frontend, not shared, which is a real seam worth knowing about (covered in the Frontend↔Backend Connection document §5), but the *philosophy* — validation as declared data, not imperative field-by-field checks — is consistent across the whole stack.

---

## 17. Loading, error, and empty states are not optional

The naive version:
```tsx
const { data } = useProjects();
return <ProjectList projects={data} />;    // crashes if data is undefined while loading
```
The production version, and what AstriX actually does via its `skeleton-loaders/` components and `PermissionsGuard`:
```tsx
if (isLoading) return <ProjectListSkeleton />;
if (error) return <ErrorState message={error.message} />;
if (!data?.length) return <EmptyState />;
return <ProjectList projects={data} />;
```
Every server-backed screen should make you ask: what does the user see while loading, if it fails, if there's no data yet, if they lack permission (`PermissionsGuard`, Backend Architecture document's authorization mirror), and immediately after a mutation succeeds. This is a large fraction of what "professional frontend work" actually consists of, and it's a good checklist to run against any component you're reading that touches a `useQuery`.

---

## 18. TanStack Query, properly understood

Don't learn it as "a fetching library." Learn it as **a client-side cache and synchronization layer for server state** (§5, made concrete):
```
GET /projects  →  enters the Query Cache, keyed by ["projects", workspaceId]

Component A ──┐
Component B ──┼──►  Query Cache  ──►  API   (only ONE network request, even with 3 subscribers)
Component C ──┘

POST /projects (mutation succeeds)
     → queryClient.invalidateQueries(["projects", workspaceId])
     → cache is marked stale → automatic refetch → every subscribed component re-renders
```
This `mutate → invalidateQueries → refetch` loop (§6) is used identically across every create/edit/delete flow in the app — once you've seen it once, you've seen the shape used everywhere.

---

## 19. The browser as a stateful environment — and where AstriX's auth state actually lives

A SPA isn't just React — `window`, `document`, cookies, `localStorage`, the URL, and `fetch` are all part of the runtime. For AstriX's authentication specifically, you should be able to answer, precisely, not approximately:

> Where is auth state represented? — **the access token lives in memory only** (a Zustand store with no `persist` middleware, `store/store.ts`); the refresh token lives in an **httpOnly cookie**, invisible to JS entirely.
> What happens on refresh (the browser action, not the token)? — the in-memory access token is wiped; the app silently calls `/auth/refresh` (the httpOnly cookie rides along automatically) to get a new one.
> What happens when the API returns 401? — the axios response interceptor in `lib/axios-client.ts` catches it, queues concurrent requests, refreshes once, and replays them (§20 goes deep on this).

These questions connect frontend knowledge directly to backend/security knowledge — this is the exact seam covered in full in the Frontend↔Backend Connection document.

---

## 20. The single most sophisticated piece of code in this client — read it slowly

```ts
// lib/axios-client.ts
let isRefreshing = false;
let failedQueue: Array<{ resolve: (token: string) => void; reject: (e: any) => void }> = [];

API.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status !== 401) return Promise.reject(error);
    if (originalRequest.url?.includes("/auth/refresh")) { clearAuth(); redirect("/sign-in"); return Promise.reject(error); }
    if (originalRequest._retry) return Promise.reject(error);

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve: (token) => resolve(API({ ...originalRequest, headers: { ...originalRequest.headers, Authorization: `Bearer ${token}` } })), reject });
      });
    }
    originalRequest._retry = true;
    isRefreshing = true;
    try {
      const { data } = await axios.post(`${baseURL}/auth/refresh`, {}, { withCredentials: true });
      useStoreBase.getState().setAccessToken(data.access_token);
      failedQueue.forEach(p => p.resolve(data.access_token));
      failedQueue = [];
      return API(originalRequest);
    } catch (e) {
      failedQueue.forEach(p => p.reject(e));
      useStoreBase.getState().clearAuth();
      window.location.href = "/sign-in";
      return Promise.reject(e);
    } finally { isRefreshing = false; }
  }
);
```
This solves a real, easy-to-get-subtly-wrong concurrency problem: **if 5 components mount at once and all get a 401 simultaneously, only the first should trigger `/auth/refresh` — the other 4 should queue and replay once it resolves**, not each fire their own refresh call. This is a mutex (`isRefreshing`) plus a queue (`failedQueue`) plus a guard against infinite loops (`_retry`, and the explicit check that `/auth/refresh` itself returning 401 means "give up, redirect to login" rather than "try refreshing again"). Reading this file slowly, line by line, is worth more than reading twenty simpler components.

---

## 21. TypeScript, specifically as used here — domain types vs. API types vs. props

```ts
// types/api.type.ts — the WIRE format, hand-mirrored from the backend
type TaskType = { _id: string; taskCode: string; title: string; status: TaskStatusEnumType;
                   assignedTo: { _id: string; name: string; profilePicture: string | null } | null; };
```
```tsx
// A component's prop type is deliberately NARROWER — this card only needs 3 fields,
// even though the object passed in satisfies the much bigger TaskType above.
type TaskCardProps = { title: string; status: TaskStatusEnumType; assignee: { name: string } | null };
```
The discipline: a component's type signature should describe exactly what it depends on, not "whatever the API happens to return." Also worth naming: `constant/index.ts` hand-redeclares `Permissions`/`TaskStatusEnum` to match `backend/src/enums/role.enum.ts` — real duplication, not shared, flagged with a fix in the Roadmap document (a generated client from the backend's existing `/api/docs` Swagger spec).

---

## 22. CSS/Tailwind, learned as a genuinely separate system from React

```tsx
<div className="flex items-center justify-between gap-4 p-4 rounded-lg border">
```
Two independent questions: *what is React doing* (rendering a `div`, passing a static string to `className` — nothing dynamic) and *what is CSS doing* (`flex` = flex container, `items-center` = `align-items: center`, `justify-between` = `justify-content: space-between`, the rest is spacing/border). The one Tailwind-specific idiom worth naming, used throughout `components/ui/*`:
```tsx
className={cn("base-classes", isActive && "bg-accent", className)}
```
`cn()` (a `clsx` + `tailwind-merge` wrapper) conditionally applies classes and intelligently resolves conflicts between them — the Tailwind-world equivalent of `el.classList.toggle(...)`. Recognizing this one utility is most of what's needed to stop being surprised by any `components/ui/*` file.

---

## 23. The SPA as one complete machine — what you should see without opening the code

```
                   Browser
                      │
                index.html → main.tsx
                      │
      ┌───────────────┼────────────────┐
      ▼                ▼                ▼
 QueryProvider     NuqsAdapter        Toaster
      │
      ▼
     App → AppRoutes
      │
 ┌────┴─────┐
 ▼          ▼
AuthRoute  ProtectedRoute
             │
             ▼
          AppLayout (chrome: AsideBar + Header)
             │
             ▼
         <Outlet/> → Page
             │
             ▼
         Components
             │
             ▼
        hooks/api/*  ◄──── AuthProvider (Context, user + permissions)
             │
             ▼
       TanStack Query Cache
             │
             ▼
       lib/api.ts → axios (lib/axios-client.ts, refresh-queue)
             │
             ▼
           Backend
```
That's what you should ultimately see when you look at this repository — not 119 individual `.tsx` files.

---

## 24. How to actually read AstriX — one feature at a time

Don't say "today I'll understand the frontend." Say **"today I'll understand how creating a task works,"** and literally trace:
```
"Create Task" button
  → create-task-form.tsx
  → react-hook-form + zodResolver(createTaskSchema)
  → useMutation({ mutationFn: createTaskMutationFn })   [hooks/api + lib/api.ts]
  → axios (Authorization header attached by the interceptor, §20)
  → POST /api/task/workspace/:id/project/:id/create      [now: Backend Architecture doc §7]
  → 201 response
  → onSuccess: queryClient.invalidateQueries(["all-tasks", workspaceId])
  → refetch → TaskTable re-renders with the new row
```
Then do another: login. Then: the `ProtectedRoute` guard. Then: workspace switching (§15). Then: task status update. By the fifth feature you'll recognize the architecture instead of memorizing isolated files.

---

## 25. The reading order for this exact repository

Not filesystem order:
```
1. client/index.html
2. src/main.tsx
3. src/App.tsx
4. src/routes/index.tsx
5. routes/auth.route.tsx
6. routes/protected.route.tsx
7. layout/app.layout.tsx
8. one page (e.g. the project detail page)
9. the components that page renders
10. the hooks those components call
11. context/auth-provider.tsx + store/store.ts
12. lib/api.ts + lib/axios-client.ts
13. the corresponding backend route → controller → service (Backend Architecture document)
```
The folder structure — `components`, `context`, `hooks`, `hoc`, `layout`, `lib`, `page`, `routes`, `store`, `types` — already exposes these conceptual layers. That's almost a ready-made curriculum.

---

## 26. The seven questions to ask of any file you don't recognize

1. **What renders this?** — who's the parent?
2. **What does this render?** — who are its children? A compound `Dialog`/`Form` from `components/ui/`?
3. **Where does its data come from?** — props? `useState`? a `hooks/api/*` query? `useAuthContext()`? the URL via `nuqs`?
4. **What can cause it to re-render?** — a prop change, a query cache invalidation, a store selector firing?
5. **What user actions does it handle?** — click, submit, change — and what handler do they call?
6. **What side effects happen?** — an API call, a `navigate()`, a toast, a store update?
7. **What do the loading/error/empty/no-permission states look like** — and if the component doesn't visibly handle one of these, that's worth noticing as a real gap, not just moving past it.

If you can answer all seven for a file, you understand it — regardless of how long it is.

---

## 27. Staged progression, mapped to this repository specifically

```
Stage 1 — Browser fundamentals: HTML, DOM, fetch, cookies, localStorage, URL
  (relevant because AstriX's auth model — §19 — depends on knowing exactly
   what an httpOnly cookie can and can't do from JS)

Stage 2 — React fundamentals, found live in components/ui/* before workspace/*
  components → props → children/composition → state → conditional rendering

Stage 3 — Architecture-level React
  Context (AuthProvider, §14) → custom hooks (hooks/api/*, §13)
  → HOCs (withPermission) → guard components (ProtectedRoute, PermissionsGuard)

Stage 4 — Real application state
  TanStack Query cache (§18) → mutations → invalidation
  → the axios refresh-queue (§20 — slow down here, it's the hardest code in the client)

Stage 5 — SPA infrastructure
  routing (§8–9) → layouts (§10) → URL state via nuqs (§15)
  → the full auth handoff (Frontend↔Backend Connection document)

Stage 6 — Production concerns
  what's missing today: no global error boundary, no tests, minimal
  memoization (deliberate simplicity, not oversight) — all cataloged
  with fixes in the Security Concerns and Roadmap documents
```

---

## 28. Exercises — the fastest way to convert "traced it" into "understand it"

1. **Add a read-only member-count badge to the workspace switcher.** Smallest possible end-to-end slice: new `hooks/api/*` hook, wired into an existing component, with a loading state.
2. **Add a debounced search input to the task table** (currently absent). Decide deliberately: does the filter value belong in `nuqs` URL state (consistent with the existing status/priority filters, §15) or local component state?
3. **Add a global `<ErrorBoundary>`** around `AppLayout`'s `<Outlet/>` (currently missing). Then deliberately throw inside a nested component and watch the boundary catch it instead of white-screening the app — reading about error boundaries never lands the way watching one catch a real error does.
4. **Break the refresh-queue on purpose.** Add an artificial delay to `/auth/refresh` on the backend, fire three protected requests simultaneously, confirm (network tab open) only *one* refresh call fires and the other two queue. Then comment out the `isRefreshing` guard in §20 and watch three refresh calls fire instead. This is the single best exercise in the entire client.

---

## 29. Don't try to "finish React" — the rule that actually matters

Don't spend two weeks doing tutorials and then open this repo. Instead: **learn one concept → find it live in AstriX → trace it → modify it → break it → fix it.** Learn `useState` → find one in this client → change it → watch the re-render. Learn Context → trace `AuthProvider` from its provider to a `useAuthContext()` consumer. Learn TanStack Query → trace one real `GET` request end to end (§18). Learn mutations → create, edit, and delete one real task, tracing the full lifecycle each time (§24). Learn routing → trace one URL from the address bar through `ProtectedRoute` to a rendered page.

That approach makes you dangerously comfortable reading unfamiliar frontend code — which is worth far more than being able to recite React APIs. Whenever a file in this client looks intimidating, the fix is never "read it more carefully." It's: **pick one piece of data or one user action, and trace it through the system.** Frontend stops being a pile of components the moment you start reading it as a data-flow graph instead of a list of files.

---

## Appendix — Quick Reference (folder map, file sizes, gaps)

For when you need to look something up rather than read the guide top to bottom.

### Folder map
```
client/src/
├── main.tsx / App.tsx        Entry point, provider tree
├── routes/                    Route trees + guards (§8–9)
├── layout/                     AppLayout (authenticated shell) / BaseLayout (public shell)
├── context/                     AuthProvider, QueryProvider
├── store/                        Zustand store (auth state only, in-memory)
├── hooks/api/                     TanStack Query hooks, one per resource
├── hooks/ (root)                   UI-only hooks: dialogs, table filters, permissions
├── page/                             Route-level screens, grouped by domain
├── components/ui/                     shadcn/ui primitives (vendored)
├── components/workspace/               Domain components: project/, task/, member/, settings/
├── components/asidebar/                 Sidebar + workspace switcher
├── hoc/                                   withPermission() page-level gate
├── lib/                                    axios-client.ts, api.ts, helper.ts, utils.ts
└── types/                                   api.type.ts, custom-error.type.ts
```

### Notable files by size
| File | Lines | Note |
|---|---|---|
| `page/home/landingPage.tsx` | 843 | Marketing copy, not complexity |
| `components/ui/sidebar.tsx` | 763 | Vendored shadcn primitive |
| `components/workspace/task/create-task-form.tsx` | 470 | Genuine complexity: 3 linked queries + full validated form |
| `types/api.type.ts` | 280 | Hand-written, mirrors backend DTOs (§21) |
| `page/auth/Sign-up.tsx` | 277 | Registration + Google OAuth |
| `lib/api.ts` | 274 | Every typed API call, flat file |

### What's absent, on purpose or otherwise
- No optimistic updates — every mutation is *mutate → wait → invalidate → refetch*, never `onMutate`. Simpler, costs a round-trip of perceived latency.
- No debouncing utility anywhere yet (§28 exercise #2).
- Minimal `useMemo`/`useCallback` (3 occurrences total) — appropriate at this scale, not an oversight.
- No global error boundary (§28 exercise #3).
- No test files — no React Testing Library, no Vitest config.
- Type duplication with the backend (`constant/index.ts` vs `backend/src/enums/`) — flagged with a fix in the Roadmap document.

Full security and roadmap detail lives in the Security Concerns and Roadmap documents; the frontend↔backend wire contract (CORS, the dual-token handoff, env var baking) lives in the Frontend↔Backend Connection document.