# Forms & Validation

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

A form is the one place in a frontend where the application deliberately invites the user to type anything they want, then has to turn that anything into a typed, trustworthy object before it's allowed anywhere near a network request. Everything else in a React app reads data that arrived from a server and is therefore already shaped; a form is the one component tree that produces new data from scratch, character by character, and has to validate it on the way out. That makes "how do we do forms" one of the highest-leverage decisions in a frontend codebase — it touches re-render performance (every keystroke is a potential state update), UX (when does an error appear — as you type, when you leave the field, or only on submit?), type safety (does the compiler know what shape `values` will be in `onSubmit`?), and, as this chapter's mandatory security section covers, the boundary between "the user typed something invalid" and "the user is trying to attack the system."

AstriX answers this the same way a large fraction of the current React ecosystem does: `react-hook-form` for form state and field registration, a Zod schema for the validation rules, `@hookform/resolvers`' `zodResolver` as the adapter between the two, and a small set of hand-owned wrapper components — copied in from shadcn/ui, not installed as a black-box dependency — that connect React Hook Form's internal state to whatever input component actually renders. This chapter traces that whole chain through two real forms (sign-up, create-project), explains what a live client-side UX feature like the password-strength indicator is and isn't doing, and — because this is the frontend half of a validation story whose backend half already exists in this curriculum — spends real effort answering the one question that makes or breaks a two-sided validation setup: are the frontend and backend Zod schemas actually the same schema, or two independently-hand-maintained copies that can quietly drift apart? The answer, verified by reading the actual imports rather than assumed, is the latter, and it shapes most of §§5–8 below.

---

## 1. The Landscape

"How do you manage a form's state and validate its input" is a question every UI framework answers differently, and even within React there are at least four genuinely distinct, widely-used approaches — not one obviously-correct answer and three strawmen. Each trades off re-render behavior, how much the framework does for you, and how tightly the validation logic is coupled to the rendering layer.

### (a) Uncontrolled forms — the browser-native baseline

Before any form library existed, and still a completely legitimate choice for a form with a handful of fields, is to let the DOM own the input values entirely and only read them at submit time — via `ref`s or the browser's own `FormData` API — rather than mirroring every keystroke into React state.

```tsx
function ContactForm() {
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const data = new FormData(formRef.current!);
    const email = data.get("email") as string;
    if (!email.includes("@")) {
      alert("Invalid email");
      return;
    }
    // ... submit
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      <input name="email" type="email" />
      <button type="submit">Submit</button>
    </form>
  );
}
```

**Tradeoffs.** Zero dependencies, and genuinely minimal re-renders — typing into the input doesn't trigger a React re-render at all, because nothing calls `setState` on every keystroke; the DOM is simply allowed to hold the value until the form is submitted. The cost is that everything a form library normally gives you for free has to be hand-wired: per-field error display, disabling the submit button while invalid, showing an error the instant a field is touched rather than only on submit, and cross-field rules. For a two-field contact form this is barely a cost. For a form with a dozen fields, conditional fields, and rich validation, the amount of glue code needed to reach parity with a library grows fast, and it's easy to end up half-reinventing one.

### (b) Formik — the historically dominant React form library

For years, **Formik** was the default answer to "how do I build a form in React." It's a component-based API: a `<Formik>` provider owns all form state (values, errors, touched, submitting) as React state, and `<Field>`/`<ErrorMessage>` components connect individual inputs to that state, typically re-rendering the whole form (or large chunks of it) on every keystroke unless the consumer opts into more granular subscriptions.

```tsx
import { Formik, Form, Field, ErrorMessage } from "formik";
import * as Yup from "yup";

const schema = Yup.object({
  email: Yup.string().email("Invalid email").required("Required"),
});

function SignupForm() {
  return (
    <Formik
      initialValues={{ email: "" }}
      validationSchema={schema}
      onSubmit={(values) => submit(values)}
    >
      <Form>
        <Field name="email" type="email" />
        <ErrorMessage name="email" component="div" />
        <button type="submit">Submit</button>
      </Form>
    </Formik>
  );
}
```

**Tradeoffs.** Formik popularized schema-driven validation in React forms (it paired naturally with **Yup**, its long-time companion validation library) and its component API reads clearly for small-to-medium forms. Its honest cost, as of 2026, is twofold: it's controlled-by-default, so every keystroke updates React state and can re-render more of the tree than strictly necessary unless a team is careful about memoization and `useField`-level subscriptions; and its maintenance pace has slowed markedly compared to the ecosystem around it — the project ships far less frequently than `react-hook-form`, and most new React codebases starting fresh in 2026 pick something else. It's still entirely serviceable in an existing Formik codebase; it's a much weaker pick for a new one.

### (c) `react-hook-form` — uncontrolled-by-default, hook-based

`react-hook-form` (RHF) took a different starting position: instead of mirroring every field into React state, it registers each input via a `ref` and reads its value directly from the DOM (the same uncontrolled mechanism as approach (a)), only triggering a re-render for the specific fields whose validation state actually changed. The API surface is a single hook, `useForm()`, rather than a provider component tree.

```tsx
import { useForm } from "react-hook-form";

function SignupForm() {
  const { register, handleSubmit, formState: { errors } } = useForm();

  return (
    <form onSubmit={handleSubmit((values) => submit(values))}>
      <input {...register("email", { required: true })} />
      {errors.email && <span>Required</span>}
      <button type="submit">Submit</button>
    </form>
  );
}
```

**Tradeoffs.** Because RHF doesn't put every field into React state, typing into one field doesn't re-render sibling fields — a real, measurable performance win on large forms, and the reason it displaced Formik as the default choice for new React projects. It's schema-agnostic at its core (the snippet above uses RHF's own inline rules), but its resolver interface — see §3 below — lets it delegate validation entirely to an external schema library, which is what makes the pairing with Zod (or Yup, or anything else with a resolver adapter) possible without RHF needing to know anything about the schema library's API. The cost, relative to (a), is a dependency and a slightly larger API surface to learn (`register`, `control`, `handleSubmit`, `formState`); relative to (b), there's a real learning curve if a team is used to Formik's component-based mental model, since RHF leans on refs and a `control` object rather than `<Field>` components for anything beyond the simplest native inputs.

