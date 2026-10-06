// Shared by the lens, parked and ledger mods. The source is the mod-kit folder;
// each mod carries a copy under hooks/kit, written there by sync.sh. Edit the
// source and sync, never a copy.

export type Icon = { glyph: string; color: string }

// Nerd Font glyphs, as a terminal file tree draws them, in each language's
// usual colour. They need a Nerd Font, or a terminal that ships the symbols.
export const FILE_ICONS: readonly (readonly [pattern: RegExp, glyph: string, color: string])[] = [
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

// The glyphs the mods draw for their own things, one name each.
export const ICON = {
  file: '\u{f15b}',
  folder: '\u{f07b}',
  folderOpen: '\u{f07c}',
  needs: '\u{f059}',
  blocking: '\u{f071}',
  fyi: '\u{f05a}',
  done: '\u{f058}',
  failed: '\u{f057}',
  running: '\u{f110}',
  todo: '\u{f10c}',
  thread: '\u{f075}',
  options: '\u{f0cb}',
  preferred: '\u{f005}',
  tasks: '\u{f0ae}',
  agents: '\u{f085}',
  finding: '\u{f188}',
} as const

export const FILE_COLOR = '#6d8086'
export const FOLDER_COLOR = '#dcb67a'
export const STAR_COLOR = '#ffd43b'

export const iconOf = (path: string): Icon => {
  const hit = FILE_ICONS.find(([pattern]) => pattern.test(path))

  return hit === undefined ? { glyph: ICON.file, color: FILE_COLOR } : { glyph: hit[1], color: hit[2] }
}

// The icon of a ref's file type; a ref is a path, or path:line.
export const refIcon = (ref: string): Icon => iconOf(ref.replace(/:\d+(?::\d+)?$/, ''))
