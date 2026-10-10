// The ledger mod's review findings as the pane's review comments, so each
// shows on its line the way a request's thread does. Lens works without the
// ledger: with no run there are none.

import type { LedgerRunSeen } from '../types/ledger'
import type { Comment } from './review'

const PREFIX = 'ledger-'

// Whether a comment is a ledger finding: it has no thread on a forge to answer
// or resolve.
export const isFinding = (comment: Comment): boolean => comment.id.startsWith(PREFIX)

// A path with its `.` and `..` parts folded.
const folded = (path: string): string => {
  const parts: string[] = []

  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '.' && part !== '') {
      parts.push(part)
    }
  }

  return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

// A path another mod names, made absolute: as it is when it starts at the
// root, else from `root`, the session's folder.
export const placeOf = (path: string, root: string): string =>
  folded(path.startsWith('/') ? path : `${root}/${path}`)

// Where a finding's file is under the folder being reviewed, or undefined when
// it is not there. An agent writes the path from the session's folder, which
// may be the folder under review, one above it, or one inside it; failing
// those, a changed file whose path ends with the finding's is the one meant.
const placed = (path: string, repo: string, root: string, files: readonly string[]): string | undefined => {
  const full = folded(path.startsWith('/') ? path : `${root}/${path}`)
  const under = full.startsWith(`${repo}/`) ? full.slice(repo.length + 1) : undefined
  const tail = folded(path).replace(/^\//, '')

  if (under !== undefined && (path.startsWith('/') || files.includes(under))) {
    return under
  }

  // A path written from a folder above the one under review starts with
  // that folder's own last parts (`skills/lens/hooks/a.ts` for a review of
  // `…/skills/lens`), whatever the session's folder is by now.
  const parts = tail.split('/')

  for (let at = parts.length - 1; at >= 1; at -= 1) {
    if (repo.endsWith(`/${parts.slice(0, at).join('/')}`)) {
      return parts.slice(at).join('/')
    }
  }

  if (under !== undefined) {
    return under
  }


  return files.find(one => one === tail || one.endsWith(`/${tail}`) || tail.endsWith(`/${one}`))
}

// The run's findings as comments on the files of `repo`, the folder under
// review. `root` is the session's folder and `files` the changed files' paths.
// A fixed finding is a resolved thread; one with no line is on the file as a
// whole.
export const findingComments = (
  run: LedgerRunSeen | null | undefined,
  repo: string,
  root: string,
  files: readonly string[],
): Comment[] =>
  (run?.findings ?? []).flatMap(one => {
    const path = placed(one.path, repo, root, files)

    return path === undefined
      ? []
      : [
          {
            id: `${PREFIX}${one.id}`,
            path,
            line: one.line ?? 0,
            author: `ledger ${one.severity}${one.task === undefined ? '' : ` · ${one.task}`}`,
            body: one.summary,
            when: new Date(one.at).toISOString(),
            ...(one.status === 'fixed' ? { isResolved: true } : {}),
          },
        ]
  })