### (d) Fully server-driven forms — Server Actions / progressive enhancement

The newest entrant, and the one most structurally different from the other three, comes from SSR-capable meta-frameworks — **Next.js Server Actions** and similar patterns (Remix's `<Form>`, SvelteKit's form actions) — where a `<form>`'s `action` prop points directly at a server function. The browser can submit the form with **zero client-side JavaScript**, the same way HTML forms worked before SPAs existed; the framework progressively enhances that baseline with client-side transitions when JS is available.

```tsx
// Next.js Server Action — runs on the server, not in the browser
async function createUser(formData: FormData) {
  "use server";
  const email = formData.get("email") as string;
  const parsed = signupSchema.safeParse({ email });
  if (!parsed.success) return { error: parsed.error.flatten() };
  await db.user.create({ data: parsed.data });
}

// Client component
function SignupForm() {
  return (
    <form action={createUser}>
      <input name="email" type="email" />
      <button type="submit">Sign up</button>
    </form>
  );
}
```

**Tradeoffs.** This collapses the client/server round-trip that every other approach here treats as a given: there's no separate `fetch`/axios call, no client-maintained loading state to hand-wire — the framework's `useFormStatus`/`useActionState` hooks expose pending/error state instead. It also means validation can genuinely run in one place (the server function) without needing to duplicate rules on the client at all, sidestepping the exact frontend/backend-schema-drift problem this chapter spends §§5–8 on. The cost is structural: this pattern only exists inside a framework that renders on the server and can serialize a form submission into a server function call — it is not something a plain client-rendered SPA talking to a separate REST API can adopt, because there is no server-rendering layer in the request path to host the action. It's named here specifically because it's the honest, industry-relevant answer to "what does the frontend/backend validation-duplication problem look like if you remove the frontend/backend split" — not because AstriX could use it. AstriX's architecture (a decoupled SPA served from S3/CloudFront, talking to a wholly separate Express API — see [`docs/Architecture.md`](../Architecture.md) §2) has no server-rendering tier at all, so this option is structurally unavailable to it regardless of its merits.

---

## 2. AstriX's Choice

AstriX uses **(c): `react-hook-form`**, with **Zod** as the validation schema library and **`@hookform/resolvers`' `zodResolver`** as the glue between them — confirmed as the frontend's declared forms/validation stack in [`docs/frontend/00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) §5's tech-stack table (`react-hook-form ^7.53.2`, `@hookform/resolvers ^3.9.1`, `zod ^3.24.1`) and in every form-bearing component this chapter examines. On top of that pairing, AstriX doesn't build each field's markup from scratch — it uses a small set of wrapper components generated by the shadcn/ui CLI into `client/src/components/ui/form.tsx`, which exist specifically to connect RHF's internal context to whatever field-level component (an `<Input>`, a `<Textarea>`, anything) actually renders. That file is examined in full in §3.4.

---

## 3. AstriX Implementation

### 3.1 The shared field-level UX layer: `client/src/lib/password.ts`

Before looking at a specific form, one file is worth reading first because two of the components below both depend on it — but, importantly, depend on *different exports* from it, which matters for §6:

```ts
// client/src/lib/password.ts:1-20
import { z } from "zod";

export const passwordRequirements = [
  { regex: /.{8,}/, label: "At least 8 characters" },
  { regex: /[A-Z]/, label: "One uppercase letter" },
  { regex: /[a-z]/, label: "One lowercase letter" },
  { regex: /[0-9]/, label: "One number" },
  { regex: /[^A-Za-z0-9]/, label: "One special character (!@#$%^&*)" },
];

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(
    /[^A-Za-z0-9]/,
    "Password must contain at least one special character"
  );
```

This one file exports two structurally parallel, but *separately maintained*, representations of the same five password rules: `passwordSchema` (a Zod schema, used for the actual pass/fail gate wired into `useForm`) and `passwordRequirements` (a plain array of `{ regex, label }` pairs, used purely to render a per-rule checklist in the UI). Both are hand-written; neither is derived from the other. §6 covers what that means for the password-strength indicator specifically.

### 3.2 The sign-up form: `useForm` + `zodResolver` end to end

```tsx
// client/src/page/auth/Sign-up.tsx:1-57
import { Link, useNavigate } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import Logo from "@/components/logo";
import GoogleOauthButton from "@/components/auth/google-oauth-button";
import { useMutation } from "@tanstack/react-query";
import { registerMutationFn } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";
import { useState } from "react";
import { getErrorMessage } from "@/lib/helper";
import { passwordSchema } from "@/lib/password";
import PasswordStrengthIndicator from "@/components/auth/password-strength-indicator";
import { BASE_ROUTE } from "@/routes/common/routePaths";

// ============================================
// VALIDATION SCHEMA
// ============================================

const formSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .min(1, "Email is required"),
  password: passwordSchema,
});

