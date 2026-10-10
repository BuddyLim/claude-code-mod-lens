// The overview screen: what the request under review is, beyond its code.
// What it says it does (its description, rendered), what it links to that a
// terminal cannot show in place, whether its checks pass, who has reviewed
// it, whether it can be merged, and its commits. It is as long as that, so
// the pane scrolls it.

import { ageOf } from '../git'
import type { Media } from '../media'
import { hostOf, mediaOf } from '../media'
import type { Picture } from '../pictures'
import { cellsOf } from '../pictures'
import type { Overview, RequestAct } from '../review'
import { chunkMarkdown } from '../text'
import type { Kit, Shell } from './frame'
import { COMMIT_BOX, FILES_ICON, LINK_ICON, helpButton, stateOf, statusLine } from './frame'

// The most of a description that is drawn, and the size of each piece of it:
// an element's text is bounded, and so is the tree as a whole.
const BODY_SHOWN = 40_000
const BODY_PIECE = 8000
const LISTED = 40
// The most rows one picture takes.
const PICTURE_ROWS = 24

export type OverviewModel = {
  shell: Shell
  // What the request is called here ("PR #12").
  label: string
  // The overview, or undefined while the forge is being asked; and why it
  // could not be read, '' when it was.
  overview: Overview | undefined
  refusal: string
  // The time now, in milliseconds, for how long ago each review was.
  now: number
  // The description's pictures, by their address: fetched and ready to draw,
  // still being fetched, or not one that is drawn (another site's, too big,
  // no picture at all). One not here has not been asked for.
  pictures: ReadonlyMap<string, Picture | 'loading' | 'none'>
  // The action being asked about before it is done ('' for none), and
  // whether one is under way.
  asking: RequestAct | ''
  isActing: boolean
}

export type OverviewActions = {
  back: () => void
  refresh: () => void
  // Compares the request's head with the commit the person last reviewed.
  sinceReview: () => void
  // On to the request's code: the file tree, or every change on one page.
  openFiles: () => void
  openChanges: () => void
  // Asks about an action before doing it ('' takes the question away), and
  // does the one asked about.
  ask: (act: RequestAct | '') => void
  act: (act: RequestAct) => void
  help: () => void
}

const MEDIA_WORD: Record<Media['kind'], string> = { image: 'picture', video: 'video', file: 'file' }

// What each action is asked as before it is done, and what its yes says.
const ASKED: Record<RequestAct, (label: string, overview: Overview) => string> = {
  merge: (label, overview) => `Merge ${label} into ${overview.base}? It cannot be undone from here.`,
  squash: (label, overview) => `Squash ${label} into one commit on ${overview.base}? It cannot be undone from here.`,
  rebase: (label, overview) => `Rebase ${label} onto ${overview.base} and merge it? It cannot be undone from here.`,
  close: label => `Close ${label} without merging it?`,
  ready: label => `Mark ${label} ready for review? Its reviewers are told.`,
  checkout: (label, overview) => `Check out ${overview.head} here? Your working tree changes to ${label}'s branch.`,
}
const YES: Record<RequestAct, string> = {
  merge: 'merge',
  squash: 'squash and merge',
  rebase: 'rebase and merge',
  close: 'close it',
  ready: 'mark it ready',
  checkout: 'check it out',
}

