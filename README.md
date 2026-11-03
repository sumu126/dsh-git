# dsh-git

Git repositories of a DSH workspace: a right-sidebar panel that lists the
checkouts under a root and shows what changed, and a set of tools that let an
agent read status, history, and diffs — and, when the deployment allows it,
stage, commit, and switch branches.

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

The three mutating tools are registered only when their switch is on. A
deployment that wants a read-only history viewer turns `allowStage`,
`allowCommit`, and `allowSwitch` off, and the model is offered no mutating tool
at all — it never sees a tool it cannot use.

The panel is read-only by design: changing a working tree is what the tools are
for, and a panel that could also commit would need an approval story of its own.

## The panel

One right-sidebar page type, reached from the guide card:

- a root picker — the configured root, the registered workspaces, and the last
  directory a tool call worked in;
- the repositories under that root, with branch, upstream position, and change
  counts;
- the selected repository's changed paths, and the diff for **Working** or
  **Staged**, with a byte-bounded patch.

It reads through this plugin's own authenticated routes
(`/api/dsh-git/{roots,repos,status,diff}`), which call the same functions the
tools call. A panel and a tool call cannot report two different branches.

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

## Development

Run from this directory. `tsconfig.json` points `@deepseek-ai/*` at the harness
checkout beside it (`../deepseek-harness`), which is what makes the checks run
against real harness code instead of doubles of it.

```
npm install
npm run typecheck      # tsc, against the harness declarations
npm test               # 15 parser checks
npm run test:live      # 20 checks against real repositories in a temp dir
npm run verify:host    # mounts the plugin, calls every tool, validates its output schema
npm run verify:client  # runs the browser half's apply against node doubles
npm run verify:cards   # what the client's row reads out of metadata
npm run verify:loader  # composition through the real Loader, then unloads the row
npm run verify:desktop # the built plugin on the app's OWN 0.2.1 runtime (see below)
npm run build          # lib/index.js (ESM) and lib/client.js (module-table factory)
```

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
- **No blame, no reflog, no submodule management.** Deliberately left out of the
  first version.
