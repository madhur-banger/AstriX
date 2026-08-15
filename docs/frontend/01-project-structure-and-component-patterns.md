# Project Structure & Component Patterns

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

Every frontend answers two structural questions whether or not the team ever discusses them explicitly: **where does a new file go**, and **how does a cross-cutting concern — something that isn't really "a feature" but touches many of them, like "can this user see this button" — get reused without being copy-pasted into every component that needs it?** This chapter covers both, because AstriX's answers to them are related: the same permission-checking logic (`hasPermission()`, sourced from [`context/auth-provider.tsx`](./06-authentication-and-authorization-ui.md)) gets reused through two genuinely different composition patterns depending on where in the tree it's applied, and understanding why requires first understanding the landscape of folder-organization and component-composition choices a frontend can make.

---

## 1. The Landscape

### 1.1 Where does a new file go? Four real answers

#### (a) Type-based / layer-based folders

Files are grouped by **what kind of thing they are** — every route-level screen lives in one folder, every reusable UI piece in another, every data-fetching hook in a third — regardless of which feature or domain they belong to. This is the default shape of a huge fraction of React tutorials, Create React App scaffolds, and mid-size production apps that never explicitly chose an architecture; it's what you get by following "put components in `components/`" without ever asking a follow-up question.

A generic sketch of the pattern (not AstriX's actual tree — just the shape):

```
src/
├── pages/
│   ├── Dashboard.tsx
│   └── Settings.tsx
├── components/
│   ├── Button.tsx
│   └── UserCard.tsx
├── hooks/
│   ├── useAuth.ts
│   └── useOrders.ts
└── lib/
    └── api.ts
```

The axis of organization is *technical role* — a page, a component, a hook — not *domain*. Everything needed to render the "orders" screen might be spread across `pages/Orders.tsx`, three or four files in `components/`, `hooks/useOrders.ts`, and a slice of `lib/api.ts`, none of them adjacent in a directory listing. The appeal is the same one layered backends offer (see [`docs/backend/01-architecture-patterns-and-project-structure.md`](../backend/01-architecture-patterns-and-project-structure.md) for the backend's version of this exact argument): total predictability. Any engineer, without knowing anything about "orders" as a concept, knows a page goes in `page/`, a hook goes in `hooks/`, and a reusable bit of UI goes in `components/`. The cost is the same, too — touching one feature end-to-end means opening several folders, and nothing about the folder tree stops a component that belongs conceptually to "orders" from silently growing a dependency on something that belongs to "billing."

#### (b) Feature-based / vertical-slice folders

Flip the axis: group by **feature or domain** instead. Everything an "orders" screen needs — its page, its components, its hooks, sometimes its own types — lives together in one folder, and a `shared/` folder holds only what's genuinely used by more than one feature. The most widely cited reference implementation of this shape in the React community is [`bulletproof-react`](https://github.com/alan2207/bulletproof-react) (Konstantin Lebedev's open-source architecture guide, one of the most-starred React architecture references on GitHub), whose top-level convention looks like:

```
src/
├── features/
│   ├── orders/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── api/
│   │   └── types.ts
│   └── billing/
│       ├── components/
│       ├── hooks/
│       └── api/
└── shared/
    ├── components/
    └── hooks/
```

`bulletproof-react`'s own stated rule is stricter than it looks at first glance: features are not allowed to import from each other directly — anything two features both need has to be promoted into `shared/`, which is enforced in practice with an ESLint import-boundary rule rather than left to convention. That's the real payoff: a contained blast radius (deleting "orders" is close to deleting one folder) *and* a lint-enforced boundary, not just a folder-naming convention someone has to remember. The cost mirrors the backend's feature-based tradeoff exactly — cross-cutting concerns (auth, a global toast system, a design-system button) don't have an obvious home inside any one feature, so the `shared/` folder tends to regrow into its own de facto type-based structure over time, and a team has to actively maintain the "nothing feature-specific leaks into `shared/`" discipline or the whole benefit erodes.

#### (c) Atomic design

Brad Frost's atomic design methodology (from his 2013 book/blog series of the same name) organizes purely by **UI composition scale**, borrowed from chemistry as a metaphor: atoms (a button, an input, a label — the smallest indivisible UI pieces) compose into molecules (a labeled input with validation text), which compose into organisms (a full search bar with a dropdown), which get arranged into templates (page-level layout skeletons with placeholder content), which become pages (a template filled with real data).

```
src/
├── atoms/
│   ├── Button.tsx
│   └── Input.tsx
├── molecules/
│   └── SearchField.tsx
├── organisms/
│   └── SiteHeader.tsx
├── templates/
│   └── DashboardTemplate.tsx
└── pages/
    └── DashboardPage.tsx
```

This is a genuinely different axis from both (a) and (b) — it says nothing about domains or technical roles like hooks/services, and everything about visual composition hierarchy. It shows up most often in design-system-heavy organizations (Frotend teams shipping a component library alongside a product, e.g. many enterprise design systems explicitly cite atomic design in their documentation) where the whole point is a strict, reusable visual vocabulary. The honest cost is that the five-tier taxonomy is famously hard to apply consistently in practice — reasonable engineers disagree constantly about whether a given component is a molecule or an organism, and the category boundaries add ceremony without adding much value for a product-feature team that isn't primarily building a shared design system. **AstriX doesn't do this anywhere** — there's no `atoms/`/`molecules/`/`organisms/` distinction in `client/src`; it's mentioned here purely as a landscape contrast.

#### (d) Colocation-by-route (framework-enforced)

The newest of the four, and the one most tied to a specific tooling convention rather than a team choice: file-based routing frameworks — Next.js's `app/` directory being the dominant example — make the *folder structure itself* the routing table, and encourage colocating a route's private components directly next to the route file that uses them, using a naming convention (Next.js's leading-underscore `_components/`) to mark them as non-routable.

```
app/
├── orders/
│   ├── page.tsx
│   ├── _components/
│   │   └── OrderTable.tsx
│   └── loading.tsx
└── billing/
    ├── page.tsx
    └── _components/
        └── InvoiceCard.tsx
```

This is feature-based folders' contained-blast-radius benefit taken further: the route *is* the feature boundary, enforced by the framework's own file-system conventions, not by a team's discipline or a lint rule. It only makes sense inside a framework that reads the filesystem as routing config in the first place — a plain Vite + `react-router-dom` SPA like AstriX has no filesystem-to-route mapping at all (routes are hand-declared as data; see [`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md)), so this convention has no natural home to attach to without adopting a meta-framework AstriX doesn't use. **AstriX doesn't do this** — routes are config, not folders — mentioned here because it's the convention most engineers coming from a modern Next.js/Remix background will expect by default in 2026, and its absence in AstriX is a deliberate consequence of not using a meta-framework, not an oversight.

| Pattern | Organizes by | Strongest guarantee | Steepest cost |
|---|---|---|---|
| Type-based / layer-based | technical role | predictable, fast to onboard, zero ceremony | touching one feature opens several folders; no boundary stops cross-feature reach |
| Feature-based / vertical-slice (`bulletproof-react`) | domain/feature | contained blast radius, lintable import boundaries | cross-cutting concerns need an explicit `shared/` home or duplicate |
| Atomic design | visual composition scale | strict, reusable design-system vocabulary | five-tier taxonomy is hard to apply consistently; orthogonal to domain/data concerns |
| Colocation-by-route (Next.js `app/`) | route/URL structure | framework-enforced boundary, zero manual routing table | only available inside a file-based-routing framework |

### 1.2 How does a cross-cutting concern get reused? Four real answers

Folder structure answers "where does code live." A separate question is "how does one piece of logic — like 'is this user allowed to see this' — get applied across many unrelated components without being copy-pasted into each one?" React's history has produced four distinct answers, and AstriX's own codebase uses two of them side by side (see §3), which is exactly why this half of the landscape matters here.

**Higher-order components (HOCs).** A function that takes a component and returns a new component wrapping it with extra behavior — `const Enhanced = withSomething(MyComponent)`. This was the dominant pattern for cross-cutting concerns in the pre-hooks era (React 0.14 through roughly 2018): Redux's `connect()`, the original `react-router` v4/v5 `withRouter()`, and Relay's `createFragmentContainer()` are all HOCs.

```jsx
// illustrative HOC pattern — not AstriX code
const withAuth = (WrappedComponent) => (props) => {
  const user = useCurrentUser();
  if (!user) return <Redirect to="/login" />;
  return <WrappedComponent {...props} />;
};

const ProtectedDashboard = withAuth(Dashboard);
```

**Tradeoffs:** an HOC can run logic — redirects, loading gates — *before* the wrapped component ever renders, and it composes at the point a component is exported/declared, which reads naturally for "gate this entire screen." The costs are real and well documented: wrapping components loses `displayName` unless handled manually (hurting DevTools debugging), props can collide or get shadowed between what the HOC injects and what the wrapped component expects, and stacking several HOCs on one component ("wrapper hell") produces a component tree that's hard to read from the DevTools inspector — a `Dashboard` wrapped by `withAuth(withTheme(withRouter(Dashboard)))` shows up as several nested anonymous layers.

**Render props.** Instead of wrapping a component, a component takes a function as a prop (often literally named `render`, or `children`) and calls it with whatever data it wants to share, letting the *caller* decide what to render. Classic `react-router` v5 exposed this via `<Route render={...}>`, and libraries like Downshift built their entire public API around it.

```jsx
// illustrative render-props pattern — not AstriX code, react-router v5 era
<Route
  path="/orders/:id"
  render={({ match }) => <OrderDetails orderId={match.params.id} />}
/>
```

**Tradeoffs:** render props avoid HOC's naming/prop-collision problems — there's no wrapper component obscuring the tree — but they nest awkwardly when a component needs data from *multiple* render-prop providers (a `<DataProvider render={data => <ThemeProvider render={theme => ...} />} />` pyramid), and the pattern reads unfamiliar to engineers who've only worked in a post-hooks codebase, since hooks solved the same problem more directly for most cases.

**Custom hooks.** Since React 16.8 (2019), a function component can call a `use*` function to pull in shared, stateful logic without any wrapping or nesting at all — `const { user, hasPermission } = useAuth();` inside the component body. This has been the default answer for "share cross-cutting logic" for most of the industry since hooks shipped, precisely because it sidesteps HOC's wrapper-tree problem and render-props' nesting problem simultaneously — the logic is just a function call, and the component stays exactly one component.

```jsx
// illustrative custom-hook pattern — not AstriX code
function EditButton() {
  const { hasPermission } = usePermissions();
  if (!hasPermission("EDIT_ORDER")) return null;
  return <button>Edit</button>;
}
```

**Tradeoffs:** hooks are the lightest-weight of the four and the one that reads most naturally to anyone who's learned React since 2019, but a hook can only *decide*, in the calling component's own render — it can't wrap the JSX output the way an HOC or a children-consuming component can. If the goal is "keep the visibility check separate from every component that needs it, and make it impossible for a component to forget to call it," a bare hook that each component must remember to call and act on is weaker than a wrapper that structurally enforces the check.

**Children-as-composition.** A component accepts `children` and decides, based on some condition, whether to render them at all — the logic lives in one place, but instead of taking over the whole render tree (like an HOC) or requiring a function-as-prop (like render props), it just conditionally passes through whatever JSX was written between its open and close tags. This is a specific, simpler case of the "compound components" family of patterns, and it's become the idiomatic post-hooks answer for exactly the "sometimes render this subtree, sometimes don't" problem — React's own `<Suspense>` and `<ErrorBoundary>`-style APIs (and libraries like Radix UI's primitives, which AstriX itself uses — see [`08-ui-component-library-and-styling.md`](./08-ui-component-library-and-styling.md)) are built the same way.

```jsx
// illustrative children-as-composition pattern — not AstriX code
function Guard({ isAllowed, children }) {
  if (!isAllowed) return null;
  return <>{children}</>;
}

<Guard isAllowed={hasPermission("EDIT_ORDER")}>
  <button>Edit</button>
</Guard>;
```

**Tradeoffs:** this keeps the calling site's JSX shape unchanged (no wrapper component appearing in the DevTools tree the way an HOC's does, since `<>{children}</>` is a fragment) and makes the "this content is conditionally gated" fact visually obvious at the call site — a `<Guard>` wrapping some JSX reads, at a glance, as "this might not render." The limitation is that it's purely a rendering decision made *inline*, at the point something is already being rendered — it has no natural way to run a side effect like a redirect before the surrounding page even mounts, which is exactly the gap HOCs (and hooks combined with `useEffect`) can fill instead.

| Pattern | Mechanism | Best for | Weakest at |
|---|---|---|---|
| HOC | wraps a component, returns a new one | gating an entire screen/route, pre-render side effects (redirects) | naming/DevTools clarity, prop collisions, stacking multiple |
| Render props | a function-as-prop the consumer calls | flexible, caller-controlled rendering of shared data | nests awkwardly with multiple providers; unfamiliar post-hooks |
| Custom hooks | a `use*` function called in the component body | sharing stateful logic without any wrapping at all | can't itself wrap/gate JSX; each caller must remember to act on it |
| Children-as-composition | conditionally renders `children` | inline, visually-obvious conditional rendering of a subtree | no natural place for a pre-render side effect like a redirect |

---

## 2. AstriX's Choice

AstriX's folder structure is **type-based / layer-based** at the top level of `client/src` — `page/`, `components/`, `hooks/`, `lib/`, `store/`, `context/`, `hoc/`, `routes/`, one folder per technical role, not one folder per domain — with a secondary, informal domain grouping applied *only* one level down, inside `components/` itself (`components/workspace/`, `components/account/`, `components/asidebar/`, `components/auth/`), which is a detail worth taking seriously rather than glossing over (§5). For cross-cutting permission gating specifically, AstriX doesn't pick one composition pattern — it deliberately uses **both an HOC (`hoc/with-permission.tsx`) and a children-as-composition component (`components/reusable/permission-guard.tsx`)**, applying each where its specific strength matches the job: the HOC for gating an entire route-level page (where a redirect side effect is needed), the children-guard for conditionally hiding a piece of UI inside an already-rendered page (where no redirect is wanted, just a hide/show decision).

---

## 3. AstriX Implementation

### 3.1 The real top-level folder tree

Produced by `find client/src -maxdepth 2 -type d | sort`, run directly against the current source rather than assumed from memory:

```
client/src
client/src/__tests__
client/src/assets
client/src/components
client/src/components/__tests__
client/src/components/account
client/src/components/asidebar
client/src/components/auth
client/src/components/emoji-picker
client/src/components/logo
client/src/components/reusable
client/src/components/skeleton-loaders
client/src/components/ui
client/src/components/workspace
client/src/constant
client/src/context
client/src/context/__tests__
client/src/hoc
client/src/hoc/__tests__
client/src/hooks
client/src/hooks/__tests__
client/src/hooks/api
client/src/layout
client/src/lib
client/src/lib/__tests__
client/src/page
client/src/page/account
client/src/page/auth
client/src/page/errors
client/src/page/home
client/src/page/invite
client/src/page/legal
client/src/page/workspace
client/src/routes
client/src/routes/__tests__
client/src/routes/common
client/src/store
client/src/test
client/src/types
```

Read the top level only (ignore the nesting for a moment): `components`, `constant`, `context`, `hoc`, `hooks`, `layout`, `lib`, `page`, `routes`, `store`, `test`, `types`. Every one of those names describes *what kind of file lives there*, not *what feature it belongs to* — there is no `orders/`, no `workspace-feature/`, no `billing/` at this level. That's the type-based pattern from §1.1(a), applied for real. Now look one level into `components/` and `page/`: `components/workspace`, `components/account`, `components/asidebar`, `components/auth` are domain names, and `page/workspace`, `page/account`, `page/auth`, `page/invite`, `page/legal` are too. Domain grouping exists in AstriX — it just doesn't exist at the top level, and it doesn't exist consistently across every folder (`hooks/`, `lib/`, `store/`, `hoc/` have no domain subfolders at all; every hook sits in one flat list regardless of which feature it serves). §5 covers why that specific, partial split is a reasonable middle ground rather than an inconsistency to fix.

### 3.2 The HOC: `hoc/with-permission.tsx`

```tsx
// client/src/hoc/with-permission.tsx:1-37
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PermissionType } from "@/constant";
import { useAuthContext } from "@/context/auth-provider";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const withPermission = (
  WrappedComponent: React.ComponentType,
  requiredPermission: PermissionType
) => {
  const WithPermission = (props: any) => {
    const { user, hasPermission, isLoading } = useAuthContext();
    const navigate = useNavigate();
    const workspaceId = useWorkspaceId();

    useEffect(() => {
      if (!user || !hasPermission(requiredPermission)) {
        navigate(`/workspace/${workspaceId}`);
      }
    }, [user, hasPermission, navigate, workspaceId]);

    if (isLoading) {
      return <div>Loading...</div>;
    }

    // Check if user has the required permission
    if (!user || !hasPermission(requiredPermission)) {
      return;
    }
    // If the user has permission, render the wrapped component
    return <WrappedComponent {...props} />;
  };
  return WithPermission;
};

export default withPermission;
```

This is a textbook instance of §1.2's HOC pattern: `withPermission` is a function that takes a component and a required permission, and returns a *new* component (`WithPermission`) that decides, on every render, whether the original component gets to render at all. Three things about this specific implementation are worth flagging before moving on, because they're the kind of detail a "gate a whole page" job actually needs and a bare hook alone couldn't provide as cleanly:

1. The redirect (`navigate(...)`) happens inside a `useEffect`, not inline during render — React forbids triggering navigation as a side effect of rendering itself, so the effect runs *after* the component has committed once, checks the same condition again, and only then redirects if it's still unmet.
2. The unauthorized-and-not-loading branch (`if (!user || !hasPermission(requiredPermission)) return;`) returns `undefined` — React renders nothing — *before* the effect's redirect has necessarily completed. That ordering matters for the security discussion in §6: the wrapped component's JSX is never constructed at all on an unauthorized render, not merely hidden by CSS.
3. `<any>` shows up explicitly, with an ESLint disable comment acknowledging it (`/* eslint-disable @typescript-eslint/no-explicit-any */`) — a generic HOC that can wrap *any* component's props has a structural reason for needing it (TypeScript can't infer the wrapped component's prop shape from inside the HOC's own generic-less signature), unlike an unjustified `any` used purely to silence a type error the author didn't want to solve.