export const overviewScreen = (kit: Kit, model: OverviewModel, actions: OverviewActions) => {
  const { Box, Button, Text, Markdown, Link, Image } = kit
  const { shell, overview } = model
  const body = (overview?.body ?? '').trim()
  const media = mediaOf(body)
  const failing = (overview?.checks ?? []).filter(check => stateOf(check.state)[0] === '✖').length
  const going = (overview?.checks ?? []).filter(check => stateOf(check.state)[0] === '●').length
  const heading = (text: string) => [<Text> </Text>, <Text bold>{text}</Text>]
  // A link where the surface draws them, in a link's colour; else its text.
  const link = (href: string, label: string) =>
    // What a link is called is its writer's to choose; where it goes is said
    // beside it, read off the link itself, so a name cannot pass for a site.
    Link !== undefined && /^https?:\/\//.test(href) ? (
      <Text wrap="truncate-end">
        <Text color={COMMIT_BOX} underline>
          <Link href={href}>
            {label} {LINK_ICON}
          </Link>
        </Text>
        {label === href ? '' : <Text dimColor> → {hostOf(href)}</Text>}
      </Text>
    ) : (
      <Text>{label}</Text>
    )

  return (
    <Box flexDirection="column">
      {statusLine(kit, shell)}
      <Box columnGap={2} flexWrap="wrap">
        <Button plain key="back" hotkey="b" label="back" onPress={actions.back} />
        {/* On from what the request says to its code. */}
        <Button plain key="files" hotkey="f" label="its files" onPress={actions.openFiles} />
        <Button plain key="changes" hotkey="d" label="all changes" onPress={actions.openChanges} />
        <Button plain key="refresh" hotkey="r" label="refresh" onPress={actions.refresh} />
        {overview !== undefined && overview.lastReviewed !== '' && (
          <Button plain key="since" hotkey="s" label="changes since your review" onPress={actions.sinceReview} />
        )}
        {helpButton(kit, actions.help)}
      </Box>
      {/* What can be done to the request as a whole. Each changes something
          that is not undone from here, so it takes a second press that says
          what will happen. */}
      {overview !== undefined && overview.state.toUpperCase().startsWith('OPEN') && model.asking === '' && (
        <Box columnGap={2} flexWrap="wrap">
          <Button key="act-merge" label="merge" onPress={() => actions.ask('merge')} />
          <Button key="act-squash" label="squash and merge" onPress={() => actions.ask('squash')} />
          <Button key="act-rebase" label="rebase and merge" onPress={() => actions.ask('rebase')} />
          {overview.isDraft && <Button key="act-ready" label="mark ready" onPress={() => actions.ask('ready')} />}
          <Button key="act-checkout" label="check out here" onPress={() => actions.ask('checkout')} />
          <Button key="act-close" label="close" onPress={() => actions.ask('close')} />
        </Box>
      )}
      {overview !== undefined && model.asking !== '' && (
        <Box columnGap={2} flexWrap="wrap">
          <Text color="red" bold>
            {ASKED[model.asking](model.label, overview)}
          </Text>
          <Button key="act-yes" label={`yes, ${YES[model.asking]}`} onPress={() => actions.act(model.asking as RequestAct)} />
          <Button key="act-no" variant="primary" label="no" onPress={() => actions.ask('')} />
        </Box>
      )}
      {model.isActing && <Text dimColor>Asking the forge to do it…</Text>}
      {overview === undefined && model.refusal === '' && <Text dimColor>Asking the forge about {model.label}…</Text>}
      {model.refusal !== '' && (
        <Text color="yellow" wrap="truncate-end">
          ! {model.refusal}
        </Text>
      )}
      {overview !== undefined && (
        <Box flexDirection="column">
          <Box height={1} overflow="hidden">
            <Text bold wrap="truncate-end">
              {model.label}: {overview.title}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {overview.author === '' ? '' : `@${overview.author} · `}
            {overview.head} → {overview.base} · {overview.state.toLowerCase()}
            {overview.isDraft ? ' · draft' : ''}
            {overview.files === 0 ? '' : ` · ${FILES_ICON} ${overview.files}`}
            {/* The lines it adds and takes away, each in its own colour, dimmed. */}
            {overview.additions + overview.deletions > 0 && ' · '}
            {overview.additions + overview.deletions > 0 && (
              <Text color="green" dimColor>
                +{overview.additions}
              </Text>
            )}
            {overview.additions + overview.deletions > 0 && (
              <Text color="red" dimColor>
                {' '}
                −{overview.deletions}
              </Text>
            )}
          </Text>
          {overview.url !== '' && <Box>{link(overview.url, overview.url)}</Box>}
          {overview.labels.length > 0 && <Text dimColor>labels: {overview.labels.join(', ')}</Text>}

          {/* Where it stands: whether it can be merged, what its reviews
              come to, and its checks in a word. */}
          {heading('Where it stands')}
          {overview.mergeable !== '' && (
            <Text>
              <Text color={stateOf(overview.mergeable)[1]}>{stateOf(overview.mergeable)[0]}</Text> merging:{' '}
              {overview.mergeable.toLowerCase().replace(/_/g, ' ')}
            </Text>
          )}
          <Text>
            <Text color={overview.decision === '' ? 'yellow' : stateOf(overview.decision)[1]}>
              {overview.decision === '' ? '●' : stateOf(overview.decision)[0]}
            </Text>{' '}
            reviews: {overview.decision === '' ? 'none that decide it yet' : overview.decision.toLowerCase().replace(/_/g, ' ')}
          </Text>
          <Text>
            <Text color={failing > 0 ? 'red' : going > 0 ? 'yellow' : 'green'}>
              {failing > 0 ? '✖' : going > 0 ? '●' : '✓'}
            </Text>{' '}
            checks:{' '}
            {overview.checks.length === 0
              ? 'none reported'
              : `${overview.checks.length - failing - going} passed${failing > 0 ? `, ${failing} failed` : ''}${going > 0 ? `, ${going} still going` : ''}`}
          </Text>

          {overview.checks.length > 0 && heading(`Checks (${overview.checks.length})`)}
          {overview.checks.slice(0, LISTED).map(check => (
            <Box height={1} overflow="hidden">
              <Text color={stateOf(check.state)[1]}>{stateOf(check.state)[0]} </Text>
              {link(check.url, check.name || 'check')}
              <Text dimColor> {check.state.toLowerCase().replace(/_/g, ' ')}</Text>
            </Box>
          ))}

          {overview.reviews.length > 0 && heading(`Reviews (${overview.reviews.length})`)}
          {overview.reviews.slice(0, LISTED).map(review => {
            const seconds = review.when === '' ? NaN : (model.now - Date.parse(review.when)) / 1000

            return (
              <Text wrap="truncate-end">
                <Text color={stateOf(review.state)[1]}>{stateOf(review.state)[0]}</Text> @{review.author}{' '}
                <Text dimColor>
                  {review.state.toLowerCase().replace(/_/g, ' ')}
                  {Number.isFinite(seconds) ? ` · ${ageOf(Math.max(0, seconds))} ago` : ''}
                </Text>
              </Text>
            )
          })}

          {/* What it says it does, as it reads: the surface renders the
              markdown, a piece at a time. */}
          {heading('Description')}
          {body === '' && <Text dimColor>It has no description.</Text>}
          {body !== '' &&
            (Markdown === undefined
              ? body
                  .slice(0, BODY_SHOWN)
                  .split('\n')
                  .slice(0, 400)
                  .map(line => <Text>{line === '' ? ' ' : line}</Text>)
              : chunkMarkdown(body.slice(0, BODY_SHOWN), BODY_PIECE).map(piece => <Markdown text={piece} />))}
          {body.length > BODY_SHOWN && <Text dimColor>… the rest of it is on the request's page.</Text>}

          {/* A terminal draws no picture, video or document in place: each
              is a link that opens where it can be seen. */}
          {media.length > 0 && heading(`Pictures, videos and files (${media.length})`)}
          {media.slice(0, LISTED).flatMap(one => {
            const picture = model.pictures.get(one.url)
            // A picture is drawn under its link where it has been fetched
            // and the terminal draws pictures; its words stand in elsewhere.
            const cells =
              picture === undefined || picture === 'loading' || picture === 'none'
                ? undefined
                : cellsOf(picture, Math.max(8, shell.columns - 4), PICTURE_ROWS)

            return [
              <Box height={1} overflow="hidden">
                <Text dimColor>{MEDIA_WORD[one.kind].padEnd(8)}</Text>
                {link(one.url, one.label)}
                {picture === 'loading' && <Text dimColor>  fetching…</Text>}
              </Box>,
              Image !== undefined && cells !== undefined && picture !== undefined && typeof picture === 'object' && (
                <Box marginLeft={2} marginBottom={1}>
                  <Image
                    source={{ file: picture.file, format: 'png' }}
                    columns={cells.columns}
                    rows={cells.rows}
                    alt={one.label === '' ? ' ' : one.label}
                  />
                </Box>
              ),
            ]
          })}
          {media.some(one => one.kind === 'video') && (
            <Text dimColor wrap="truncate-end">
              A video cannot be played here: its link opens it in the browser.
            </Text>
          )}

          {overview.commits.length > 0 && heading(`Commits (${overview.commits.length})`)}
          {overview.commits.slice(-LISTED).map(commit => (
            <Text wrap="truncate-end">
              <Text color="yellow">{commit.hash}</Text> {commit.subject}
              <Text dimColor>{commit.author === '' ? '' : `  @${commit.author}`}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
