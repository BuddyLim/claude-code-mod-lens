// What the language server answered, as the pane keeps it: lists of places
// for the list screen (uses of a name, callers, implementations, names that
// match), and the card of a looked-up name.

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