### 3.3 The children-as-composition component: `components/reusable/permission-guard.tsx`

```tsx
// client/src/components/reusable/permission-guard.tsx:1-35
import React from "react";
import { PermissionType } from "@/constant";
import { useAuthContext } from "@/context/auth-provider";

type PermissionsGuardProps = {
  requiredPermission: PermissionType;
  children: React.ReactNode;
  showMessage?: boolean;
};

const PermissionsGuard: React.FC<PermissionsGuardProps> = ({
  requiredPermission,
  showMessage = false,
  children,
}) => {
  const { hasPermission } = useAuthContext();
  if (!hasPermission(requiredPermission)) {
    return (
      showMessage && (
        <div
          className="text-center
          text-sm pt-3
          italic
          w-full
          text-muted-foreground"
        >
          You do not have the permission to view this.
        </div>
      )
    );
  }
  return <>{children}</>;
};

export default PermissionsGuard;
```

Same underlying `hasPermission()` call as the HOC, same `useAuthContext()` source — but no `useEffect`, no `useNavigate`, no redirect at all. `PermissionsGuard` is a pure, synchronous rendering decision: either pass `children` through unchanged (the `<>{children}</>` fragment — no wrapper `<div>`, nothing extra in the rendered DOM), or render nothing (or an inline message, if the caller opted in with `showMessage`). This is §1.2's children-as-composition pattern applied exactly as described there.

