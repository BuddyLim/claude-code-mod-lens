// What the mod keeps between sessions, and what it leaves on the machine.
//
// Kept: the repos reviewed lately, each with the comparison and layout it
// was left in, so /lens picks one up where it was and has a list to offer
// when it is run outside any repo. Left behind by a session: the exports of
// commits the checkers ran over, the refs a pull request was fetched under,
// and the language servers' keeper; `cleanUp` removes all three.

import type { Recent, View } from '../types'
import type { Run } from './run'

// How many repos the list holds.
export const RECENTS = 12

// A review as the list keeps it.
export const recentOf = (now: View, at: number, home = ''): Recent => ({
  repo: now.repo,
  // A comparison with another worktree is with a snapshot that does not last.
  base: (now.baseWorktree ?? '') === '' ? now.base : 'HEAD',
  target: now.target ?? '',
  request: (now.target ?? '') === '' ? '' : (now.request ?? ''),
  requestTyped: (now.target ?? '') === '' ? '' : (now.requestTyped ?? ''),
  layout: now.layout ?? 'tree',
  isBrowsing: now.isBrowsing ?? false,
  at,
  home,
})

// The list with a review put first, in place of what it held of that repo.
export const remember = (list: readonly Recent[], one: Recent): Recent[] =>
  [one, ...list.filter(other => other.repo !== one.repo)].slice(0, RECENTS)

// The list as the store gave it back: whatever is not a review is dropped,
// so a store written by another version, or by hand, cannot break a reader.
export const settledRecents = (stored: unknown): Recent[] =>
  (Array.isArray(stored) ? stored : []).flatMap((one: unknown): Recent[] => {
    if (typeof one !== 'object' || one === null) {
      return []
    }

    const held = one as Partial<Record<keyof Recent, unknown>>
    const text = (value: unknown, fallback = ''): string =>
      typeof value === 'string' ? value : fallback

    return typeof held.repo === 'string' && held.repo.startsWith('/')
      ? [
          {
            repo: held.repo,
            base: text(held.base, 'HEAD') || 'HEAD',
            target: text(held.target),
            request: text(held.request),
            requestTyped: text(held.requestTyped),
            layout: held.layout === 'list' ? 'list' : 'tree',
            isBrowsing: held.isBrowsing === true,
            at: typeof held.at === 'number' ? held.at : 0,
            home: text(held.home),
          },
        ]
      : []
  })

// The list as the recents screen shows it: the worktrees of one repo
// together, under the repo they belong to, each group where its latest
// review sits in the list.
export const groupRecents = (list: readonly Recent[]): { home: string; reviews: Recent[] }[] => {
  const groups = new Map<string, Recent[]>()

  for (const one of list) {
    const home = one.home === '' ? one.repo : one.home

    groups.set(home, [...(groups.get(home) ?? []), one])
  }

  return [...groups].map(([home, reviews]) => ({ home, reviews }))
}

// What a review was comparing, in a few words, for the list.
export const comparisonLabel = (one: Recent): string =>
  one.request !== ''
    ? one.request
    : one.target !== ''
      ? `${one.target} vs ${one.base}`
      : one.base === 'HEAD'
        ? 'uncommitted changes'
        : `working tree vs ${one.base}`

// How long ago, in a word or two.
export const agoOf = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))

  return at === 0
    ? ''
    : minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 60 * 24
          ? `${Math.round(minutes / 60)} h ago`
          : `${Math.round(minutes / (60 * 24))} d ago`
}

// Removes what sessions leave on the machine. It is started and let go of,
// so a session's end does not wait for it: the servers' keeper is asked to
// stop, the exports of commits are deleted, and in each repo given the refs
// pull requests were fetched under are deleted (nothing else of a repo is
// touched). A review picked up again exports and fetches what it needs.
const CLEAN_UP = [
  '(',
  '  d="/tmp/lens-lsp-$(id -u)"',
  '  if [ -S "$d/bridge.sock" ] && cd "$d"; then',
  '    if command -v uv >/dev/null 2>&1; then echo "{}" | uv run --no-project python bridge.py stop',
  '    else echo "{}" | python3 bridge.py stop; fi',
  '  fi',
  '  rm -rf "${TMPDIR:-/tmp}/lens-base"',
  '  for repo in "$@"; do',
  '    git -C "$repo" for-each-ref --format="delete %(refname)" refs/lens |',
  '      git -C "$repo" update-ref --stdin',
  '  done',
  ') >/dev/null 2>&1 </dev/null &',
].join('\n')

export const cleanUp = (run: Run, repos: readonly string[]): Promise<unknown> =>
  run(['sh', '-c', CLEAN_UP, 'sh', ...new Set(repos.filter(repo => repo.startsWith('/')))], {
    timeoutMs: 1000,
  })
