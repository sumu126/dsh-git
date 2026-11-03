# dsh-git

Git repositories of a DSH workspace: a right-sidebar source-control page — commit
box, changes with their stage actions, the diff on screen, and a commit graph
drawing every commit — plus a set of tools that let an agent read status,
history, and diffs and, when the deployment allows it, stage, commit, and switch
branches.

Everything runs the local `git` command line. There is no network operation, no
remote fetch, and no push: this plugin manages *this* machine's working trees.

## What it does

| Tool | What it answers |
| --- | --- |
| `git_repos` | The repositories under a root, each with its branch, upstream position, and change counts. Scans breadth-first, skips dependency and build trees. |
| `git_status` | Branch (or detached HEAD), upstream ahead/behind, and every changed path with its staged and unstaged letters. |
| `git_log` | Commits newest first, with refs and parents; accepts a revision, a range, a path, and an author. |
| `git_diff` | The patch for one comparison — working tree, index, one commit, or a range — with changed paths and line totals. |
| `git_show` | One commit: metadata, the paths it changed, and (unless `patch: false`) the patch it introduced. |
| `git_branches` | Local branches and, when asked, remote-tracking ones, each with its upstream state. |
| `git_remotes` | Configured remotes with their fetch and push URLs. Configuration only; no network. |
| `git_stage` | `stage`, `unstage`, or `discard`, with the status the change left behind. |
| `git_commit` | One commit from the staged tree, or from every tracked change with `all: true`. |
| `git_switch` | Switch to a branch, create one, or detach at a commit. Nothing is forced. |

The mutating tools and the panel's writes are gated by the same three switches. A
deployment that wants a read-only history viewer turns `allowStage`,
`allowCommit`, and `allowSwitch` off: the model is offered no mutating tool, and
the panel shows no commit box and no stage action — never an action the host
would refuse.

## The panel

One right-sidebar page type, reached from the guide card:

- a root picker — the configured root, the registered workspaces, and the last
  directory a tool call worked in — then the repositories under that root;
- the selected repository's **commit box**: the message, an optional "stage
  everything", and a button (Ctrl+Enter commits);
- **changes**: every changed path with the letters git reported, one button to
  stage an unstaged path and one to unstage a staged one, plus "stage all" and
  "unstage all";
- **diff**: the working-tree or staged comparison, with a byte-bounded patch;
- **graph**: every commit across every ref, newest first, drawn in lanes — a dot
  per commit, a curve per parent, branch and tag chips on the refs that point at
  it — with the author and date. The graph opens at 50 commits and reads more on
  demand, never more than 200. Clicking a commit expands **the files it changed**
  in place, right under its row: a type badge, the file's own name, the directory,
  and the status letter. Clicking one of those shows that file's patch in the box
  below the list — the two-step a log view uses, so a commit is read as "what
  changed, then how" rather than as one wall of patch text;
- the repository list folds to the current selection, so a machine with many
  checkouts keeps the history and the commit box in view.

A deployment that turned committing off is shown no commit box at all; the page
adapts to what the host answered, rather than offering a button that would fail.

It reads and writes through this plugin's own authenticated routes
(`/api/dsh-git/{roots,repos,status,diff,log,commit,stage}`), which call the same
functions the tools call — the commit route runs the same `createCommit`, and the
staging route the same guarded `applyStage`. A panel and a tool call cannot report
two different branches, and a refusal reads the same in both places.

## Configuration

```yaml
- insert:
    - id: dsh-git
      name: 'dsh-git'
      config:
        root: ''            # empty = ask the session; a path pins one root
        gitCommand: git
        timeoutMs: 30000    # one command's deadline
        maxOutputBytes: 262144
        maxPatchBytes: 65536  # patch text one tool call keeps
        logLimit: 20
        maxRepos: 100
        maxDepth: 4
        maxFiles: 200
        allowStage: true
        allowCommit: true
        allowSwitch: true
```

`root: ''` is the normal setting: a tool call scans the directory the session
works in, and the panel offers the registered workspaces. A deployment that
manages exactly one directory names it.

## Safety model

- Every command is an argv array, never a shell string.
- Paths always follow `--`; a revision that begins with `-` is refused before git
  sees it.
- Each command has a deadline and a byte cap. A command killed by the deadline or
  by cancellation reports that, instead of a bare exit code.
- `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the other repository selectors
  are cleared, so a harness running under a hook or a rebase cannot make these
  calls address another checkout.
- Reads run with `GIT_OPTIONAL_LOCKS=0`: reporting on an index must not rewrite
  it. The mutating calls ask for the lock explicitly.
- `discard` has no "everything" form. Losing every unstaged edit is not something
  one boolean should be able to ask for.
- The commit box's "stage everything" stages tracked **and** untracked paths
  before committing, because that is what its label says; the tool's `all: true`
  is `git commit --all`, which is tracked paths only.
- No fetch, pull, push, or clone. Remotes are read, never contacted.

## Install

The package is a DSH bundle: `dsh.bundle.patch` points at `cordis.patch.yml`, and
`dsh.client` declares the browser half. Install it the way the deployment installs
any bundle, then make sure the profile lists it:

```jsonc
// <profile>/package.json
{
  "dependencies": { "dsh-git": "file:S:/dev/DSH/dsh-git" },
  "dsh": { "profile": { "bundles": ["dsh-git"] } }
}
```

A fresh bundle row is picked up by the plugin manager's reload; a **replaced**
bundle needs a restart, because the host modules are fixed at process start. The
browser half is served from disk and hot-swaps on a page refresh.

### From a git URL

A published repository installs the same way any other git-hosted package does —
`github:sumu126/dsh-git`, `https://github.com/sumu126/dsh-git`, or
`git+https://github.com/sumu126/dsh-git.git#main`. `lib/` is not committed, so the
install builds it: pnpm runs `prepack`, which needs the build tools, and pnpm
refuses to run a git-hosted package's build scripts until the profile approves
them:

```yaml
# <profile>/pnpm-workspace.yaml
allowBuilds:
  dsh-git@https://codeload.github.com/sumu126/dsh-git/tar.gz/<commit>: true
```

The refusal prints the exact line to copy, and the address it prints is the one
pnpm resolved — a codeload tarball for GitHub, `git+…` for a plain git URL. The
key contains the **commit**, so a new HEAD needs a new line; that is pnpm's rule
for every git dependency, not this plugin's.

Everything the install needs is declared in the manifest:

| Field | Value | What reads it |
| --- | --- | --- |
| `dsh.manifestVersion` | `1` | the manifest format |
| `dsh.bundle.patch` | `./cordis.patch.yml` | the launcher, as this bundle's layer |
| `dsh.client.platform` | `web` | the client module loader |
| `dsh.client.inject` | the client packages the half expects | module ordering |
| `main` / `exports` | `lib/index.js` / `lib/client.js` | the loader, and the module table |
| `files` | `lib`, `src`, the patch, README, LICENSE | what the packed artifact carries |
| `engines.node` | `>=22` | the deployment |

`engines.dsh` is deliberately absent: when it is declared it decides alone, and
any range narrow enough to exclude 0.1.6 would also exclude the 0.2.1 release
candidate this plugin is used on. Without it, the compatibility check falls back
to the `@deepseek-ai/dsh*` peer ranges, which are `*`.

## Development

Run from this directory. `tsconfig.json` points `@deepseek-ai/*` at the harness
checkout beside it (`../deepseek-harness`), which is what makes the checks run
against real harness code instead of doubles of it.

```
npm install
npm run typecheck      # tsc, against the harness declarations
npm test               # 15 parser + 7 graph-layout + 3 file-badge checks
npm run test:live      # 20 checks against real repositories in a temp dir
npm run build          # lib/index.js (ESM) and lib/client.js (module-table factory)
npm run verify:host    # mounts the plugin, calls every tool, exercises every route
npm run verify:cards   # what the client's row reads out of metadata
npm run verify:client  # runs the browser half against node doubles, then loads lib/client.js
npm run verify:render  # renders the panel and asserts the picture a reader gets
npm run verify:loader  # composition through the real Loader, then unloads the row
npm run verify:desktop # the built plugin on the app's OWN 0.2.1 runtime (see below)
```

`verify:client` reads `lib/client.js` as well as the sources — a banner or an
external that the shell does not seed would be a bundle that never registers
anything, and every source-level check would still pass. So build before it.

`verify:render` is the gate that keeps the page from disappearing: every other
client check runs registration and state, and none of them mounts a component.
A missing export or a field read off an absent object crashes the render, the
shell draws nothing, and every other gate stays green — which is exactly how the
sibling database plugin lost its whole settings page once. This renders the panel
to static markup and asserts the commit box, the changed paths with their stage
actions, the graph's dots and edges, and the empty and refusal states.

`verify:desktop` runs the built artifacts against the desktop application's own
runtime — its `@deepseek-ai/dsh-tools` and Schemastery, imported straight out of
`app.asar` — and must be launched with that application's Node, because only it
can import from inside the archive:

```
$env:ELECTRON_RUN_AS_NODE = '1'
& 'S:\app\dsh\DeepSeek Harness.exe' --expose-internals scripts/verify-desktop.mjs
```

It is the one gate that speaks for the generation the user actually runs: the
checkout beside this plugin is 0.1.6, and a plugin that works there is not
automatically a plugin that works in the app.

The live suite is not decoration: a status read that used `--porcelain=v1`, a
commit message that reached git as an option, or a diff bound that was applied to
the wrong stream would all pass a parser fixture and fail here.

## Known limits

- **No network.** Fetching, pulling, and pushing are out of scope on purpose: they
  need credentials, prompts, and a policy this plugin does not have.
- **Untracked files do not appear in a diff.** `git diff` does not show them; the
  status lists them, and staging them makes them visible in a staged diff.
- **A bare repository has no working tree.** It is addressable and listed, but
  status, diff, staging, and committing are refused with that reason.
- **A merge commit lists no changed paths.** That is what git itself reports for a
  merge; `git_diff` with a range shows what the merge brought in.
- **The panel needs a root.** With no configured root and no registered
  workspace, it asks the deployment to name one.
- **The graph is a picture, not an editor.** It draws lanes and opens a commit's
  patch; it cannot cherry-pick, rebase, or drag a branch.
- **The panel's writes need the current host.** A page that refreshed after an
  update can outlive the process serving it; a missing route is reported as the
  restart it needs rather than a mystery.
- **No blame, no reflog, no submodule management.** Deliberately left out of the
  first version.
