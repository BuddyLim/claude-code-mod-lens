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

// The file-type glyphs and their colours are the kit's, shared with the parked
// and ledger mods.
export { iconOf } from './kit/icons'
export type { Icon } from './kit/icons'
