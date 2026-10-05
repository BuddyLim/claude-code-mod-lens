# lens

A Claude Code mod that puts a code review pane beside your session: the files
a change touches, each read whole with editor-style diagnostics, a diff view, a
git graph, commits and stashes, and pull request comments.

It is for reading what you (or Claude) just changed without leaving the
terminal: what differs, what is wrong with it, and whether the change brought
the problem or it was already there.

## What it does

- **Changed files with problems inline.** `/lens` lists what differs from a
  base (uncommitted changes by default) as a tree or a list, with each file's
  line counts and its errors and warnings. Python is checked with pyright and
  ruff, TypeScript with tsc and eslint, Terraform with `terraform validate`;
  language servers are asked first where they are installed.
- **New or pre-existing.** The base's version of each changed file is checked
  too, so every problem is marked as brought by the change or already there.
- **A file view.** The whole file with syntax colours, diagnostics under the
  lines they are on, a minimap, find, blame, a breadcrumb with the file's
  outline, inlay hints, and a diff view that interleaves what the base had.
  Markdown is shown rendered.
- **Look things up.** Select a name to see its type and where it is defined,
  then list its uses, callers, callees and implementations, or search the
  project's names.
- **A git graph.** Branches, stashes and uncommitted work, with each commit's
  files a press away. Check out a branch or commit, undo the last commit, or
  compare any two branches, commits or pull requests.
- **Commit, stash and discard** the files you tick, from the file tree.
- **Pull and merge requests.** Compare with `#12` (or a link) to review a
  request's changes; its review comments show on the lines they are on, and
  you can post one. GitHub through `gh`, GitLab through `glab`.
- **Hand things to Claude.** Send a line's problems, a function, your
  selection or every new issue to the prompt (appended, never submitted), or
  have Claude told automatically what its own edits broke.
- **Picks up where you left off.** Each repo's comparison and layout are kept
  between sessions; run outside a repo, `/lens` offers the recent ones.

## Use

```
/lens                       the repo you are in, uncommitted changes
/lens main                  the working tree against main
/lens ~/Code/my-repo main   another repo
```

Press `h` in the pane for the keys of the screen you are on.

## Settings

`/config` has a row for each checker, for asking language servers first, for
the new-or-pre-existing pass, the pane's side padding, whether the less-used
keys always show, remembering reviews, and cleaning up when a session ends.

## Requirements

Nothing is required beyond git; each checker is used where it is found.

- Python: [uv](https://docs.astral.sh/uv/) (ruff and pyright run through `uvx`)
- TypeScript: the project's own `node_modules` (tsc, eslint) and Node
- Terraform: `terraform`, and optionally `terraform-ls`
- Syntax colours: uv (Pygments runs through it)
- Pull requests: `gh` or `glab`, signed in
- Icons: a [Nerd Font](https://www.nerdfonts.com/) in your terminal

## Install

This mod uses Claude Code's function-hooks plugin API.

Clone it into your personal skills folder, where Claude Code loads it in every
session:

```bash
git clone https://github.com/BuddyLim/claude-code-mod-lens ~/.claude/skills/lens
```

## What it leaves on your machine

While a session runs: exports of the commits it checks under `$TMPDIR/lens-base`,
a language-server keeper under `/tmp/lens-lsp-<uid>`, and, for a pull request,
refs under `refs/lens/` in that repo. All three are removed when the session
ends (a setting). Nothing is ever checked out, committed or pushed unless you
press the key for it.

## Develop

```bash
claude plugin validate ~/.claude/skills/lens
claude plugin test ~/.claude/skills/lens
```

## License

MIT
