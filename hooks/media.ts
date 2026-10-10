// What a description or a comment links to that a terminal cannot draw in
// place: pictures, videos and documents. They are found in the markdown and
// listed under it, each a link that opens where it can be seen.

export type Media = { kind: 'image' | 'video' | 'file'; url: string; label: string }

const VIDEO = /\.(?:mp4|mov|webm|m4v|avi|mkv)(?:[?#]|$)/i
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic)(?:[?#]|$)/i
const FILE = /\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|log|zip|gz|tar|json|ya?ml|md|key|numbers|pages)(?:[?#]|$)/i
// What a forge serves an upload from, whatever its name ends with.
const UPLOAD = /\/user-attachments\/|\/uploads\/[0-9a-f]{16,}\/|\/files\/\d+\//

// The last part of a link's path, as a name to show; the link itself when
// it has none.
const nameOf = (url: string): string => {
  const last = (url.split(/[?#]/)[0] ?? '').split('/').filter(part => part !== '').pop() ?? ''

  try {
    return decodeURIComponent(last) || url
  } catch {
    return last || url
  }
}

const kindOf = (url: string, written: Media['kind'] | undefined): Media['kind'] | undefined =>
  VIDEO.test(url)
    ? 'video'
    : IMAGE.test(url)
      ? 'image'
      : FILE.test(url)
        ? 'file'
        : (written ?? (UPLOAD.test(url) ? 'file' : undefined))

// The pictures, videos and documents a piece of markdown holds, in the order
// they come, each once. A picture is one written as a picture (`![]()`, an
// `<img>`); a video an `<video>` or a link to a video file; a document a
// link to an upload or to a file of a kind people attach. A bare link to a
// forge's upload counts too: that is how GitHub writes a dropped video.
//
// The text is whoever wrote the request's, so it is read as untrusted: only
// its first `SCANNED` characters are looked at, every pattern's repeats are
// bounded (none can be made to try the same stretch over and over), no more
// than `MEDIA_KEPT` are kept, and a label is plain printable text of a
// length a row can hold.
export const SCANNED = 60_000
export const MEDIA_KEPT = 100
const LABEL = 120

// Text with nothing a terminal would act on: control characters go, and
// runs of space become one.
export const plain = (text: string): string =>
  text
    .replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()

// Whether a character is one a terminal acts on or that reorders the text
// round it, by its code point: the control characters, the zero-width and
// the direction marks.
const isActedOn = (code: number): boolean =>
  code < 32 ||
  (code >= 127 && code <= 159) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

// A block of text (a description, a comment) with those characters taken
// out, its lines and its tabs kept: what is handed on to be drawn.
export const plainBlock = (text: string): string =>
  Array.from(text)
    .filter(char => {
      const code = char.codePointAt(0) ?? 0

      return code === 9 || code === 10 || !isActedOn(code)
    })
    .join('')

export const mediaOf = (markdown: string): Media[] => {
  const text = markdown.slice(0, SCANNED)
  const found = new Map<string, Media>()
  const take = (url: string, written: Media['kind'] | undefined, label: string) => {
    // A link is http or https, of printable characters with no space in it.
    const kind = /^https?:\/\/[\x21-\x7e]{1,2000}$/.test(url) ? kindOf(url, written) : undefined

    if (kind !== undefined && !found.has(url) && found.size < MEDIA_KEPT) {
      found.set(url, { kind, url, label: (plain(label) || plain(nameOf(url))).slice(0, LABEL) })
    }
  }
  // Each kind of mention is looked for with where it starts, so the list
  // comes out in the order of the text.
  const mentions: { at: number; url: string; written: Media['kind'] | undefined; label: string }[] = []
  const scan = (pattern: RegExp, read: (hit: RegExpExecArray) => Omit<(typeof mentions)[number], 'at'>) => {
    for (const hit of text.matchAll(pattern)) {
      mentions.push({ at: hit.index, ...read(hit as RegExpExecArray) })
    }
  }

  scan(/!\[([^\]\n]{0,300})\]\(([^\s)]{1,2000})(?: "[^"\n]{0,300}")?\)/g, hit => ({
    url: hit[2] ?? '',
    written: 'image',
    label: hit[1] ?? '',
  }))
  scan(/<img\b([^>]{0,1000})>/gi, hit => ({
    url: /\bsrc=["']([^"'\s]{1,2000})["']/i.exec(hit[1] ?? '')?.[1] ?? '',
    written: 'image',
    label: /\balt=["']([^"'\n]{0,300})["']/i.exec(hit[1] ?? '')?.[1] ?? '',
  }))
  scan(/<(?:video|source)\b([^>]{0,1000})>/gi, hit => ({
    url: /\bsrc=["']([^"'\s]{1,2000})["']/i.exec(hit[1] ?? '')?.[1] ?? '',
    written: 'video',
    label: '',
  }))
  scan(/(?<!!)\[([^\]\n]{1,300})\]\(([^\s)]{1,2000})(?: "[^"\n]{0,300}")?\)/g, hit => ({
    url: hit[2] ?? '',
    written: undefined,
    label: hit[1] ?? '',
  }))
  scan(/(?<![("'=\]])\bhttps?:\/\/[^\s<>)"']{1,2000}/g, hit => ({ url: hit[0], written: undefined, label: '' }))

  for (const one of mentions.sort((a, b) => a.at - b.at)) {
    take(one.url, one.written, one.label)
  }

  return [...found.values()]
}

// The first few lines of a description, to show what it says at a glance:
// its text without the marks markdown is written with (a heading's `#`, a
// list's bullet, emphasis, a link's address, a picture, a tag), each line
// held to `width` and no more than `count` of them. Empty for a description
// that says nothing. What it is cut from is bounded, as in `mediaOf`.
export const sampleOf = (markdown: string, count: number, width: number): string[] => {
  const lines: string[] = []
  let isCode = false

  for (const raw of plainBlock(markdown.slice(0, SCANNED)).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      isCode = !isCode
      continue
    }

    const line = isCode
      ? raw.trim()
      : plain(
          raw
            .replace(/<!--[^>]{0,2000}-->/g, ' ')
            .replace(/!\[[^\]\n]{0,300}\]\([^)\s]{0,2000}\)/g, ' ')
            .replace(/\[([^\]\n]{1,300})\]\([^)\s]{0,2000}\)/g, '$1')
            .replace(/<[^>\n]{0,1000}>/g, ' ')
            .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,4}[.)]\s+|>\s?)+/, '')
            .replace(/(\*\*|__|\*|_|`|~~)/g, ''),
        )

    // A rule, a table's dashes or a line the marks were all of is no line.
    if (line === '' || /^[-=|:\s]+$/.test(line)) {
      continue
    }

    lines.push(line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line)

    if (lines.length >= count) {
      break
    }
  }

  return lines
}

// The site a link goes to, to say beside whatever it is called: a name is
// the writer's to choose, where it leads is not.
export const hostOf = (url: string): string => /^https?:\/\/([^/?#\s]{1,200})/i.exec(url)?.[1]?.toLowerCase() ?? ''