type FormValues = z.infer<typeof formSchema>;
```

Three things to notice immediately, because they're the mechanical backbone of every AstriX form:

1. `formSchema` is a `z.object()` literal, composed inline in the component file — not imported from anywhere shared. It reuses `passwordSchema` from `lib/password.ts` (§3.1) for the `password` field, but `name` and `email` are hand-written here, in this file, not imported from a shared module. (§5's Design Decisions section and §7's Best Practice Check return to what "shared" would even mean here.)
2. `type FormValues = z.infer<typeof formSchema>` derives a TypeScript type directly from the runtime schema — the same `z.infer<>` pattern the backend's own validation modules use (see [`docs/backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) §5), for the identical reason: the compile-time type and the runtime check are structurally the same object and cannot drift from each other the way a hand-maintained `interface` sitting next to a hand-maintained schema can.
3. There is no `.trim()` on `password` (there couldn't sensibly be — trimming a password would silently change what the user typed), but there *is* `.trim()` on `name` and `email`. This is worth flagging because it's a real, intentional asymmetry, not an oversight: whitespace at the edges of a name or email is almost always accidental (a trailing space from autocomplete); whitespace inside a password is data.

Now the hook wiring itself:

```tsx
// client/src/page/auth/Sign-up.tsx:63-102
const SignUp = () => {
  const navigate = useNavigate();
  const [showPasswordRequirements, setShowPasswordRequirements] =
    useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: registerMutationFn,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
  });

  const watchedPassword = form.watch("password");

  const onSubmit = (values: FormValues) => {
    if (isPending) return;

    mutate(values, {
      onSuccess: () => {
        toast({
          title: "Success",
          description: "Account created successfully. Please sign in.",
        });
        navigate("/sign-in");
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: getErrorMessage(error),
          variant: "destructive",
        });
      },
    });
  };
```

`useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: {...} })` is the entire wiring step: `zodResolver` wraps `formSchema` so RHF can call it the same way it would call any other resolver (its own built-in rules, a Yup schema, anything implementing the same interface — see §4 for exactly what that interface is). `defaultValues` is required by TypeScript here because `FormValues` has no optional fields — RHF needs an initial value for every key the type declares. `form.watch("password")` is a live subscription to one field's current value, used purely to feed the password-strength indicator (§3.3) as the user types — a separate, additive use of RHF's API on top of the validation wiring, not part of the validation flow itself.

And the JSX, which is where the shadcn wrapper components (§3.4) actually get used per field:

```tsx
// client/src/page/auth/Sign-up.tsx:122-224 (Form/FormField portion)
<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)}>
    <div className="grid gap-6">
      <div className="flex flex-col gap-4">
        <GoogleOauthButton label="Signup" />
      </div>
      <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
        <span className="relative z-10 bg-background px-2 text-muted-foreground">
          Or continue with
        </span>
      </div>
      <div className="grid gap-3">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                Name
              </FormLabel>
              <FormControl>
                <Input
                  placeholder="John Doe"
                  className="!h-[48px]"
                  autoComplete="name"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                Email
              </FormLabel>
              <FormControl>
                <Input
                  placeholder="m@example.com"
                  className="!h-[48px]"
                  autoComplete="email"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                Password
              </FormLabel>
              <FormControl>
                <Input
                  type="password"
                  className="!h-[48px]"
                  autoComplete="new-password"
                  onFocus={() =>
                    setShowPasswordRequirements(true)
                  }
                  {...field}
                />
              </FormControl>
              <FormMessage />
              {showPasswordRequirements && (
                <PasswordStrengthIndicator
                  password={watchedPassword}
                />
              )}
            </FormItem>
          )}
        />
        <Button
          disabled={isPending}
          type="submit"
          className="w-full"
        >
          {isPending && <Loader className="animate-spin mr-2" />}
          Sign up
        </Button>
      </div>
    </div>
  </form>
</Form>
```

`<Form {...form}>` spreads the entire object `useForm()` returned — `control`, `handleSubmit`, `watch`, `formState`, everything — as props onto the `Form` wrapper, which (§3.4) is just RHF's own `FormProvider` re-exported under a shorter name. Each `<FormField control={form.control} name="...">` then reads that one field's live state out of RHF's context. `form.handleSubmit(onSubmit)` is passed directly as the native `<form>`'s `onSubmit` — RHF's `handleSubmit` wraps the caller's `onSubmit`, runs validation first, and only invokes the caller's function if validation passes (traced precisely in §4).

### 3.3 The password-strength indicator — a live, client-only UX layer

```tsx
// client/src/components/auth/password-strength-indicator.tsx:1-27
import { Check, X } from "lucide-react";
import { passwordRequirements } from "@/lib/password";

const PasswordStrengthIndicator = ({ password }: { password: string }) => {
  if (!password) return null;

  return (
    <div className="mt-2 space-y-1">
      {passwordRequirements.map((req) => {
        const isMet = req.regex.test(password);
        return (
          <div
            key={req.label}
            className={`flex items-center gap-2 text-xs ${
              isMet ? "text-green-600" : "text-muted-foreground"
            }`}
          >
            {isMet ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
            {req.label}
          </div>
        );
      })}
    </div>
  );
};

export default PasswordStrengthIndicator;
```

This component doesn't touch RHF, Zod, or `formState.errors` at all — it's a plain function of one prop (`password`, fed live from `form.watch("password")` in the parent) that re-runs five independent regex tests on every render and paints a checklist. It's a pure derived-UI component, not a validation gate: nothing about this component's output ever prevents submission or reaches `onSubmit`. §6 covers precisely what it does and doesn't do to the app's actual trust boundary.

### 3.4 The shadcn RHF wrapper: `client/src/components/ui/form.tsx` in full

```tsx
// client/src/components/ui/form.tsx:1-180
"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import {
  Controller,
  ControllerProps,
  FieldPath,
  FieldValues,
  FormProvider,
  useFormContext,
} from "react-hook-form";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue
);

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
};

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();

  const fieldState = getFieldState(fieldContext.name, formState);

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>");
  }

  const { id } = itemContext;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  };
};

type FormItemContextValue = {
  id: string;
};

const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue
);

const FormItem = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const id = React.useId();

  return (
    <FormItemContext.Provider value={{ id }}>
      <div ref={ref} className={cn("space-y-2", className)} {...props} />
    </FormItemContext.Provider>
  );
});
FormItem.displayName = "FormItem";

const FormLabel = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => {
  const { error, formItemId } = useFormField();

  return (
    <Label
      ref={ref}
      className={cn(error && "text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    />
  );
});
FormLabel.displayName = "FormLabel";

const FormControl = React.forwardRef<
  React.ElementRef<typeof Slot>,
  React.ComponentPropsWithoutRef<typeof Slot>
>(({ ...props }, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId } =
    useFormField();

  return (
    <Slot
      ref={ref}
      id={formItemId}
      aria-describedby={
        !error
          ? `${formDescriptionId}`
          : `${formDescriptionId} ${formMessageId}`
      }
      aria-invalid={!!error}
      {...props}
    />
  );
});
FormControl.displayName = "FormControl";

const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField();

  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn("text-[0.8rem] text-muted-foreground", className)}
      {...props}
    />
  );
});
FormDescription.displayName = "FormDescription";

const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error?.message) : children;

  if (!body) {
    return null;
  }

  return (
    <p
      ref={ref}
      id={formMessageId}
      className={cn("text-[0.8rem] font-medium text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  );
});
FormMessage.displayName = "FormMessage";

export {
  useFormField,
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
};
```

This file is the load-bearing piece of the whole chapter, and it's worth reading slowly because every AstriX form leans on all six exports:

- **`Form = FormProvider`** — this is literally RHF's own context provider, re-exported under a project-local name. It's not custom logic; it exists so every consuming file imports `Form` from `@/components/ui/form` alongside `FormField`/`FormItem`/etc. instead of mixing an RHF import with a shadcn import for the same conceptual "form" concept.
- **`FormField`** wraps RHF's `Controller` (its official escape hatch for connecting a *controlled* component to RHF's otherwise-uncontrolled internals — relevant because AstriX's `<Input>`/`<Textarea>` are ordinary controlled React components, not raw uncontrolled `<input>`s) and layers a second React Context (`FormFieldContext`) on top, whose only job is to remember *which field name* the nearest `FormField` is rendering, so sibling hooks/components below it can ask "which field am I inside of" without being passed the name explicitly.
- **`useFormField`** is the piece that actually does the context-merging: it reads the field name from `FormFieldContext`, the item's generated `id` from `FormItemContext`, and — critically — calls RHF's own `getFieldState(name, formState)` to pull that one field's live `error`/`isDirty`/`isTouched` state out of the whole form's state tree. Every other component in this file (`FormLabel`, `FormControl`, `FormMessage`) calls `useFormField()` internally rather than receiving `error` as a prop — that's what lets a consumer write `<FormMessage />` with zero props and have it correctly show *that specific field's* error.
- **`FormControl`** uses Radix's `<Slot>` to merge its own accessibility props (`id`, `aria-describedby`, `aria-invalid`) onto whatever single child it wraps (an `<Input>`, a `<Textarea>`, anything) without adding an extra DOM element — `aria-invalid={!!error}` and the `aria-describedby` wiring are what make a failed field actually accessible to a screen reader, not just visually red.
- **`FormMessage`** is where a Zod error message ends up on screen: `const body = error ? String(error?.message) : children` — if RHF's `formState.errors[name]` is set for this field, its `.message` (which, per §4, is exactly the string Zod's schema attached to that failure) is rendered; otherwise it falls back to whatever static `children` the caller passed (used for helper text on fields with no active error), and renders nothing at all if there's neither.

