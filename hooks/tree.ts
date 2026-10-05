// The file tree: paths as rows of folders and files, which of them a closed
// folder hides, and the icon a file wears wherever it is named.

// A folder holding more files than this starts closed in the tree.
const BIG_FOLDER = 40

export type TreeRow = {
  kind: 'dir' | 'file'
  path: string
  name: string
  depth: number
  size: number
}

type TreeNode = { dirs: Map<string, TreeNode>; files: string[]; size: number }

// The paths as a folder tree, in drawing order: folders before files, and a
// chain of folders that each hold only one folder drawn as one row (a/b/c).
export const buildTree = (paths: readonly string[]): TreeRow[] => {
  const root: TreeNode = { dirs: new Map(), files: [], size: 0 }

  for (const path of paths) {
    let node = root

    for (const part of path.split('/').slice(0, -1)) {
      const child = node.dirs.get(part) ?? { dirs: new Map(), files: [], size: 0 }
      node.dirs.set(part, child)
      child.size += 1
      node = child
    }

    node.files.push(path)
  }

  const rows: TreeRow[] = []

  const walk = (node: TreeNode, prefix: string, depth: number): void => {
    for (const [first, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      let name = first
      let last = child

      while (last.files.length === 0 && last.dirs.size === 1) {
        const [only] = [...last.dirs]

        if (only === undefined) {
          break
        }

        name += `/${only[0]}`
        last = only[1]
      }

      rows.push({ kind: 'dir', path: prefix + name, name, depth, size: last.size })
      walk(last, `${prefix}${name}/`, depth + 1)
    }

    for (const path of [...node.files].sort()) {
      rows.push({ kind: 'file', path, name: path.slice(prefix.length), depth, size: 1 })
    }
  }

  walk(root, '', 0)

  return rows
}

// The rows left once closed folders hide what is under them. A big folder
// starts closed and the rest open, or every folder starts closed (`isShut`,
// for a tree of the whole repo); `toggled` flips a folder from its default.
export const visibleTree = (
  rows: readonly TreeRow[],
  toggled: readonly string[],
  isShut = false,
): { row: TreeRow; isClosed: boolean }[] => {
  const shown: { row: TreeRow; isClosed: boolean }[] = []
  let hidden: string | undefined

  for (const row of rows) {
    if (hidden !== undefined && row.path.startsWith(hidden)) {
      continue
    }

    const isClosed =
      row.kind === 'dir' && (isShut || row.size > BIG_FOLDER) !== toggled.includes(row.path)

    hidden = isClosed ? `${row.path}/` : undefined
    shown.push({ row, isClosed })
  }

  return shown
}

export type Icon = { glyph: string; color: string }

// Nerd Font glyphs, as a terminal file tree draws them, in each language's
// usual colour. They need a Nerd Font, or a terminal that ships the symbols.
const ICONS: [pattern: RegExp, glyph: string, color: string][] = [
  [/\.pyi?$/, '\u{e73c}', '#ffd43b'],
  [/\.[cm]?[tj]sx$/, '\u{e7ba}', '#20c2e3'],
  [/\.[cm]?ts$/, '\u{e628}', '#519aba'],
  [/\.[cm]?js$/, '\u{e74e}', '#cbcb41'],
  [/\.json$/, '\u{e60b}', '#cbcb41'],
  [/\.(tf|tfvars)$/, '\u{e69a}', '#7b42bc'],
  [/\.(ya?ml|toml|ini|cfg|env)$/, '\u{e615}', '#6d8086'],
  [/\.(md|mdx)$/, '\u{e73e}', '#dddddd'],
  [/\.(sh|bash|zsh)$/, '\u{e795}', '#4d5a5e'],
  [/\.(css|scss|less)$/, '\u{e749}', '#42a5f5'],
  [/\.html?$/, '\u{e736}', '#e44d26'],
  [/\.sql$/, '\u{e706}', '#dad8d8'],
  [/\.(png|jpe?g|gif|svg|webp|ico)$/, '\u{f1c5}', '#a074c4'],
  [/(^|\/)Dockerfile$/, '\u{f308}', '#458ee6'],
  [/(^|\/)\.git(ignore|attributes)$/, '\u{e702}', '#f54d27'],
  [/\.lock$/, '\u{f023}', '#bbbbbb'],
]

export const iconOf = (path: string): Icon => {
  const hit = ICONS.find(([pattern]) => pattern.test(path))

  return hit === undefined ? { glyph: '\u{f15b}', color: '#6d8086' } : { glyph: hit[1], color: hit[2] }
}
