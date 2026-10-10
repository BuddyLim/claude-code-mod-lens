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
export const mediaOf = (markdown: string): Media[] => {
  const found = new Map<string, Media>()
  const take = (url: string, written: Media['kind'] | undefined, label: string) => {
    const kind = /^https?:\/\//.test(url) ? kindOf(url, written) : undefined

    if (kind !== undefined && !found.has(url)) {
      found.set(url, { kind, url, label: label.trim() || nameOf(url) })
    }
  }
  // Each kind of mention is looked for with where it starts, so the list
  // comes out in the order of the text.
  const mentions: { at: number; url: string; written: Media['kind'] | undefined; label: string }[] = []
  const scan = (pattern: RegExp, read: (hit: RegExpExecArray) => Omit<(typeof mentions)[number], 'at'>) => {
    for (const hit of markdown.matchAll(pattern)) {
      mentions.push({ at: hit.index, ...read(hit as RegExpExecArray) })
    }
  }

  scan(/!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g, hit => ({ url: hit[2] ?? '', written: 'image', label: hit[1] ?? '' }))
  scan(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, hit => ({
    url: hit[1] ?? '',
    written: 'image',
    label: /\balt=["']([^"']*)["']/i.exec(hit[0])?.[1] ?? '',
  }))
  scan(/<(?:video|source)\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, hit => ({ url: hit[1] ?? '', written: 'video', label: '' }))
  scan(/(?<!!)\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, hit => ({ url: hit[2] ?? '', written: undefined, label: hit[1] ?? '' }))
  scan(/(?<![("'=\]])\bhttps?:\/\/[^\s<>)"']+/g, hit => ({ url: hit[0], written: undefined, label: '' }))

  for (const one of mentions.sort((a, b) => a.at - b.at)) {
    take(one.url, one.written, one.label)
  }

  return [...found.values()]
}