None of this file is generated at build time or hidden behind a package boundary — it's checked into the repo precisely because it's the shadcn/ui distribution model: components are copied into the project as ordinary, editable source files rather than installed as an opaque dependency (the general landscape of that choice — Radix/shadcn vs. MUI/Chakra vs. Tailwind alone — belongs to [`08-ui-component-library-and-styling.md`](./08-ui-component-library-and-styling.md), not here; this chapter's concern is only what these six exports do for RHF wiring).

### 3.5 A second, simpler example: `create-project-form.tsx`

The sign-up form is the richest example (external mutation, password UX, OAuth alternative); `create-project-form.tsx` is a smaller, more typical instance of the exact same pattern, useful for seeing the mechanical shape without the extra surface area:

```tsx
// client/src/components/workspace/project/create-project-form.tsx:1-97
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "../../ui/textarea";
import EmojiPickerComponent from "@/components/emoji-picker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createProjectMutationFn } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";

export default function CreateProjectForm({
  onClose,
}: {
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  const [emoji, setEmoji] = useState("📊");

  const { mutate, isPending } = useMutation({
    mutationFn: createProjectMutationFn,
  });

  const formSchema = z.object({
    name: z.string().trim().min(1, {
      message: "Project title is required",
    }),
    description: z.string().trim(),
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      description: "",
    },
  });

  const handleEmojiSelection = (emoji: string) => {
    setEmoji(emoji);
  };

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    if (isPending) return;
    const payload = {
      workspaceId,
      data: {
        emoji,
        ...values,
      },
    };
    mutate(payload, {
      onSuccess: (data) => {
        const project = data.project;
        queryClient.invalidateQueries({
          queryKey: ["allProjects", workspaceId],
        });

        toast({
          title: "Success",
          description: "Project created successfully",
          variant: "success",
        });

        navigate(`/workspace/${workspaceId}/project/${project._id}`);
        setTimeout(() => onClose(), 500);
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error.message,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="w-full h-auto max-w-full">
      <div className="h-full">
        <div className="mb-5 pb-2 border-b">
          <h1
            className="text-xl tracking-[-0.16px] dark:text-[#fcfdffef] font-semibold mb-1
           text-center sm:text-left"
          >
            Create Project
          </h1>
          <p className="text-muted-foreground text-sm leading-tight">
            Organize and manage tasks, resources, and team collaboration
          </p>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700">
                Select Emoji
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    aria-label="Choose project emoji"
                    className="font-normal size-[60px] !p-2 !shadow-none mt-2 items-center rounded-full "
                  >
                    <span className="text-4xl">{emoji}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className=" !p-0">
                  <EmojiPickerComponent onSelectEmoji={handleEmojiSelection} />
                </PopoverContent>
              </Popover>
            </div>
            <div className="mb-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                      Project title
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Website Redesign"
                        className="!h-[48px]"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="mb-4">
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="dark:text-[#f1f7feb5] text-sm">
                      Project description
                      <span className="text-xs font-extralight ml-2">
                        Optional
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder="Projects description"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Button
              disabled={isPending}
              className="flex place-self-end  h-[40px] text-white font-semibold"
              type="submit"
            >
              {isPending && <Loader className="animate-spin" />}
              Create
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
```

Two things worth flagging that a first read might glide past:

- The `emoji` field is deliberately **outside** RHF/Zod entirely — it's plain `useState`, set by a custom `EmojiPickerComponent`, and stitched into the mutation payload manually (`data: { emoji, ...values }`) rather than being a `FormField`. It's UI state with no validation rule attached (any emoji string is acceptable), so wiring it through RHF would add ceremony without buying anything — a reasonable, deliberate scope boundary, not an inconsistency.
- The `description` field's label carries the word "Optional" in the JSX, but the schema itself — `z.string().trim()` — has no `.optional()` call. That means an empty string satisfies the schema (Zod's `z.string()` accepts `""` unless a `.min(1)` is added), so the UI and the schema agree in effect (empty description is allowed) even though they express it differently: the UI says so with a label, the schema says so by simply not restricting length. Contrast this with `name`, which does carry an explicit `.min(1, { message: "Project title is required" })` — that message string is exactly what a user sees in `<FormMessage />` if they submit with an empty title.

