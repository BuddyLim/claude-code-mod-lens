// What the language server answered, as the pane keeps it: lists of places
// for the list screen (uses of a name, callers, implementations, names that
// match), and the card of a looked-up name.

import type { Comment } from './review'
import type { Listing, ListRow, Lookup } from '../types'
import type { LspSymbol } from './lsp'
import type { CallNode, Place, PlaceLine, SymbolHit } from './lsp-types'
import { ISSUES_SENT } from './prompt'
import { groupPlaces, placesList, semanticColor } from './semantic'

// The most rows the list screen draws, and so the most a list holds.
export const LIST_ROWS = 300

// The colour a kind of name has in the code, for a list of names: an outline
// or a search names kinds as a symbol's, the colours are keyed by a token's.
const KIND_TOKEN = new Map([
  ['constant', 'variable'],
  ['field', 'property'],
  ['constructor', 'method'],
  ['module', 'namespace'],
])

export const kindColor = (kind: string): string =>
  semanticColor(KIND_TOKEN.get(kind) ?? kind, kind === 'constant' ? ['readonly'] : [])

// Where a list entry points, as a row: an indented line that reads
// "12: the line's text" under its file's heading.
const placeRows = (places: readonly PlaceLine[], current: string): ListRow[] =>
  groupPlaces(places, current).files.flatMap(group => [
    { label: `${group.path}  (${group.places.length})`, path: '', line: 0 },
    ...group.places.map(place => ({
      label: `  ${String(place.line).padStart(4)}: ${place.text}`,
      path: place.path,
      line: place.line,
    })),
  ])

// Everywhere a name is used, the file it was asked about first; this list
// also has a form for the prompt.
export const usesList = (name: string, file: string, places: readonly PlaceLine[]): Listing => ({
  title: `${places.length} uses of ${name}`,
  rows: placeRows(places, file),
  prompt: placesList(name, places, ISSUES_SENT),
})

// Who calls a function, or what it calls.
export const callsList = (
  name: string,
  direction: 'incoming' | 'outgoing',
  calls: readonly CallNode[],
): Listing => ({
  title: direction === 'incoming' ? `What calls ${name}` : `What ${name} calls`,
  rows: calls.map(call => ({
    label: `${call.name}  ${call.place.path.split('/').slice(-2).join('/')}:${call.place.line}  ${call.detail}`,
    path: call.place.path,
    line: call.place.line,
  })),
  prompt: '',
})

// What implements an interface, abstract method or protocol.
export const implementationsList = (name: string, places: readonly Place[]): Listing => ({
  title: `What implements ${name}`,
  rows: places.map(place => ({
    label: `${place.path}:${place.line}`,
    path: place.path,
    line: place.line,
  })),
  prompt: '',
})

// Names anywhere in the project that match what was typed, each with its
// kind's mark and colour.
export const namesList = (query: string, hits: readonly SymbolHit[]): Listing => ({
  title: `Names matching "${query}"`,
  rows: hits.map(hit => ({
    label: hit.name,
    mark: '›',
    path: hit.place.path,
    line: hit.place.line,
    color: kindColor(hit.kind),
    tail: `${hit.kind}${hit.container === '' ? '' : ` in ${hit.container}`} · ${hit.place.path.split('/').slice(-2).join('/')}`,
  })),
  prompt: '',
})

// What the server said of the name at a place in a file, as the file screen
// shows it: its type and docs, where it is defined, and the call it sits in.
export const lookupOf = (
  file: string,
  name: string,
  line: number,
  col: number,
  answer: LspSymbol,
): Lookup => ({
  file,
  name,
  at: line,
  col,
  text: answer.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''),
  path: answer.definition?.path ?? '',
  line: answer.definition?.line ?? 0,
  typePath: answer.typeDefinition?.path ?? '',
  typeLine: answer.typeDefinition?.line ?? 0,
  hasImplementations: (answer.implementations?.length ?? 0) > 0,
  // The call the name sits in, with the argument being given marked.
  signature:
    answer.signature === undefined
      ? ''
      : answer.signature.parameters.length === 0
        ? answer.signature.label
        : `(${answer.signature.parameters.map((one, index) => (index === answer.signature?.active ? `[${one}]` : one)).join(', ')})`,
})

// A review comment in one line, for a list: where, who, and how it starts.
const threadLine = (one: Comment, replies: number): string =>
  `${one.path === '' ? '' : `${one.path}${one.line > 0 ? `:${one.line}` : ''}  `}${one.author}: ${one.body.trim().replace(/\s+/g, ' ').slice(0, 90)}${replies > 0 ? `  (+${replies})` : ''}`

// Every thread of a pull or merge request: the open ones first, then the
// resolved, then what was said of the request as a whole. A thread is its
// first comment; its replies are counted. The form for the prompt is the open
// threads in full, replies and all: what is still to be answered.
export const threadsList = (request: string, comments: readonly Comment[]): Listing => {
  const roots = comments.filter(one => one.replyTo === undefined)
  const repliesTo = (root: Comment): Comment[] => comments.filter(one => one.replyTo === root.id)
  const placed = roots.filter(one => one.path !== '')
  const open = placed.filter(one => one.isResolved !== true)
  const settled = placed.filter(one => one.isResolved === true)
  const general = roots.filter(one => one.path === '')
  const rowsOf = (threads: readonly Comment[], mark: string): ListRow[] =>
    threads.map(one => ({
      label: `${mark}${threadLine(one, repliesTo(one).length)}`,
      path: one.path,
      line: Math.max(1, one.line),
    }))

  return {
    title: `${request === '' ? 'Review' : request}: ${open.length} open, ${settled.length} resolved`,
    rows: [
      ...(open.length > 0 ? [{ label: `Open (${open.length})`, path: '', line: 0 }] : []),
      ...rowsOf(open, ''),
      ...(settled.length > 0 ? [{ label: `Resolved (${settled.length})`, path: '', line: 0 }] : []),
      ...rowsOf(settled, '✓ '),
      ...(general.length > 0
        ? [{ label: `On the request as a whole (${general.length})`, path: '', line: 0 }]
        : []),
      ...general.map(one => ({ label: `  ${threadLine(one, 0)}`, path: '', line: 0 })),
    ],
    prompt:
      open.length === 0
        ? ''
        : [
            `Open review comments${request === '' ? '' : ` in ${request}`} (${open.length}):`,
            ...open.flatMap(one => [
              `- ${one.path}${one.line > 0 ? `:${one.line}` : ''} ${one.author}: ${one.body.trim().replace(/\s*\n\s*/g, ' ')}`,
              ...repliesTo(one).map(
                reply => `  - ${reply.author}: ${reply.body.trim().replace(/\s*\n\s*/g, ' ')}`,
              ),
            ]),
          ].join('\n'),
  }
}
