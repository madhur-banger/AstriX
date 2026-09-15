# Git Internals & Workflows

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Most engineers use `git` for years as a sequence of memorized commands without ever learning what a commit actually *is*. That gap is exactly what makes rebase, `bisect`, and "detached HEAD" feel like magic instead of mechanical consequences of a simple underlying model.

## What a Commit Actually Is

A commit is a **snapshot**, not a diff — a pointer to the complete state of every file in the repository at that point in time, plus a pointer to its parent commit(s), plus metadata (author, committer, timestamp, message). Git computes a SHA-1 (moving toward SHA-256 in newer repos) hash over that content, and the hash *is* the commit's identity — this is **content-addressed storage**: change one byte anywhere in the snapshot or the message, and the resulting hash is entirely different, because the hash is a function of the content itself, not an assigned label.

## The Object Model, in One Paragraph

Git stores exactly three kinds of objects, each content-addressed the same way. A **blob** is the raw content of one file, with no filename or metadata attached to it — two files with identical content, anywhere in the repo, anywhere in history, are stored as the exact same blob. A **tree** is a directory listing — a set of entries, each pointing to either a blob (a file) or another tree (a subdirectory), with a filename and mode attached. A **commit** points to exactly one tree (the root of the entire project at that snapshot) plus its parent commit(s). This is why `git commit` is fast even on a huge repo touching one file: it only needs to create new blob/tree objects along the path that actually changed, and every unchanged file and directory reuses objects that already exist.

## What a Branch Actually Is

A branch is nothing but a **movable pointer to a commit** — a file in `.git/refs/heads/` containing one commit hash, nothing more. `git checkout -b feature` doesn't copy anything; it creates a new 41-byte file pointing at the current commit. Every subsequent commit on that branch moves the pointer forward to the new commit. This demystifies a lot: "merging a branch" is just making one pointer's history reachable from another; "deleting a branch" is deleting a pointer file, not the commits themselves (which stick around, reachable via `reflog`, until garbage collected); `HEAD` is itself just a pointer to whichever branch pointer you currently have checked out.

## Rebase vs. Merge

Both integrate changes from one branch into another; they produce genuinely different history shapes.

**Before**, two branches diverged from a common ancestor:

```
      A---B---C  (main)
     /
D---E  (base)
     \
      F---G  (feature)
```

**Merge** creates a new commit with *two* parents, joining both histories exactly as they happened:

```
      A---B---C-------H  (main, merged)
     /             / 
D---E              /
     \            /
      F---G------/  (feature)
```

**Rebase** replays `feature`'s commits on top of `main`'s latest commit one at a time, producing entirely new commits (new SHAs, since parent — part of the hash input — changed) with a linear history and no merge commit:

```
D---E---A---B---C---F'---G'  (feature, rebased onto main)
```

The real tradeoff: merge preserves exactly what happened, including when branches diverged and reconverged, at the cost of a less linear, sometimes noisier history with merge commits scattered through it. Rebase produces a clean, linear history that reads like the work happened sequentially — easier to scan with `git log`, easier to `bisect` through — at the cost of rewriting commit SHAs, which means **anyone else who already pulled the old commits now has a diverged, incompatible history**. This is the one hard rule: never rebase a branch that's shared or already pushed somewhere others have based work on — rewriting public history forces everyone downstream to reconcile two different, non-fast-forwardable timelines of the same work.

## Trunk-Based Development vs. GitFlow

**GitFlow** is a branching model with long-lived `develop` and `main` branches, plus dedicated `release/*` and `hotfix/*` branches, and feature branches that can live for weeks before merging into `develop`. It gives a very explicit, ceremony-heavy process — useful when a product genuinely ships in discrete, scheduled releases with a real need to stabilize a release branch separately from ongoing development.

**Trunk-based development** keeps a single long-lived branch (`main`/`trunk`), with feature branches living hours to a few days at most before merging back, gated behind **feature flags** rather than a long-lived branch when a feature isn't ready to ship yet. The real tradeoff: GitFlow's long-lived branches mean less frequent, larger, riskier merges (more surface area for conflicts, longer feedback loops before code is actually integrated and tested together) but a very clear release-stabilization process. Trunk-based development's short-lived branches mean small, frequent merges with much less drift to reconcile, but it requires feature flags (and the discipline to actually use them) to keep unfinished work out of users' way while it sits merged into `main`. Most modern CI/CD-heavy teams — anyone practicing continuous deployment — lean trunk-based, precisely because it's a prerequisite for shipping small changes constantly rather than in batches.

## `git bisect` as a Real Debugging Workflow

When a bug exists now but didn't at some point in the past, and the exact commit that introduced it is unknown, `bisect` runs an automated binary search over history:

```bash
git bisect start
git bisect bad                    # the current commit (HEAD) is known broken
git bisect good v1.4.0             # this earlier tag/commit is known good

# git checks out a commit roughly halfway between good and bad
# test it — run the app, run the failing test, whatever proves broken/not
npm test                           # or manually reproduce the bug

git bisect bad                     # if this commit is also broken
# git checks out the next midpoint automatically
git bisect good                    # if this commit is fine

# ... repeat, git narrows the range by half each time ...
# eventually git prints: "abc1234 is the first bad commit"

git bisect reset                   # return to the original HEAD when done
```

Each `good`/`bad` judgment halves the remaining search space, so a range of 1,000 commits resolves in roughly 10 steps rather than a linear scan through all 1,000 — genuinely faster than guessing, and mechanical enough to automate entirely with `git bisect run <test-script>` when the "is this broken" check can be scripted, letting `bisect` find the culprit commit with zero manual checkout/test cycles.
