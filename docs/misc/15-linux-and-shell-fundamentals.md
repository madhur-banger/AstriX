# Linux & Shell Fundamentals

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Every container, every CI runner, every EC2 box, every `docker exec` debugging session ends at the same place: a Linux shell. Frameworks and cloud consoles abstract a lot away, but the moment something breaks in production, the fastest path to an answer is almost always `ssh`/`exec` in and reading processes, permissions, and logs directly. This file covers the operating-system-level vocabulary that every other layer of infrastructure sits on top of.

## Processes

A process is a running instance of a program — its own memory space, its own file descriptors, its own execution state — tracked by the kernel via a **PID** (process ID). Every process except the kernel's own `init` (PID 1) has exactly one **parent** (identified by **PPID**), forming a tree: shells spawn processes, processes spawn processes, all the way back to PID 1. When a parent dies before its child, the child is "reparented" to PID 1 (or, in containers, whatever process holds PID 1 inside that namespace) rather than being left orphaned.

```bash
ps aux                     # every process on the system, with owner, CPU%, MEM%, and full command
ps -ef --forest            # parent/child tree view
top                        # live, continuously updating view of CPU/memory usage per process
kill -15 4213               # SIGTERM: ask PID 4213 to shut down gracefully
kill -9 4213                # SIGKILL: the kernel terminates it immediately, no cleanup possible
```

`kill` doesn't "kill" by default — it sends a signal, and `SIGTERM` (15) is a *request* a well-behaved process can catch and use to flush buffers, close connections, and exit cleanly. `SIGKILL` (9) bypasses the process entirely; the kernel tears it down with no chance for cleanup, which is why it's a last resort — a database process `SIGKILL`ed mid-write can leave corrupt state that `SIGTERM` would have avoided. This exact distinction is why orchestrators (ECS, Kubernetes, systemd) send `SIGTERM` first and only escalate to `SIGKILL` after a grace period.

## File Permissions

Every file has three permission classes — **owner**, **group**, **other** — and three permission bits per class: **r**ead, **w**rite, e**x**ecute. `ls -l` shows this as a 10-character string, e.g. `-rwxr-xr--`: the first character is the file type (`-` for regular file, `d` for directory), then three groups of `rwx` for owner/group/other.

Each `rwx` triplet is also a 3-bit number: r=4, w=2, x=1, summed per class. `chmod 755 script.sh` breaks down as:

| Class | Bits | Value | Meaning |
|---|---|---|---|
| Owner | `rwx` | 7 (4+2+1) | read, write, execute |
| Group | `r-x` | 5 (4+0+1) | read, execute — no write |
| Other | `r-x` | 5 (4+0+1) | read, execute — no write |

```bash
chmod 755 deploy.sh     # owner can edit and run it; everyone else can only run it
chmod 600 id_rsa        # owner: read+write only. group/other: nothing at all
chmod +x run.sh         # add execute permission for all classes, without touching read/write
```

`chmod 600` on a private key isn't a formality — SSH itself refuses to use a private key file that's group- or world-readable (`Permissions 0644 for 'id_rsa' are too open`), because a key any local user can read defeats the entire point of it being private. The same logic applies to any file holding a secret: `.env` files, credential JSON, SSH keys — `600` (owner read/write, nobody else anything) is the correct default, not `644`.

## systemd Basics

