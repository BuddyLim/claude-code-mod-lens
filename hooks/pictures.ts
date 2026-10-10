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

// Fetches one address into a folder of its own, makes what came a PNG, and
// prints the file and its size. $1 the address, $2 the name to keep it
// under, $3 the most bytes. The picture is told by its first bytes, never by
// its name; what is no picture, or one no tool here can make a PNG, fails.
const FETCH = [
  'dir="${TMPDIR:-/tmp}/lens-pictures"',
  'mkdir -p "$dir" && chmod 700 "$dir" || exit 1',
  'raw="$dir/$2.raw"; png="$dir/$2.png"',
  'if [ ! -s "$png" ]; then',
  '  curl -sSL --proto "=https" --proto-redir "=https" --max-redirs 5 --max-time 20 --max-filesize "$3" -o "$raw" -- "$1" || { rm -f "$raw"; exit 1; }',
  '  [ "$(wc -c < "$raw" | tr -d " ")" -le "$3" ] || { rm -f "$raw"; exit 1; }',
  '  magic=$(od -An -tx1 -N12 "$raw" | tr -d " \\n")',
  '  case "$magic" in',
  '    89504e470d0a1a0a*) mv "$raw" "$png" ;;',
  '    ffd8ff*|474946383?61*|52494646????????57454250)',
  '      if command -v sips >/dev/null 2>&1; then sips -s format png "$raw" --out "$png" >/dev/null 2>&1',
  '      elif command -v magick >/dev/null 2>&1; then magick "$raw[0]" "png:$png" >/dev/null 2>&1',
  '      elif command -v convert >/dev/null 2>&1; then convert "$raw[0]" "png:$png" >/dev/null 2>&1',
  '      else rm -f "$raw"; exit 1; fi',
  '      rm -f "$raw" ;;',
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
// draw. `name` is the file's own, of letters and digits: the caller's count.
export const fetchPicture = async (
  run: Run,
  url: string,
  forge: string,
  name: string,
): Promise<Picture | undefined> => {
  if (!isFetched(url, forge) || !/^[a-z0-9-]{1,64}$/.test(name)) {
    return undefined
  }

  const ran = await run(['sh', '-c', FETCH, 'sh', url, name, String(PICTURE_BYTES)], { timeoutMs: 40_000 })
  const [file = '', size = ''] = ran.stdout.trim().split('\n')
  const [width = 0, height = 0] = size.split(' ').map(Number)

  return ran.exitCode === 0 &&
    file.startsWith('/') &&
    file.endsWith(`/lens-pictures/${name}.png`) &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= PICTURE_PIXELS &&
    height <= PICTURE_PIXELS
    ? { file, width, height }
    : undefined
}