### 3.6 What the test suite actually asserts about this form

```tsx
// client/src/components/workspace/project/__tests__/create-project-form.test.tsx:1-71
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CreateProjectForm from "@/components/workspace/project/create-project-form";
import { createProjectMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  createProjectMutationFn: vi.fn(),
}));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return { ...actual, useNavigate: () => navigateMock };
});

const renderForm = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/ws-1/projects"]}>
          <Routes>
            <Route
              path="/workspace/:workspaceId/projects"
              element={<CreateProjectForm onClose={vi.fn()} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
};

describe("CreateProjectForm - project list cache invalidation", () => {
  it("invalidates the exact query key the projects list is fetched with, after a successful create", async () => {
    // #given project creation succeeds
    vi.mocked(createProjectMutationFn).mockResolvedValue({
      message: "Project created successfully",
      project: { _id: "proj-1", name: "New Project", emoji: "📊" },
    } as Awaited<ReturnType<typeof createProjectMutationFn>>);
    const { queryClient } = renderForm();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    // #when submitting the create-project form
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/project title/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    // #then the projects list is invalidated with the SAME key shape
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["allProjects", "ws-1"] })
      )
    );
  });
});
```

This test doesn't exercise Zod validation at all — it mocks `createProjectMutationFn` to always succeed, types a valid title (`"New Project"`), and asserts on what happens *after* a successful submission: that the React Query cache gets invalidated under exactly the query key the projects-list hook actually reads (`["allProjects", workspaceId]`). It's a genuinely useful example for the Request/Data Flow section below precisely because of what it demonstrates by omission: `screen.getByLabelText(/project title/i)` only resolves to the right `<input>` element because `FormLabel`'s `htmlFor={formItemId}` (§3.4) and `FormControl`'s `id={formItemId}` (also §3.4) are wired to the *same* generated id — if that wiring broke, this exact query would start failing with a "no accessible element" error, which is a decent illustration of how a `<Form>`/`<FormField>` markup bug surfaces in a test even when it has nothing to do with validation logic.

---

## 4. Request/Data Flow

Trace what actually happens, mechanically, from the moment a user clicks "Sign up" on the sign-up form to the moment `onSubmit` either runs or doesn't.