### 3.4 A representative small UI primitive: `components/ui/button.tsx`

To see what sits at the *other* end of `components/` — the part with no domain grouping at all — here's the shadcn-generated `Button`, one of 27 files in `components/ui/`:

```tsx
// client/src/components/ui/button.tsx:1-58
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

`Button` knows nothing about workspaces, permissions, projects, or any AstriX domain concept at all — it's pure, generic UI (full treatment of the Tailwind/Radix/`cva` stack behind it is in [`08-ui-component-library-and-styling.md`](./08-ui-component-library-and-styling.md)). That's precisely why `components/ui/` sits at the same flat level as `components/workspace/` and `components/account/` rather than being duplicated inside each: it's the one part of `components/` that has no domain to group by in the first place, and mixing it into a domain folder would be a category error — a button variant isn't a workspace concern.

### 3.5 A representative domain-grouped feature component: `components/asidebar/asidebar.tsx`

Contrast `Button` against a component that *does* live inside a domain subfolder, and is genuinely composed of both generic UI pieces and permission-gated ones:

```tsx
// client/src/components/asidebar/asidebar.tsx:1-134
import { useState } from "react";
import { Link } from "react-router-dom";
import { EllipsisIcon, Loader, LogOut, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroupContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import Logo from "@/components/logo";
import LogoutDialog from "./logout-dialog";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { NavMain } from "./nav-main";
import { NavProjects } from "./nav-projects";
import { Separator } from "../ui/separator";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { useAuthContext } from "@/context/auth-provider";
import { AvatarImage } from "@radix-ui/react-avatar";
import { getAvatarFallbackText } from "@/lib/helper";

const Asidebar = () => {
  const { isLoading, user } = useAuthContext();
  const { open } = useSidebar();
  const workspaceId = useWorkspaceId();

  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="!py-0 dark:bg-background">
          <div className="flex h-[50px] items-center justify-start w-full px-1">
            <Logo url={`/workspace/${workspaceId}`} />
            {open && (
              <Link
                to={`/workspace/${workspaceId}`}
                className="hidden md:flex ml-2 items-center gap-2 self-center font-medium"
              >
                AtriX
              </Link>
            )}
          </div>
        </SidebarHeader>
        <SidebarContent className=" !mt-0 dark:bg-background">
          <SidebarGroup className="!py-0">
            <SidebarGroupContent>
              <WorkspaceSwitcher />
              <Separator />
              <NavMain />
              <Separator />
              <NavProjects />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="dark:bg-background">
          <SidebarMenu>
            <SidebarMenuItem>
              {isLoading ? (
                <Loader
                  size="24px"
                  className="place-self-center self-center animate-spin"
                />
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      size="lg"
                      className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                    >
                      <Avatar className="h-8 w-8 rounded-full">
                        <AvatarImage src={user?.profilePicture || ""} />
                        <AvatarFallback className="rounded-full border border-gray-500">
                          {getAvatarFallbackText(user?.name || "")}
                        </AvatarFallback>
                      </Avatar>
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-semibold">
                          {user?.name}
                        </span>
                        <span className="truncate text-xs">{user?.email}</span>
                      </div>
                      <EllipsisIcon className="ml-auto size-4" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                    side={"bottom"}
                    align="start"
                    sideOffset={4}
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuItem asChild>
                        <Link to={`/workspace/${workspaceId}/account/settings`}>
                          <Settings />
                          Account settings
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setIsOpen(true)}>
                      <LogOut />
                      Log out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <LogoutDialog isOpen={isOpen} setIsOpen={setIsOpen} />
    </>
  );
};

export default Asidebar;
```

Look at the import list: `components/ui/sidebar`, `components/ui/dropdown-menu`, `components/ui/avatar` (generic, type-based, domain-agnostic primitives) sit alongside `./logout-dialog`, `./workspace-switcher`, `./nav-main`, `./nav-projects` (sibling files inside the *same* `asidebar/` domain folder) and `@/hooks/use-workspace-id`, `@/context/auth-provider` (cross-cutting, type-based folders again). `Asidebar` itself doesn't call `hasPermission` directly, but one of its own children does — `NavProjects` wraps its "create project" action in exactly the `PermissionsGuard` pattern from §3.3 (confirmed by a direct grep of the source: `components/asidebar/nav-projects.tsx` uses `<PermissionsGuard requiredPermission={Permissions.CREATE_PROJECT}>` three separate times around different pieces of its own UI). This is what "domain-grouped feature component, built from type-based primitives" looks like as an actual file, not an abstraction.

### 3.6 The HOC in production use: gating an entire page

`withPermission` is used exactly once in the whole codebase — to gate the workspace Settings screen behind `MANAGE_WORKSPACE_SETTINGS`:

```tsx
// client/src/page/workspace/Settings.tsx:1-38
import { Separator } from "@/components/ui/separator";
import WorkspaceHeader from "@/components/workspace/common/workspace-header";
import EditWorkspaceForm from "@/components/workspace/edit-workspace-form";
import DeleteWorkspaceCard from "@/components/workspace/settings/delete-workspace-card";
import { Permissions } from "@/constant";
import withPermission from "@/hoc/with-permission";

const Settings = () => {
  return (
    <div className="w-full h-auto py-2">
      <WorkspaceHeader />
      <Separator className="my-4 " />
      <main>
        <div className="w-full max-w-3xl mx-auto py-3">
          <h2 className="text-[20px] leading-[30px] font-semibold mb-3">
            Workspace settings
          </h2>

          <div className="flex flex-col pt-0.5 px-0 ">
            <div className="pt-2">
              <EditWorkspaceForm />
            </div>
            <div className="pt-2">
              <DeleteWorkspaceCard />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

const SettingsWithPermission = withPermission(
  Settings,
  Permissions.MANAGE_WORKSPACE_SETTINGS
);

export default SettingsWithPermission;
```

`Settings` itself is written with zero permission-awareness — no `if (!hasPermission(...))` anywhere in its own body. The gating is applied entirely at the *export boundary*, on the last two lines, wrapping the whole component once. That's the HOC pattern doing exactly what §1.2 said it's best at: gating an entire screen without threading a permission check through the screen's own render logic at all. The route table (`routes/common/routes.tsx`, covered in [`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md)) imports `SettingsWithPermission`, not `Settings` — from the router's perspective there is only ever one component, and it happens to already know how to redirect an unauthorized viewer away.

### 3.7 The children-guard in production use: hiding one piece of UI inside a page

Contrast that with `PermissionsGuard` wrapping a single dangerous action inside `DeleteWorkspaceCard` — a component that itself lives inside the already-permission-checked `Settings` page from §3.6, gating one further, stricter permission (`DELETE_WORKSPACE`, which per the backend's `RolePermissions` table in [`docs/backend/02-authentication-and-authorization.md`](../backend/02-authentication-and-authorization.md) only `OWNER` holds, versus `MANAGE_WORKSPACE_SETTINGS` which `ADMIN` also holds):

```tsx
// client/src/components/workspace/settings/delete-workspace-card.tsx:1-11 (imports), 44-79 (render, excerpted)
import { ConfirmDialog } from "@/components/reusable/confirm-dialog";
import PermissionsGuard from "@/components/reusable/permission-guard";
import { Button } from "@/components/ui/button";
import { Permissions } from "@/constant";
import { useAuthContext } from "@/context/auth-provider";
import useConfirmDialog from "@/hooks/use-confirm-dialog";
import { toast } from "@/hooks/use-toast";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { deleteWorkspaceMutationFn } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
// ...
  return (
    <>
      <div className="w-full">
        <div className="mb-5 border-b">
          <h1
            className="text-[17px] tracking-[-0.16px] dark:text-[#fcfdffef] font-semibold mb-1.5
           text-center sm:text-left"
          >
            Delete Workspace
          </h1>
        </div>

        <PermissionsGuard
          showMessage
          requiredPermission={Permissions.DELETE_WORKSPACE}
        >
          <div className="flex flex-col items-start justify-between py-0">
            <div className="flex-1 mb-2">
              <p>
                Deleting a workspace is a permanent action and cannot be undone.
                Once you delete a workspace, all its associated data, including
                projects, tasks, and member roles, will be permanently removed.
                Please proceed with caution and ensure this action is
                intentional.
              </p>
            </div>
            <Button
              className="shrink-0 flex place-self-end h-[40px]"
              variant="destructive"
              onClick={onOpenDialog}
            >
              Delete Workspace
            </Button>
          </div>
        </PermissionsGuard>
      </div>
      {/* ConfirmDialog omitted — unrelated to the permission-gating pattern being traced here */}
    </>
  );
```

Here the heading ("Delete Workspace") always renders — only the explanatory paragraph and the destructive button are gated, and `showMessage` is passed explicitly so a viewer who has `MANAGE_WORKSPACE_SETTINGS` but not `DELETE_WORKSPACE` sees an explanatory sentence instead of a silent gap in the layout. That's a rendering nuance an HOC genuinely can't express as cleanly — `withPermission` is all-or-nothing at the component boundary; `PermissionsGuard` lets one page mix freely-visible, guard-with-message, and guard-silent regions in the same render tree.

### 3.8 How the HOC is actually tested

```tsx
// client/src/hoc/__tests__/with-permission.test.tsx:1-96
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import withPermission from "@/hoc/with-permission";
import { Permissions } from "@/constant";

const navigateMock = vi.fn();

let mockAuthContext: {
  user: { _id: string } | undefined;
  hasPermission: (permission: string) => boolean;
  isLoading: boolean;
};

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: () => mockAuthContext,
}));

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "ws-1",
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

const Inner = () => <div>Inner content</div>;
const Guarded = withPermission(Inner, Permissions.EDIT_TASK);

describe("withPermission", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it("renders the wrapped component when the user has the required permission", () => {
    // #given a user who has EDIT_TASK
    mockAuthContext = {
      user: { _id: "u1" },
      hasPermission: (p) => p === Permissions.EDIT_TASK,
      isLoading: false,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then the wrapped component renders and no redirect happens
    expect(screen.getByText("Inner content")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("blocks the wrapped component and redirects to the workspace when the permission is missing", () => {
    // #given a logged-in user who lacks EDIT_TASK
    mockAuthContext = {
      user: { _id: "u1" },
      hasPermission: () => false,
      isLoading: false,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then the wrapped component never renders, and the user is redirected
    expect(screen.queryByText("Inner content")).not.toBeInTheDocument();
    expect(navigateMock).toHaveBeenCalledWith("/workspace/ws-1");
  });

  it("blocks the wrapped component when there is no user at all", () => {
    // #given no logged-in user
    mockAuthContext = {
      user: undefined,
      hasPermission: () => true,
      isLoading: false,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then it never renders the protected content
    expect(screen.queryByText("Inner content")).not.toBeInTheDocument();
  });

  it("shows a loading state instead of the wrapped component while auth is resolving", () => {
    // #given auth is still loading
    mockAuthContext = {
      user: undefined,
      hasPermission: () => false,
      isLoading: true,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then a loading indicator shows, not the protected content
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Inner content")).not.toBeInTheDocument();
  });
});
```

Notice what this test suite mocks: `@/context/auth-provider`, `@/hooks/use-workspace-id`, and `react-router-dom` itself — every dependency `withPermission` pulls in — and nothing about `Inner`, the trivial component under test, is mocked at all. That's the standard "mock external dependencies, never the unit under test" discipline applied to an HOC specifically: because `withPermission` is a function that returns a component, the natural unit to render and assert against is the *returned* component (`Guarded`), exercised through all four states its own logic branches on (has permission, lacks permission, no user, still loading) — which is also, not coincidentally, a complete enumeration of every `if` branch inside `WithPermission`'s body in §3.2.

### 3.9 Where `hasPermission()` itself comes from

Both `withPermission` and `PermissionsGuard` call the *same* `hasPermission` function, sourced from one shared context rather than each reimplementing a permission check — the full authentication/authorization-UI story is [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md)'s job, but the construction is worth seeing here since it's the seam both composition patterns in this chapter depend on:

```tsx
// client/src/context/auth-provider.tsx:60-69 (excerpt)
  const permissions = usePermissions(user, workspace);

  const hasPermission = useCallback(
    (permission: PermissionType): boolean => permissions.includes(permission),
    [permissions]
  );
```

```ts
// client/src/hooks/use-permissions.ts:1-22
import { PermissionType } from "@/constant";
import { UserType, WorkspaceWithMembersType } from "@/types/api.type";
import { useMemo } from "react";

// Derived, never stored: switching workspaces recomputes this on the same
// render as the new workspace arrives, so the previous workspace's
// permissions can never leak into the new one.
const usePermissions = (
  user: UserType | undefined,
  workspace: WorkspaceWithMembersType | undefined
): PermissionType[] =>
  useMemo(() => {
    if (!user || !workspace) return [];

    const member = workspace.members?.find(
      (member) => member.userId === user._id
    );

    return member?.role?.permissions ?? [];
  }, [user, workspace]);

export default usePermissions;
```

`usePermissions` — itself a plain custom hook, §1.2's fourth pattern, used here to *compute* the permission list rather than to *gate* a component — reads `member.role.permissions` straight off whatever the `GET /workspace/:id` API response already returned (traced fully in [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md)); it's not a second, independently-maintained source of truth, just a derived, memoized view of data React Query already fetched and cached.

---

## 4. Request/Data Flow

Trace what actually happens, end to end, when a browser navigates to `/workspace/:id/settings` — the route `SettingsWithPermission` (§3.6) is registered against:

1. **The route matches and `AppLayout` mounts first** (per [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) §1's provider tree), which is what mounts `AuthProvider` in the first place — `SettingsWithPermission` cannot call `useAuthContext()` successfully at all unless it's rendered somewhere inside `AppLayout`'s subtree, which every `protectedRoutePaths` route (including Settings) always is.
2. **`AuthProvider` fires its own React Query hooks** — `useAuth()` and `useGetWorkspaceQuery(workspaceId)` — and, while either is still in flight, its own `isLoading` stays `true`. `usePermissions(user, workspace)` (§3.9) returns `[]` until both resolve, since it short-circuits to an empty array whenever `user` or `workspace` is undefined.
3. **`SettingsWithPermission` renders** (it's what the route table actually points at, not the bare `Settings`). Inside `WithPermission`'s body (§3.2), `isLoading` is still `true` at this point, so the branch `if (isLoading) return <div>Loading...</div>;` fires — the real `Settings` page, and the `MANAGE_WORKSPACE_SETTINGS` check, haven't run yet at all.
4. **Once both queries resolve**, `AuthProvider` recomputes `hasPermission` (a new `useCallback` closure over the newly non-empty `permissions` array) and every consumer — including `WithPermission` — re-renders with the updated context value. `WithPermission`'s `useEffect` re-evaluates `!user || !hasPermission(requiredPermission)`.
5. **Branch A — permitted:** the `useEffect` does nothing (the condition is false), and the component falls through to `return <WrappedComponent {...props} />;` — the real `Settings` page renders, including its own `DeleteWorkspaceCard` child.
6. **Branch B — not permitted:** the `useEffect` calls `navigate('/workspace/${workspaceId}')`, and — on this same render, before that navigation has necessarily taken visible effect — the component's own return statement already hit `if (!user || !hasPermission(requiredPermission)) return;`, rendering nothing. There is no frame in which the gated `Settings` content is in the DOM at all for an unauthorized viewer; the redirect and the "don't render" decision are two separate mechanisms (an effect and a return-value check) arriving at the same outcome from the same condition, evaluated on the same render.
7. **Inside the permitted render (Branch A), `DeleteWorkspaceCard` renders its own `PermissionsGuard`** (§3.7). This is a *second*, independent permission check — `DELETE_WORKSPACE`, not `MANAGE_WORKSPACE_SETTINGS` — evaluated purely inline during `DeleteWorkspaceCard`'s own render, no effect, no navigation. An `ADMIN` who passed the outer `withPermission` gate (they have `MANAGE_WORKSPACE_SETTINGS`) can still fail this inner one (they don't have `DELETE_WORKSPACE`), and the observable result is that one paragraph and one button don't render — the rest of the Settings page, including the surrounding card's own heading, renders normally around the gap.

The two patterns compose without either needing to know the other exists: `withPermission` decided whether `Settings` gets mounted at all; `PermissionsGuard`, once mounted, makes its own independent, narrower decision about one subtree — exactly the layered authorization AstriX's backend does too (a route-level `authenticate` check, then a controller-level `roleGuard` check per action, per [`docs/backend/02-authentication-and-authorization.md`](../backend/02-authentication-and-authorization.md) §3.7).

---

## 5. Design Decisions & Tradeoffs

**Why type-based folders over feature-based, at AstriX's current size.** The same argument the backend chapter makes applies here almost unchanged: AstriX's frontend has a small, stable set of domains (auth, workspace, project, task, member, account) and one team working across all of them, not several teams each owning a vertical slice. Type-based folders buy predictability that pays off precisely when the team is small enough that "which folder is this kind of file in" is a more common question than "which feature owns this file" — a `bulletproof-react`-style `features/` split would mean deciding, for every new file, both which feature it belongs to *and* which technical role inside that feature's folder it plays, a small but real per-file tax that a six-domain app with one team doesn't clearly need to pay yet. What AstriX gives up, same as the backend, is a lint-enforced boundary against cross-domain reach — nothing stops a `hooks/api/use-get-projects.tsx` hook from being imported somewhere that conceptually has nothing to do with projects, the way `bulletproof-react`'s ESLint import-boundary rule would flag a feature reaching into another feature directly.

**Why the domain grouping inside `components/` (but nowhere else) is a deliberate middle ground, not an inconsistency.** `components/` is the one top-level folder where a flat list would have gotten unwieldy fastest — UI components multiply far faster than hooks, API functions, or store slices do, because every domain typically needs several (a form, a dialog, a header, a list item, a table). Grouping `workspace/`, `account/`, `asidebar/`, and `auth/` as subfolders *inside* `components/`, while leaving `hooks/`, `lib/`, and `store/` flat, is a pragmatic reading of the actual growth rate of each folder rather than a dogmatic single rule applied everywhere — which is worth naming explicitly because "we're type-based, except where a folder was getting crowded enough that domain-grouping paid for itself locally" is a real, defensible three-word design principle, and a materially different claim than "we're type-based" said without qualification. `components/ui/` staying flat and ungrouped inside the same parent folder is consistent with that reading too: it has no domains to group by in the first place (§3.4), so it's exempt from the question entirely, not an exception to a rule.

**Why an HOC for `Settings` specifically, and a children-guard for `DeleteWorkspaceCard` specifically — not the reverse, and not just one pattern everywhere.** Settings is an entire routed page; unauthorized access to it should mean "you never see this screen, and you're taken somewhere sensible instead" — a redirect, which needs a `useEffect` and `useNavigate`, both of which live naturally inside an HOC wrapping the whole component, and awkwardly inside a component that's supposed to just conditionally render its own children. `DeleteWorkspaceCard`'s delete button is a single dangerous action nested *inside* an already-permitted page; hiding it (optionally with an explanatory message) is exactly `PermissionsGuard`'s job, and redirecting the whole page away because one nested button is off-limits would be actively wrong UX — an `ADMIN` viewing Settings for a totally legitimate reason (editing the workspace name) shouldn't get bounced out of the page entirely just because they lack the separate, stricter `DELETE_WORKSPACE` permission. The pattern choice tracks a real structural difference (page-level gate with a navigation side effect vs. subtree-level gate with none) rather than being an arbitrary stylistic split between two ways of doing the same thing.

**What AstriX gave up by not consolidating on one pattern.** A codebase with exactly one permission-gating primitive is easier to grep for and easier to teach a new engineer in one sentence ("all permission checks go through X"). AstriX's two-primitive split means "how do I gate this new thing" has a real, if simple, answer that depends on context ("is this a whole route, or a piece of an already-rendered page?") rather than a single universal answer — a small but genuine cognitive cost, worth it here because the two use cases (§3.6 vs. §3.7) are different enough in what they need (a side effect vs. a pure render decision) that forcing one pattern to cover both would mean either giving `PermissionsGuard` a redirect capability it doesn't currently need, or making every route wrap itself in the more verbose children-guard shape and hand-roll its own redirect effect per page instead of getting it for free from one shared HOC.

---

## 6. Security Considerations

**Client-side permission gating is a UX affordance, not a security boundary — and this needs to be said plainly, not implied.** Everything in this chapter — `withPermission`'s redirect, `PermissionsGuard`'s conditional render — runs entirely inside the user's own browser, executing JavaScript the user's own machine controls. Nothing stops a technically capable user from opening browser devtools, editing React state, monkey-patching `hasPermission` to always return `true`, or simply calling the underlying API endpoint directly with `curl` or Postman, bypassing the React tree — and therefore both of these components — entirely. `withPermission` and `PermissionsGuard` exist to make the *product* behave sensibly for a legitimate user who lacks a permission (don't show them a button that will just fail, don't let them land on a screen that isn't meant for them) — they are not, and were never designed to be, the thing that actually stops a malicious or merely curious user from performing an unauthorized action. **The real enforcement is server-side**: every mutating endpoint AstriX exposes is protected by `authenticate` plus, per-controller, `roleGuard(role, [Permissions.X])` against the `RolePermissions` map — covered in full in [`docs/backend/02-authentication-and-authorization.md`](../backend/02-authentication-and-authorization.md) §3.7. If a user without `DELETE_WORKSPACE` somehow triggers the delete-workspace API call anyway (devtools, a replayed request, a modified client build), the backend's `roleGuard` throws a `ForbiddenException` regardless of what the frontend rendered or didn't render. The frontend's permission checks and the backend's are **not the same mechanism reused twice** — they happen to check the same underlying `RolePermissions` concept, but the frontend's copy (`constant/index.ts`'s `Permissions` object, shown in §3.9's surrounding context) is a hand-maintained mirror of the backend's enum, not a shared package imported by both sides. A permission added to the backend's `RolePermissions` map without a matching update to the frontend's `Permissions` constant would silently leave the *UI* unaware of a capability that the *API* would actually allow — the reverse of the usual worry, and worth testing for specifically rather than assuming the two always stay in lockstep by construction.

**What the HOC's "return nothing before redirecting" behavior does and doesn't protect against.** §3.2 and §4 traced that `WithPermission` never constructs the wrapped component's JSX on an unauthorized render — this matters because it means no sensitive *rendered content* (a workspace's data already fetched into `AuthProvider`'s React Query cache) is exposed even momentarily in the DOM for a viewer who fails the check, unlike a pattern that might render everything and hide it with CSS (`display: none`), which still puts the data in the DOM for anyone inspecting it. That said, this protects against *rendering* leaked data, not against the data having already been *fetched*. `useGetWorkspaceQuery(workspaceId)` runs inside `AuthProvider`, above and independent of `withPermission`'s own check — by the time `WithPermission` decides not to render `Settings`, the workspace payload (name, members, roles) is already sitting in the React Query cache and in a network response the browser's devtools can inspect, because `AuthProvider` needed that data anyway to *compute* `hasPermission` in the first place. That's an acceptable tradeoff for workspace-level metadata a member is, definitionally, already allowed to see (they're a member of the workspace being viewed) — it would be a real problem if a permission check were ever used to gate access to data the requesting user has no legitimate reason to have received from the API at all, which is exactly why the backend's own query-scoping (not just its `roleGuard` calls) matters as a second, independent layer — the frontend should never be the only thing standing between a user and data they shouldn't have received in the API response to begin with.

**A `components/ui/` or `lib/` component accidentally growing a workspace-scoped dependency.** Because `components/ui/` and `lib/` are flat, generic, and imported from everywhere (§3.4, §3.9), they're exactly the folders where an innocuous-looking addition can quietly become a cross-cutting risk if it ever imports something workspace- or permission-scoped — e.g. a hypothetical future `components/ui/data-table.tsx` reaching into `@/hooks/use-permissions` "just to hide one column conditionally" would tie a supposedly generic, reusable primitive to AstriX's specific RBAC model, making it harder to reuse that primitive anywhere a `workspace`/`user` pair isn't available, and harder to reason about which of the 27 files in `components/ui/` are genuinely side-effect-free design-system primitives versus ones that have quietly grown an app-specific dependency. `Button` (§3.4) is the good case precisely because its only imports are `@radix-ui/react-slot`, `class-variance-authority`, and `@/lib/utils` — nothing domain-scoped at all. This is a structural risk worth watching for in code review specifically because nothing in AstriX's current folder layout (no lint rule, no import-boundary enforcement — contrast `bulletproof-react`'s ESLint rule in §1.1(b)) would catch a `components/ui/*` file importing from `context/auth-provider` the way it would in a stricter feature-based setup with enforced boundaries.

---

## 7. Best Practice Check

**Folder structure.** As of 2026, the industry's center of gravity for frontend folder organization has shifted further toward feature-based/colocated structures than it had when type-based layouts became the default via early tutorials and CRA-era scaffolds — `bulletproof-react`'s feature-folder convention (§1.1(b)) is now one of the most commonly cited references for teams scaling past a handful of screens, and meta-framework adoption (Next.js App Router, Remix) has made colocation-by-route (§1.1(d)) the *default*, not an opt-in choice, for any team starting a new project on either framework in 2026. Against that backdrop, AstriX's pure type-based layout reads the same way its backend counterpart does: reasonable and current for its actual size (six domains, one team, one deployable SPA with no meta-framework), not a dated relic — but the honest gap-flag is the same shape as the backend's: if AstriX's domain count or team size grew materially, the search cost of "which handful of files implement the invite-member flow" (spread today across `components/workspace/member/`, `hooks/api/`, `page/workspace/Members.tsx`, and `lib/api.ts`) climbs with every new domain added to those already-flat folders, and a `bulletproof-react`-style feature-folder migration — done incrementally, one domain at a time — would be the proportionate next step long before a framework migration to Next.js/Remix (which would additionally force AstriX to reconsider SSR, which it currently has zero of) becomes worth discussing at all.

**Composition patterns for cross-cutting concerns.** Here the 2026 industry consensus is sharper than the folder-structure question: HOCs are now a **legacy-leaning pattern** for most new code, not merely one option among equals. The React team itself began steering the ecosystem away from HOCs and render props in favor of hooks starting with hooks' 2019 release, and by 2026 that guidance has fully saturated the ecosystem — most actively maintained libraries that offered an HOC API a few years ago (Redux's `connect()`, React Router's `withRouter()`) now offer or exclusively provide a hooks-based API instead (`useSelector`/`useDispatch`, `useNavigate`/`useParams`), and greenfield code overwhelmingly reaches for a custom hook or a children-composition wrapper first. Measured against that standard, AstriX's own mix is a small but genuine, honest signal of exactly this industry-wide transition rather than a mistake: `PermissionsGuard` (children-as-composition, §3.3) is the more modern of the two idioms and is used in four separate files across the codebase; `withPermission` (the HOC, §3.2) is used in exactly one — not because it's wrong, but because a route-level redirect-on-mount is one of the few remaining jobs an HOC still does slightly more naturally than a hook-plus-wrapper-component combination would (a custom hook alone can't wrap JSX output; see §1.2's hooks-tradeoffs row), and AstriX reached for the right tool for that one specific job rather than defaulting to the newer pattern reflexively everywhere. A team starting this exact feature today, with 2026's ecosystem and conventions, would very plausibly still end up writing something functionally identical to `withPermission` for the route-gate case — the pattern isn't obsolete for that particular job, even though it's fallen out of favor as a default for cross-cutting concerns generally.

---

## 8. Debug Drill

**Scenario:** A new page was added to the protected route table — say, a `Reports` screen gated behind a new `VIEW_REPORTS` permission — and QA reports that a user who should be blocked can still see it. No error in the console, no failed network request, the page just... renders for someone it shouldn't. Where do you look first, and in what order?

1. **Confirm which composition pattern was actually used, and whether it was applied at all.** The single most common way this exact bug happens in a codebase with two coexisting permission primitives (§3) is a new page being added to the route table pointing directly at the bare component — `<Route path="reports" element={<Reports />} />` — instead of a `withPermission`-wrapped export the way `Settings.tsx` does it (§3.6). Nothing in AstriX's route-table construction (`routes/common/routes.tsx`, `page/{route.element}` pairs — see [`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md)) enforces that every protected route is permission-gated; `ProtectedRoute` only checks "is there a logged-in user at all," which is a coarser, unrelated check (full detail in [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md)). Grep the new page's own file for `withPermission` or `useAuthContext`/`hasPermission` at all — if neither appears, that's very likely the entire bug, and the fix is exactly what `Settings.tsx` already demonstrates: wrap the default export.
2. **If the wrapping is present, check what permission string was actually passed.** A `withPermission(Reports, Permissions.VIEW_REPORT)` (singular, a typo against the real `VIEW_REPORTS`) would compile cleanly if `VIEW_REPORT` happens to also exist as a *different*, unrelated, more permissive constant in `constant/index.ts` (§3.9) — TypeScript's structural typing on `PermissionType` (`keyof typeof Permissions`) only catches a string that isn't *any* known permission key, not one that's a real key but the wrong one. Print or log the exact `requiredPermission` value reaching `hasPermission()` inside `WithPermission` (§3.2) for the affected render, and compare it byte-for-byte against what the backend's `RolePermissions` map (`docs/backend/02-authentication-and-authorization.md` §3.7) actually associates with the role in question.
3. **If the permission string is correct, check whether `hasPermission` itself is stale.** §3.9 showed `hasPermission` is a `useCallback` derived from `usePermissions(user, workspace)`, which itself derives from `workspace.members.find(...).role.permissions` — sourced from whatever `useGetWorkspaceQuery` last cached. If a user's role was changed server-side (an `OWNER` demoted them from `ADMIN` to `MEMBER`) but the frontend's React Query cache for that workspace hasn't been invalidated or refetched since, `hasPermission` is evaluating against a stale, pre-demotion permission list that's still sitting in the cache — this is a data-freshness bug wearing a permission-bug costume, and the fix belongs in [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md)'s territory (cache invalidation strategy), not in `with-permission.tsx` itself. Check the query's `staleTime` and whether anything triggers a refetch on role-change events.
4. **If none of the above explain it, verify the check is actually being reached at all on the code path QA exercised.** `isLoading` gates in `WithPermission` (§3.2) mean that if `isLoading` were ever stuck permanently `true` for some new, page-specific reason (an unrelated query added to `AuthProvider` that never resolves for this user's data shape), the component would sit on the loading branch forever rather than falling through to the permission check — which would *look* like "always blocked," the opposite symptom, but is worth ruling out first if the bug report is inconsistent between testers (some see the page, some see a permanent spinner) rather than uniformly "always visible."
5. **As a last resort, verify this isn't actually a false positive from a legitimate multi-role scenario.** Confirm QA tested the exact account/workspace pair they believe they tested — a user who is `MEMBER` in one workspace and `ADMIN` in another will correctly see `Reports` when viewing the workspace where they're `ADMIN`, and a bug report that doesn't pin down *which* workspace ID was active at the time is the single most common false alarm in any per-workspace RBAC system, client or server side alike.

The transferable lesson: in a codebase using more than one composition pattern for the same underlying concern, the first debugging question is never "is the permission logic broken" — it's "was the gating primitive even applied to this new page at all, and with the exact right permission string," because a missing or mistyped wrap-call produces symptoms that look identical to a genuine logic bug inside `hasPermission()` itself, and the two have completely different fixes.
