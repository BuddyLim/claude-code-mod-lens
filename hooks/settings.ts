// The person's settings, as the config menu holds them (the manifest's
// `userConfig`), read into the shape the rest of the mod asks about. A value
// that is missing or of the wrong kind is its default, so nothing downstream
// has to doubt one.

import { PAD } from './kit/layout'

// Which checkers a scan may use. A language server answers in the name of
// its command-line twin (pyright for Python, tsc for TypeScript, terraform),
// so switching a checker off silences both.
export type Checkers = {
  ruff: boolean
  pyright: boolean
  tsc: boolean
  eslint: boolean
  terraform: boolean
  // Whether the language servers are asked before the command-line checkers
  // (and at all, for a language that has no command-line checker here).
  servers: boolean
}

export type Settings = {
  checkers: Checkers
  // Whether the base is checked too, to tell a new problem from an old one.
  marksNew: boolean
  // The cells left clear at each side of every screen.
  sidePadding: number
  // Whether the less-used keys always show, instead of under "more…".
  showsAllKeys: boolean
  // Whether /lens picks a repo up where it was left (its comparison and
  // layout), and whether what a session left behind is removed when it ends.
  remembers: boolean
  cleansUp: boolean
}

export const ALL_CHECKERS: Checkers = {
  ruff: true,
  pyright: true,
  tsc: true,
  eslint: true,
  terraform: true,
  servers: true,
}

export const DEFAULTS: Settings = {
  checkers: ALL_CHECKERS,
  marksNew: true,
  sidePadding: PAD,
  showsAllKeys: false,
  remembers: true,
  cleansUp: true,
}

const MOST_PADDING = 8

export const settingsOf = (options: Readonly<Record<string, unknown>>): Settings => {
  const flag = (name: string, fallback: boolean): boolean => {
    const value = options[name]

    return typeof value === 'boolean' ? value : fallback
  }
  const padding = options.sidePadding

  return {
    checkers: {
      ruff: flag('ruff', true),
      pyright: flag('pyright', true),
      tsc: flag('tsc', true),
      eslint: flag('eslint', true),
      terraform: flag('terraform', true),
      servers: flag('languageServers', true),
    },
    marksNew: flag('markNew', DEFAULTS.marksNew),
    sidePadding:
      typeof padding === 'number' && Number.isFinite(padding)
        ? Math.min(MOST_PADDING, Math.max(0, Math.round(padding)))
        : DEFAULTS.sidePadding,
    showsAllKeys: options.keys === 'all shown',
    remembers: flag('remember', DEFAULTS.remembers),
    cleansUp: flag('cleanUp', DEFAULTS.cleansUp),
  }
}