Most modern Linux distributions (Ubuntu, Debian, RHEL/CentOS, Amazon Linux 2+) use **systemd** as PID 1 — the init system that starts every other process, supervises services, and restarts them on crash. A service is defined by a **unit file**, a plain-text `.ini`-style config:

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Node.js API
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/myapp/dist/index.js
Restart=on-failure
RestartSec=5
User=myapp
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`After=network.target` orders startup (don't start until networking is up) without creating a hard dependency; `Restart=on-failure` is systemd doing, at the OS level, exactly what ECS's `deployment_circuit_breaker` and Kubernetes' restart policy do at the orchestration level — notice a process died and bring it back.

```bash
systemctl daemon-reload           # re-read unit files after editing one
systemctl start myapp             # start it now
systemctl enable myapp            # start it automatically on every boot
systemctl status myapp            # is it running, since when, recent log lines
systemctl restart myapp
journalctl -u myapp -f            # follow this service's logs live (systemd's own log store)
```

`enable` and `start` are independent — `enable` without `start` means it'll come up on the *next* reboot but isn't running now; `start` without `enable` means it's running now but won't survive a reboot. Forgetting `enable` is a common reason a service that was working fine "disappears" after a routine server reboot.

## A Real Day-to-Day CLI Toolkit

Four tools account for most command-line troubleshooting: `grep` (search text), `find` (search the filesystem), `xargs` (turn a list of lines into arguments for another command), and shell redirection (control where output goes).

```bash
grep -r "TODO" src/                    # recursively search for a string
grep -i "error" app.log                # case-insensitive
grep -c "5xx" access.log                # count matching lines instead of printing them

find /var/log -name "*.log" -mtime -1 -size +100M
# -name: filename pattern
# -mtime -1: modified within the last 1 day
# -size +100M: larger than 100 megabytes
```

Redirection controls where a command's output goes: `>` overwrites a file with stdout, `>>` appends to it, `2>` redirects stderr specifically, and `2>&1` merges stderr into wherever stdout is currently going (order matters: it has to come *after* the stdout redirect to work as intended).

```bash
node server.js > out.log 2>&1 &     # stdout and stderr both to out.log, run in background
```

A real, concrete pipeline — find every `.log` file over 100MB modified in the last day and delete them, printing each path first:

```bash
find /var/log -name "*.log" -mtime -1 -size +100M -print | xargs -I {} sh -c 'echo "Deleting: {}"; rm {}'
```

`find ... -print` emits one path per line; `xargs -I {}` substitutes each line into `{}` in the following command, running it once per file. This composition — one tool finds, another acts — is the actual Unix philosophy in practice: small, single-purpose tools piped together rather than one tool trying to do both.

## Shell Scripting Basics

A shell script is a text file of commands, executed top to bottom, starting with a **shebang** line that tells the kernel which interpreter to run it with:

```bash
#!/bin/bash
set -euo pipefail

NAME="${1:-world}"        # $1 is the first argument; ${1:-default} supplies a fallback

if [ -z "$NAME" ]; then
  echo "Error: name is required" >&2
  exit 1
fi

for i in 1 2 3; do
  echo "Hello, $NAME (iteration $i)"
done

echo "Exit code of last command: $?"
```

`$?` holds the exit code of the most recently run command — `0` means success, anything nonzero means failure, by universal Unix convention (not just a suggestion; `if`, `&&`, and `||` all key off it).

`set -euo pipefail` at the top of almost every production script is not boilerplate — each flag closes a real failure mode bash's defaults leave open:

- **`-e`** — exit immediately if any command fails, instead of bash's default of plowing ahead with the next line as if nothing happened. Without it, a failed `cd /some/dir` silently leaves you running the rest of the script from the wrong directory.
- **`-u`** — treat referencing an unset variable as an error, instead of silently substituting an empty string. Without it, a typo'd variable name (`$DEPLOY_ENVIRONMENT` vs `$DEPLOY_ENV`) fails silently and produces garbage instead of an error.
- **`-o pipefail`** — in a pipeline (`cmd1 | cmd2`), the pipeline's exit code is normally just `cmd2`'s, so a failing `cmd1` piped into a successful `cmd2` reports success. `pipefail` makes the pipeline fail if *any* stage does — critical for something like `curl ... | tar xz`, where a failed download piped into `tar` would otherwise report success on an empty archive.

Without all three, a script can fail halfway through, keep running, and exit `0` — which is precisely the failure mode that turns a broken deploy script into a false-green CI job.
