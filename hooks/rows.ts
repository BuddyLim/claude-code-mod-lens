// How many rows a drawn tree takes, near enough, worked out from the tree
// itself: the engine tells a hook where its window is and how tall, but not
// how tall what it drew came out, until the person scrolls. So whether there
// is more below the window is first an estimate, by the rules a tree is laid
// out with, and the engine's own count once it has given one.

type Drawn = { type?: unknown; props?: Record<string, unknown> | null; children?: unknown } | string | number | boolean | null | undefined

const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const kids = (node: Drawn): Drawn[] =>
  typeof node === 'object' && node !== null && Array.isArray(node.children) ? (node.children.flat(8) as Drawn[]) : []
const isDrawn = (node: Drawn): boolean => node !== null && node !== undefined && node !== false && node !== true && node !== ''

// The text an element holds, its children's joined.
const textOf = (node: Drawn): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : typeof node === 'object' && node !== null
      ? typeof node.props?.label === 'string' && node.type !== 'Input'
        ? node.props.label
        : kids(node).map(textOf).join('')
      : ''

// How many cells an element asks for across, where it is one of a row.
const cellsOf = (node: Drawn): number => {
  if (typeof node !== 'object' || node === null) {
    return textOf(node).length
  }

  const props = node.props ?? {}

  return typeof props.width === 'number'
    ? props.width
    : node.type === 'Box'
      ? kids(node).filter(isDrawn).reduce((sum: number, one) => sum + cellsOf(one), 0) +
        2 * number(props.paddingX) +
        number(props.marginLeft) +
        number(props.marginRight)
      : node.type === 'Image'
        ? number(props.columns)
        : textOf(node).length + (node.type === 'Button' && props.plain !== true ? 4 : 0)
}

// The rows one element takes in `columns` cells.
export const rowsOf = (node: Drawn, columns: number): number => {
  if (!isDrawn(node)) {
    return 0
  }

  if (typeof node !== 'object' || node === null) {
    return 1
  }

  const props = node.props ?? {}
  const room = Math.max(1, columns)
  const outside =
    number(props.marginTop) + number(props.marginBottom) + 2 * number(props.marginY) + 2 * number(props.margin)

  if (node.type !== 'Box') {
    // Text cut to its row is one; text that wraps is as many as it fills.
    const text = textOf(node)
    const isCut = typeof props.wrap === 'string' && props.wrap.startsWith('truncate')
    const filled =
      node.type === 'Image' || node.type === 'Raster'
        ? Math.max(1, number(props.rows))
        : node.type === 'Text' || node.type === 'Markdown'
          ? isCut
            ? 1
            : (node.type === 'Markdown' && typeof props.children === 'string' ? props.children : text)
                .split('\n')
                .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / room)), 0)
          : 1

    return filled + outside
  }

  // A box laid over the rest takes no rows of its own.
  if (props.position === 'absolute') {
    return 0
  }

  if (typeof props.height === 'number') {
    return props.height + outside
  }

  const edge = typeof props.borderStyle === 'string' ? 1 : 0
  const inside =
    room - 2 * edge - 2 * number(props.paddingX) - 2 * number(props.padding) - number(props.marginLeft) - number(props.marginRight)
  const drawn = kids(node).filter(isDrawn)
  const heights = drawn.map(one => rowsOf(one, inside))
  const isColumn = props.flexDirection === 'column' || props.flexDirection === 'column-reverse'
  // A row is as tall as its tallest; one that wraps is as many rows as its
  // children fill, each as tall as the tallest.
  const across = drawn.reduce((sum: number, one) => sum + cellsOf(one), 0) + Math.max(0, drawn.length - 1) * number(props.columnGap)
  const body = isColumn
    ? heights.reduce((sum, one) => sum + one, 0) + Math.max(0, drawn.length - 1) * number(props.rowGap)
    : drawn.length === 0
      ? 0
      : Math.max(...heights) * (props.flexWrap === 'wrap' ? Math.max(1, Math.ceil(across / Math.max(1, inside))) : 1)

  return body + 2 * edge + 2 * number(props.paddingY) + 2 * number(props.padding) + outside
}

// How many rows lie below the window, and whether that is the engine's own
// count or the estimate. `measured` is what the engine last said the tree
// came to, and what the estimate was then: it holds for as long as the
// estimate has not changed (the same drawing), and the estimate does after.
export const rowsBelow = (
  estimate: number,
  window: { offset: number; rows: number },
  measured: { content: number; estimate: number } | undefined,
): { below: number; isExact: boolean } => {
  const isExact = measured !== undefined && measured.estimate === estimate
  const content = isExact ? measured.content : estimate

  return { below: Math.max(0, content - window.offset - window.rows), isExact }
}
