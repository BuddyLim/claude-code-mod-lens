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
  language servers are asked first where they are installed, and bring
  [other languages](#other-languages) with them.
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

## Other languages

Python, TypeScript and Terraform have command-line checkers. Any other
language is checked by its language server alone, and the same server answers
the lookups: types, definitions, uses, callers, the outline, colours and inlay
hints, as far as that server offers them.

These are used when they are on your `PATH`, with nothing to set up:

| Language    | Server                                   | A project is the folder holding                                    |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------ |
| C and C++   | `clangd`                                 | `compile_commands.json`, `compile_flags.txt`, `.clangd`, `CMakeLists.txt` |
| C#          | `csharp-ls`, else `OmniSharp -lsp`       | `*.sln`, `*.csproj`                                                |
| Go          | `gopls`                                  | `go.work`, `go.mod`                                                |
| Rust        | `rust-analyzer`                          | `Cargo.toml`                                                       |
| Pulumi YAML | `pulumi-lsp` (`Pulumi.yaml`, `Pulumi.*.yaml` only) | `Pulumi.yaml`                                            |

When a change has files of one of these and its server is not installed, a
note under the file list says what to install.

To add a server of your own, or change or switch off one of the above, write
`~/.claude/lens/servers.json`. It is read again at each scan:

```json
{
  "servers": {
    "zls": {
      "language": "Zig",
      "extensions": [".zig"],
      "command": ["zls"],
      "rootMarkers": ["build.zig"],
      "install": "brew install zls"
    },
    "gopls": { "command": ["gopls", "-remote=auto"] },
    "clangd": { "disabled": true }
  }
}
```

A name the table already has (`pyright`, `tsserver`, `terraform-ls`, `clangd`,
`csharp-ls`, `gopls`, `rust-analyzer`, `pulumi-lsp`) changes that server, one
field at a time; any other name adds a server, which is tried before the
built-in ones. The name is also what its problems are labelled with.

| Field         | What it is                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `extensions`  | The file extensions the server reads, each with its dot. Upper or lower case is the same.                    |
| `filenames`   | Whole file names it reads (`*` and `?` stand for anything). A name counts before any extension.              |
| `command`     | The program and its arguments, speaking the Language Server Protocol on stdin and stdout. A list of such lists is tried in order: the first whose program is installed is used. |
| `languageId`  | What the protocol calls the language: `"go"`, or one for each extension (`{ ".c": "c", ".cc": "cpp" }`). Left out, it is the extension without its dot. |
| `rootMarkers` | Files that mark a project, tried in order: the nearest folder at or above the file that holds the first one found is where the server is started (`*` allowed). With none found it is the repo; with none listed, each folder is its own project. |
| `language`    | What to call the language in a note. Left out, it is the server's name.                                      |
| `install`     | How to get the server, shown when it is not installed.                                                       |
| `disabled`    | `true` switches the server off.                                                                              |

A new server needs a `command` and either `extensions` or `filenames`.
`pyright` and `tsserver` are found and started in ways of their own, so only
`disabled` can be set for them. An entry with something wrong in it is left
out, and a note under the file list says which and why; it never stops the
others from working.

This file is the only place servers are read from. Nothing in the repo you are
reviewing can add one, because an entry names a command that is run on your
machine: a repo you only meant to read must not get to choose it. The servers
themselves do read the project's files, as they do in an editor.

## Requirements

Nothing is required beyond git; each checker is used where it is found.

- Python: [uv](https://docs.astral.sh/uv/) (ruff and pyright run through `uvx`)
- TypeScript: the project's own `node_modules` (tsc, eslint) and Node
- Terraform: `terraform`, and optionally `terraform-ls`
- Other languages: that language's server (see [Other languages](#other-languages))
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
uv run --no-project python ~/.claude/skills/lens/tests/bridge_test.py
```

The last runs what `claude plugin test` cannot, since it needs real processes:
the bridge's table of servers and its config file, and a small fake language
server driven through the bridge's own daemon (one of its own, in a temp
folder).

## License

MIT