1. **Every keystroke updates RHF's internal, uncontrolled field state — not React state.** Because `<Input {...field} />` spreads RHF's `field` object (which includes `onChange`, `onBlur`, `value`, `ref`) onto a controlled `<input>`, AstriX's fields are technically *controlled* React components from React's point of view (the value comes from RHF's `field.value`), but RHF itself tracks the underlying form data via its own internal store rather than triggering a parent-level re-render on every change — this is what "uncontrolled-by-default" means in practice for RHF's architecture: the *library's* bookkeeping doesn't route through React state the way Formik's does, even when the individual `<input>` happens to be a controlled DOM element.
2. **The user clicks the submit button.** The button is `type="submit"` inside a native `<form>` whose `onSubmit` is `form.handleSubmit(onSubmit)`. `handleSubmit` is RHF's own function, not a raw pass-through — it first calls `event.preventDefault()` (so the browser never performs its own default full-page-reload form submission), then gathers the current values out of its internal store.
3. **RHF calls the resolver.** `zodResolver(formSchema)` was registered as the `resolver` option back in `useForm({ resolver: zodResolver(formSchema) })` (§3.2). RHF's resolver contract is a plain function: `(values, context, options) => { values, errors }` — `zodResolver` implements exactly that by calling `formSchema.safeParse(values)` internally and translating the result into that shape. If parsing succeeds, `errors` comes back empty and `values` is the schema's own parsed (and, notably, `.trim()`'d and coerced) output — not the raw input RHF collected. If parsing fails, `zodResolver` walks Zod's `ZodError.issues` array and builds an `errors` object keyed by field path, each entry carrying the exact `message` string the failing Zod rule specified (`"Name must be at least 2 characters"`, `"Password must contain at least one uppercase letter"`, etc.).
4. **RHF decides whether to call the caller's `onSubmit`.** If the resolver returned any errors, `handleSubmit` short-circuits: it merges those errors into `formState.errors`, triggers a re-render of exactly the fields whose error state changed (not the whole form), and returns — the function passed to `handleSubmit(onSubmit)` **never runs**. If the resolver returned no errors, `handleSubmit` calls `onSubmit(values)` with the schema's validated, parsed data.
5. **A failing field's error becomes visible without any manual wiring.** Because `formState.errors.password` (say) is now set, the next render of `<FormField name="password">` causes `useFormField()` (§3.4) to read that error via `getFieldState("password", formState)`, and `<FormMessage />` inside that same `FormField`'s `render` prop renders `String(error.message)` — the exact string Zod's `.regex(..., "Password must contain at least one uppercase letter")` call specified. No component in this chain explicitly passes an error string anywhere; it flows entirely through RHF's `formState` and the two nested Contexts `FormField`/`FormItem` establish.
6. **On success, `onSubmit(values)` fires the React Query mutation.** In the sign-up form, that's `mutate(values, { onSuccess, onError })` from `useMutation({ mutationFn: registerMutationFn })`. `registerMutationFn` (in `client/src/lib/api.ts`) is the axios call that actually reaches the network — `POST /api/auth/register` — meaning the *only* request AstriX's Zod validation gates is this one call, to this one endpoint; there's no earlier or parallel path that could reach the API with unvalidated `values`.
7. **The request lands on the backend, which validates again, independently.** `registerUserController` calls `registerSchema.parse(req.body)` as the very first line of the handler (`backend/src/controllers/auth.controller.ts:62`, traced in full in [`docs/backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) §4) — a second, completely independent Zod parse, against a second, independently-maintained Zod schema. §6 below is about exactly why that duplication is not redundant, but mandatory.
8. **If the backend's Zod schema rejects something the frontend's schema accepted** — the scenario this chapter's Debug Drill (§8) is built around — the request comes back as a 400 with the backend's error-response shape (`{ message, errors: [{ field, message }], errorCode }`, per the backend chapter's §4), and `registerMutationFn`'s promise rejects. RHF's `formState.errors` is never updated by this — the frontend's client-side validation already "passed" this data; the rejection surfaces only through the mutation's `onError` callback, which in this form routes it to a generic toast (`toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" })`) rather than back into a specific field's `<FormMessage />`. That's a real, observable UX gap worth naming here rather than only in the Debug Drill: a client-side-valid, server-rejected submission produces a toast, not a red field-level message, because nothing in this form's `onError` handler maps the backend's per-field `errors` array back onto RHF's `setError()`.

---

## 5. Design Decisions & Tradeoffs

**Why `react-hook-form` over Formik or uncontrolled-native, for this codebase specifically.** AstriX's forms are embedded inside a component tree that already re-renders somewhat aggressively — `AppLayout` sits under `AuthProvider`, which itself composes several React Query hooks (see [`docs/frontend/00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) §3) — so minimizing incidental re-renders inside a form (RHF's core value proposition over Formik) is a real, not theoretical, benefit here: a form re-rendering on every keystroke inside an already-busy authenticated shell is a more expensive mistake than the same thing would be in a smaller app. Plain uncontrolled/`FormData` forms (§1a) were never a serious contender once Zod was already the chosen validation library on the backend (see below) — hand-wiring per-field error display and disabled-submit-while-invalid logic for every form, when a library does it for free and composes cleanly with a schema already being maintained for other reasons, is not a trade AstriX's actual forms (multi-field, with real validation rules) would come out ahead on.

**Why Zod specifically, and why the resolver pattern over RHF's built-in validation.** RHF ships its own inline validation rules (`register("email", { required: true, pattern: /.../ })`), which would have been a perfectly valid choice for simple forms and requires no additional dependency. AstriX didn't use that path, for a reason visible directly in the code: the backend had already committed to Zod as its validation library (see [`docs/backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) §2), and Zod's `z.infer<>` mechanism gives the same "schema *is* the type" guarantee on the frontend that it gives on the backend. Using RHF's resolver interface rather than its inline rules means the validation logic itself is expressed once, in one library's syntax, reusable in principle across any consumer that can call `.parse()`/`.safeParse()` — not RHF-specific validation-rule syntax that would have to be re-learned or re-expressed if the form library were ever swapped.

**What AstriX gave up by not sharing schemas between client and server.** This is the load-bearing tradeoff of the whole chapter, and it needs to be stated precisely rather than gestured at. Verified directly — `grep -rn "from [\"'].*backend" client/src` and a search for any monorepo-style shared package (`shared/`, npm workspaces in the root `package.json`, a `client` import of anything under `backend/src`) all come back empty. The one hit for the string `backend/src` anywhere in `client/src` is a comment in `client/src/lib/access-token.ts` referencing `backend/src/utils/jwt.ts` as prose documentation, not an import. **The frontend and backend Zod schemas are two independently hand-maintained sets of code, not one shared source of truth.** `formSchema` in `Sign-up.tsx` and `registerSchema` in `backend/src/validation/auth.validation.ts` happen to enforce the same rules today (both require `name` 2–50 chars, a valid email, and `passwordSchema`'s five password rules) because whoever wrote the frontend form copied the backend's rules faithfully by hand — but there is no mechanism, compiler, lint rule, or test that would catch the two schemas drifting apart if only one of them were edited in a future change. §6 and §8 both return to exactly what that costs and how you'd notice it happening.

**A real, already-existing instance of that drift — small, but real.** Compare `backend/src/validation/auth.validation.ts`'s password rule messages to `client/src/lib/password.ts`'s: the backend's final regex check reads `"Password must contain at least one special character (!@#$%^&*)"`; the frontend's `passwordSchema` (used by both the sign-up form and, indirectly, shown to the user via the separately-hand-maintained `passwordRequirements` array) reads `"Password must contain at least one special character"` — missing the `(!@#$%^&*)` suffix. The *rule* is identical (same regex, `/[^A-Za-z0-9]/`), so this isn't a functional bug — a password that satisfies one satisfies the other — but it's a live, observable instance of exactly the maintenance risk described above: two humans, at two different times, typed out "the same" validation message into two different files, and the messages already don't match character-for-character. That's the shape schema drift takes in practice — not usually a dramatic functional break on day one, but a slow divergence that compounds every time either side is edited without the other.

---

## 6. Security Considerations

**Client-side Zod validation is a UX/DX convenience. It is never, by itself, a security boundary.** The browser executing this code is fully attacker-controlled: anyone can open devtools and edit `formSchema` at runtime, submit the underlying `fetch`/axios call directly from the console with any payload they want, bypass the UI entirely with `curl` or Postman against `POST /api/auth/register`, or serve a modified copy of the bundle from a proxy. Every `zodResolver(formSchema)` call this chapter has traced only prevents `onSubmit` from firing *inside this specific rendered form, in an unmodified browser, for a user who isn't trying to bypass it.* None of that is a meaningful claim about what the backend actually receives. This is precisely why [`docs/backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) exists as a separate, mandatory chapter rather than this one being sufficient on its own: **the real trust boundary is `registerSchema.parse(req.body)` running inside `registerUserController`, on the server, on data the client has zero ability to suppress or modify after it leaves the browser.** Every request AstriX's frontend Zod schemas "validate" is re-validated, independently, by the backend's own Zod schemas before any service function or database write ever sees it (traced in that chapter's §3–4) — and per §5 above, those are two separately-maintained schemas, not the same code running twice, which is exactly why the backend chapter's validation sweep (its §6) matters on its own merits rather than as a formality: it has to independently confirm every mutating backend route actually validates, because it cannot assume the frontend already did the real work.

**The password-strength indicator, specifically, is UX feedback with zero security function of its own.** `PasswordStrengthIndicator` (§3.3) runs five regexes against `watchedPassword` and paints checkmarks — it does not call `passwordSchema.parse()`, does not read from RHF's `formState`, and has no connection whatsoever to whether the form can be submitted. Its only job is to make the *existing* Zod rule (already enforced by `zodResolver`, already re-enforced by the backend) visible to the user *before* they hit submit and get a wall of errors at once — pure latency reduction on feedback, not an additional check. It's worth being precise about which layer would actually stop a bad password: neither the indicator nor the form's client-side Zod schema does, since both live in attacker-controlled code; the backend's own `passwordSchema.parse()` in `auth.validation.ts` (identical rules, independently maintained per §5) is what actually rejects a weak password no matter how the request was constructed.

**Passwords are never logged, and form values only ever reach the intended endpoint.** A direct check of the codebase confirms there is no `console.log`/`console.error`/`console.warn` call anywhere in `client/src/page/auth`, `client/src/components/auth`, or `client/src/components/workspace/project` that could leak a password or form value to the browser console, and no analytics, error-reporting, or session-replay SDK (Sentry, LogRocket, PostHog, Datadog, Mixpanel — none appear anywhere in `client/src`) exists in this codebase at all. That means the honest answer to "could a form value accidentally end up in an unrelated payload" is that there's currently no unrelated payload-sending mechanism present to leak into — every mutation function in `client/src/lib/api.ts` sends its `values`/`data` argument to exactly one, hard-coded API path (`registerMutationFn` → `/auth/register`, `createProjectMutationFn` → `/project/workspace/${workspaceId}/create`) via the single shared axios instance, and nothing else in the client reads or forwards form values. This is worth flagging as an absence rather than a mitigation: the *reason* nothing leaks today is that nothing exists that could, not that leakage was specifically guarded against — if error-reporting were added later (a reasonable, likely addition — see [`09-error-handling-loading-states-and-resilience.md`](./09-error-handling-loading-states-and-resilience.md) for the current, more limited error-boundary story), it would need to explicitly scrub password fields from whatever context object it captures, the same way any Sentry/Datadog integration needs a `beforeSend` scrubber for exactly this reason.

**`autoComplete` and `type="password"` are used correctly on the one password field examined.** The sign-up form's password `<Input>` carries `type="password"` (so the browser masks the characters and, more importantly, never offers it as an autofill suggestion for unrelated fields) and `autoComplete="new-password"` — the correct token for an account-creation field, which tells a password manager "this is a new credential to be generated/saved," as distinct from `autoComplete="current-password"` (correct for a *sign-in* form's password field, not examined in the file list this chapter was scoped to, but the same correctness question would apply there). `name` and `email` carry `autoComplete="name"` and `autoComplete="email"` respectively — both correct, standard tokens. None of the three fields examined use `autoComplete="off"` on a credential field (a common, real anti-pattern that actively fights password managers and pushes users toward reusing weaker, memorable passwords) — AstriX's forms get this right.

**Client-side validation's genuine, non-security value: it's still worth having.** None of the above is an argument against client-side Zod validation — it's an argument against treating it as *sufficient*. A user who mistypes their email gets told immediately, without a round trip to the server; a weak password gets flagged with a live, specific checklist before the user even attempts to submit. That's real UX value, and it's also real *server load* value — a well-formed client-side check catches most honest mistakes before they ever generate a request, leaving the backend's validation pass to do what it's actually for: being the check that holds even when the client is lying.

---

## 7. Best Practice Check

As of 2026, `react-hook-form` paired with Zod via `@hookform/resolvers` is close to the default recommendation for a new React SPA's form layer — RHF won the performance/DX argument against Formik years ago for anything client-rendered, and Zod's ecosystem gravity (TypeScript-first inference, the same `z.infer<>` mechanism this chapter and the backend chapter both lean on, broad tooling support) makes it the natural schema partner. AstriX's stack choice here is squarely current, not a dated-but-reasonable holdover — the same conclusion [`docs/backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) §7 reaches about the backend's own Zod usage.

The shadcn/ui `form.tsx` wrapper pattern (copy-in source, not an installed black box) is also squarely in line with 2026 practice for teams that want Radix-level accessibility primitives without taking on a full component-library dependency (MUI, Chakra) or hand-rolling ARIA wiring themselves — that broader tradeoff belongs to [`08-ui-component-library-and-styling.md`](./08-ui-component-library-and-styling.md), but the RHF-specific piece of it (`useFormField()` correctly deriving `aria-invalid`/`aria-describedby` from `formState`, examined in full in §3.4) is exactly the kind of glue code most teams would otherwise have to write themselves, and AstriX gets it for free by having copied a well-maintained community pattern rather than inventing its own.

**Where AstriX is genuinely behind 2026-current practice: schema sharing.** §5 already established, by checking imports rather than assuming, that AstriX's frontend and backend Zod schemas are independently duplicated, and §5 already found one small, real instance of the two having drifted (the password error-message text). A 2026-idiomatic full-stack TypeScript codebase increasingly treats this as a solved problem rather than an accepted cost — the two most common current patterns are (1) a shared package inside a monorepo (an npm/pnpm workspace with a `packages/shared-schemas` directory both `client` and `backend` import from, so `registerSchema` is one file, not two) or (2) an end-to-end-typed RPC layer like tRPC, which goes further and removes the need for either side to hand-declare a matching request/response type at all. AstriX's repo layout — `client/` and `backend/` as two independently-deployed projects with no workspace tooling connecting them (confirmed: no `workspaces` field in the root `package.json`, no `packages/` directory) — doesn't currently support either pattern without a real restructuring effort. This is a legitimate, worth-flagging gap, not a dramatic one: the schemas are small, the domains they cover are stable, and the drift found in §5 is cosmetic (a message string) rather than functional (a rule that actually differs) — but it is exactly the kind of gap that gets worse, not better, as more forms and more validation rules accumulate on both sides independently, and it's the honest, checkable answer the task of writing this chapter set out to find rather than assume.

---

## 8. Debug Drill

**Scenario:** A form submits successfully client-side — no red `<FormMessage />` anywhere, the submit button was never disabled, `zodResolver` clearly returned no errors — but the server rejects it with a validation error the user never saw coming, surfacing only as a generic toast (per §4 step 8) or, worse, an unhandled console error if a form's `onError` handler doesn't cover it. Where do you look, and in what order?

1. **Confirm it's actually a schema mismatch, not an authorization or business-logic rejection wearing a validation-shaped error.** Open the network tab, find the failed request, and read the actual response body. AstriX's backend error shape (per [`docs/backend/04-error-handling-patterns.md`](../backend/04-error-handling-patterns.md)) distinguishes a `ZodError`-sourced 400 (with a `errors: [{ field, message }]` array) from other error types — if the response isn't that shape, the bug isn't in validation at all, and the rest of this drill doesn't apply. If it is that shape, note exactly which `field` and `message` came back.
2. **Open both schemas side by side and diff them field by field.** Find the frontend `z.object()` the failing form uses (e.g. `formSchema` inline in the page/component file, per §3.2/§3.5's pattern) and the backend schema the corresponding controller calls `.parse()` against (in `backend/src/validation/*.ts`). Per §5, these are two separately hand-maintained files with no shared source — the most likely cause, and the first thing to check, is that one was edited and the other wasn't: a `.max()` bound tightened on one side, a new `.regex()` rule added to one but not mirrored to the other, a field made `.optional()` on the frontend but still required on the backend (or vice versa). §5 already surfaced one real, if cosmetic, instance of exactly this kind of divergence in the password-rule error message — the mechanism this drill is describing isn't hypothetical.
3. **If the schemas genuinely match on paper, suspect the resolver wiring, not the schema.** Confirm `useForm()` actually has `resolver: zodResolver(formSchema)` set — and that it's pointing at the schema you just read, not an older or differently-named one left over from a refactor (a component with two similarly-named schemas in scope, e.g. a local `formSchema` shadowing an imported one, is an easy way for this to go wrong silently). Also confirm the field is actually registered under the name the schema expects: a `<FormField name="emial">` typo (matching neither the JSX label nor the schema key) means RHF is tracking a field the Zod schema never validates at all — it would silently pass client-side (Zod never sees a key that doesn't exist in the object it validates, since the typo'd field isn't part of `formSchema`'s shape either, if the mismatch is between the DOM field name and the *submitted* values object) while the backend, receiving whatever the actual `<input name="...">` sent, could validate a completely different key path than the one the frontend author intended.
4. **Rule out a browser-specific native-validation interaction if the field is an `<input type="email">` (or similar) and the failure is inconsistent across machines.** The browser's own native constraint validation (the built-in tooltip a Chromium/Firefox/Safari browser shows for a malformed `type="email"` value) runs *independently* of Zod and RHF — it's a separate, browser-implemented check that can pass or fail per-browser based on that browser's own email-format heuristics, which are not identical to Zod's `.email()` regex-based check, and are not identical to the backend's own `.email()` check either (both are "close to RFC 5322" but not byte-for-byte the same grammar). A value like `test@localhost` (no TLD) or an address with an unusual-but-technically-valid character is a realistic case where one browser's native validation blocks submission (or auto-corrects/trims the value) before RHF/Zod ever see it, while a colleague on a different browser sees the native check pass and gets all the way to Zod's own (possibly stricter or looser) `.email()` check. If a teammate reports "it validates fine for me but not for you" on the exact same typed input, this is the first thing to suspect before assuming either Zod schema is wrong — the difference may not be in any code AstriX owns at all.
5. **Once the actual divergent rule is identified, fix it in both schemas, not just the one that surfaced the bug.** Because there's no shared source (§5, §7), fixing only the schema that happened to produce the confusing UX leaves the other one silently different — which is the same class of bug, just inverted. This is also the point at which it's worth asking, per §7's Best Practice Check, whether the specific rule that drifted is one more instance of a pattern that would stop recurring if the two schemas were ever consolidated into one shared definition — not a fix to make in the moment, but the right question to be asking if this drill keeps recurring on the same form.

---

**Related chapters:** [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) for the provider tree and tech-stack table these forms sit inside; [`08-ui-component-library-and-styling.md`](./08-ui-component-library-and-styling.md) for the shadcn/Radix/Tailwind story behind `components/ui/form.tsx` and its sibling components; [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md) for what happens to the sign-up form's output after submission — token storage, the auth-route guards, and the OAuth alternative surfaced by `GoogleOauthButton`; [`../backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) for the backend half of every trust-boundary claim made in §6 above.
