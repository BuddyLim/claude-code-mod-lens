// The pictures of a request's description, drawn in place where the terminal
// can draw one. A picture is a link in someone else's text, so which ones
// are fetched at all is decided here, and each is fetched by a fixed command
// with its address as an argument: only https, only from the forge's own
// hosts, a bounded size, a bounded time. What comes back is made a PNG file
// the terminal reads itself; anything else stays the link it was.

import type { Run } from './run'

// A picture ready to draw: the PNG file holding it, and its size in pixels.
export type Picture = { file: string; width: number; height: number }

// The most a picture may weigh to be fetched, and the widest and tallest one
// that is drawn.
export const PICTURE_BYTES = 2 * 1024 * 1024
const PICTURE_PIXELS = 4096
// How many of a description's pictures are drawn; the rest stay links.
export const PICTURES_SHOWN = 6
// How many times a picture's address may point on to another.
const REDIRECTS = 4

// The hosts a forge serves its own pictures from, beside the forge itself:
// what people drop into a description, and a file of a repository.
const GITHUB_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'camo.githubusercontent.com',
  'avatars.githubusercontent.com',
]

// Whether a picture's address is one lens fetches: https, with no name and
// password in it, on the forge's own host or (for GitHub) one of the hosts
// it serves pictures from. `forge` is the host of the repository's remote.
export const isFetched = (url: string, forge: string): boolean => {
  const parts = /^https:\/\/([^/?#@\s:]{1,200})(?::443)?(?:[/?#][\x21-\x7e]{0,2000})?$/.exec(url)
  const host = parts?.[1]?.toLowerCase() ?? ''
  const home = forge.toLowerCase()

  return host !== '' && home !== '' && (host === home || (home === 'github.com' && GITHUB_HOSTS.includes(host)))
}

// How many cells a picture takes when it is drawn `columns` wide at most: as
// wide as it is, where it is narrower, and as tall as keeps its shape (a
// cell is about twice as tall as it is wide), within `rows`.
export const cellsOf = (
  picture: Pick<Picture, 'width' | 'height'>,
  columns: number,
  rows: number,
): { columns: number; rows: number } => {
  const wide = Math.max(1, Math.min(columns, 255, Math.round(picture.width / 8)))
  const tall = Math.max(1, Math.round((wide * picture.height) / picture.width / 2))

  return tall <= rows
    ? { columns: wide, rows: tall }
    : { columns: Math.max(1, Math.round((rows * 2 * picture.width) / picture.height)), rows: Math.max(1, rows) }
}

// Fetches one address into a folder that is the person's alone, makes what
// came a PNG, and prints the file and its size. $1 the address, $2 the most
// bytes, $3 the address the picture was first asked for by (its name). The folder is in the person's own cache, never the shared /tmp, and
// is refused where it is a link or someone else's. The file is named by the
// SHA-256 of the address, worked out here, so two addresses never share one.
// The address is taken as it is written (no braces or brackets are spread
// into many), and the picture is told by its first bytes, never by its name;
// what is no picture, or one no tool here can make a PNG, fails.
const FETCH = [
  'umask 077',
  'base="${XDG_CACHE_HOME:-${HOME:+$HOME/.cache}}"',
  '[ -n "$base" ] || exit 1',
  'dir="$base/lens-pictures"',
  'mkdir -p "$dir" || exit 1',
  '[ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] || exit 1',
  'chmod 700 "$dir" || exit 1',
  'if command -v shasum >/dev/null 2>&1; then name=$(printf %s "$3" | shasum -a 256 | cut -c1-64)',
  'elif command -v sha256sum >/dev/null 2>&1; then name=$(printf %s "$3" | sha256sum | cut -c1-64)',
  'else exit 1; fi',
  '[ "${#name}" -eq 64 ] || exit 1',
  'case "$name" in *[!0-9a-f]*) exit 1 ;; esac',
  // Pictures not looked at for two weeks go, so the folder does not grow.
  'find "$dir" -type f -mtime +14 -delete 2>/dev/null',
  'raw="$dir/$name.$$.raw"; made="$dir/$name.$$.png"; png="$dir/$name.png"',
  'if [ ! -s "$png" ] || [ -L "$png" ]; then',
  '  rm -f "$png"',
  // No redirect is followed here: where the answer is one, the address it
  // points at is printed, for the caller to hold to the same hosts first.
  '  said=$(curl -sS --globoff --proto "=https" --max-redirs 0 --max-time 20 --max-filesize "$2" -o "$raw" -w "%{http_code} %{redirect_url}" -- "$1") || { rm -f "$raw"; exit 1; }',
  '  case "$said" in',
  '    3??\\ https://*) rm -f "$raw"; printf "to %s\\n" "${said#* }"; exit 0 ;;',
  '    200\\ *) ;;',
  '    *) rm -f "$raw"; exit 1 ;;',
  '  esac',
  '  [ "$(wc -c < "$raw" | tr -d " ")" -le "$2" ] || { rm -f "$raw"; exit 1; }',
  '  magic=$(od -An -tx1 -N12 "$raw" | tr -d " \\n")',
  '  case "$magic" in',
  '    89504e470d0a1a0a*) mv -f "$raw" "$png" ;;',
  '    ffd8ff*|474946383?61*|52494646????????57454250)',
  '      if command -v sips >/dev/null 2>&1; then sips -s format png "$raw" --out "$made" >/dev/null 2>&1',
  '      elif command -v magick >/dev/null 2>&1; then magick "$raw[0]" "png:$made" >/dev/null 2>&1',
  '      elif command -v convert >/dev/null 2>&1; then convert "$raw[0]" "png:$made" >/dev/null 2>&1',
  '      fi',
  '      rm -f "$raw"',
  '      [ -s "$made" ] && mv -f "$made" "$png" || { rm -f "$made"; exit 1; } ;;',
  '    *) rm -f "$raw"; exit 1 ;;',
  '  esac',
  'fi',
  '[ -s "$png" ] || exit 1',
  // A PNG says its size in its first chunk: four bytes each, big end first.
  'set -- $(od -An -tu1 -j16 -N8 "$png")',
  '[ "$#" -eq 8 ] || exit 1',
  'printf "%s\\n%s %s\\n" "$png" "$(( (($1 * 256 + $2) * 256 + $3) * 256 + $4 ))" "$(( (($5 * 256 + $6) * 256 + $7) * 256 + $8 ))"',
].join('\n')

// Fetches a picture and answers where it is and how big, or undefined where
// it is not one lens fetches, could not be fetched, or is no picture to
// draw.
export const fetchPicture = async (run: Run, url: string, forge: string): Promise<Picture | undefined> => {
  if (!isFetched(url, forge)) {
    return undefined
  }

  // A forge answers some pictures with another address. Each one it points
  // at is held to the same hosts before it is asked, a few times at most, so
  // a redirect cannot lead the fetch anywhere the first address could not go.
  let from = url
  let ran = await run(['sh', '-c', FETCH, 'sh', from, String(PICTURE_BYTES), url], { timeoutMs: 40_000 })

  for (let hop = 0; hop < REDIRECTS && ran.exitCode === 0 && ran.stdout.startsWith('to '); hop++) {
    from = ran.stdout.slice(3).trim()

    if (!isFetched(from, forge)) {
      return undefined
    }

    ran = await run(['sh', '-c', FETCH, 'sh', from, String(PICTURE_BYTES), url], { timeoutMs: 40_000 })
  }

  const [file = '', size = ''] = ran.stdout.trim().split('\n')
  const [width = 0, height = 0] = size.split(' ').map(Number)

  return ran.exitCode === 0 &&
    /^\/[\x20-\x7e]{1,900}\/lens-pictures\/[0-9a-f]{64}\.png$/.test(file) &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= PICTURE_PIXELS &&
    height <= PICTURE_PIXELS
    ? { file, width, height }
    : undefined
}
