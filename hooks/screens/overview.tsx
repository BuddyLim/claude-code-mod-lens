// The overview screen: what the request under review is, beyond its code.
// What it says it does (its description, rendered), what it links to that a
// terminal cannot show in place, whether its checks pass, who has reviewed
// it, whether it can be merged, and its commits. It is as long as that, so
// the pane scrolls it.

import { ageOf } from '../git'
import type { Media } from '../media'
import { hostOf, markLinks, mediaOf } from '../media'
import type { Picture } from '../pictures'
import { cellsOf } from '../pictures'
import type { Comment, Overview, RequestAct } from '../review'
import { isDraft, isOnWholeFile } from '../review'
import { rowsOf } from '../rows'
import { chunkMarkdown } from '../text'
import type { Kit, Shell } from './frame'
import { COMMIT_BOX, FILES_ICON, LINK_ICON, RESOLVED_COLOR, helpButton, stateOf, skeleton, statusLine, talkColor, talkIcon } from './frame'
import type { TalkActions } from './talk'
import { conversation } from './talk'

// The most of a description that is drawn, and the size of each piece of it:
// an element's text is bounded, and so is the tree as a whole.
const BODY_SHOWN = 40_000
const BODY_PIECE = 8000
const LISTED = 40
// How many of the conversation, and of the threads on files, are listed
// until the rest are asked for; and the most of each that are.
const FOLDED = 5
// The most rows the line beside a description runs for.
const BAR_ROWS = 600
const TALK_ALL = 40
const THREADS_ALL = 60
// How many of its commits are listed until the rest are asked for.
const COMMITS_FOLDED = 5
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
  // Whether every commit is listed, in place of the latest few.
  isCommitsOpen: boolean
  // What has been said on the request: on it as a whole, and on its files.
  // `canTalk` is whether something can be said on it from here.
  comments: readonly Comment[]
  canTalk: boolean
  talkOpen: string
  talkReply: string
  talkRound: number
  // Whether all of the conversation, and every thread on a file, is listed
  // in place of the first few.
  isTalkAll: boolean
  isThreadsAll: boolean
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
  // Between the latest few commits and all of them.
  toggleCommits: () => void
  // The same for the conversation, and for the threads on files.
  toggleTalkAll: () => void
  toggleThreadsAll: () => void
  // Opens a file at the line a thread is on.
  openThread: (path: string, line: number) => void
  help: () => void
} & Omit<TalkActions, 'open'>

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
  // What was said on the request as a whole; and the threads on its files,
  // by their first comments, those still open first.
  const general = model.comments.filter(one => one.path === '' && one.line === 0 && !isDraft(one))
  const threads = model.comments
    .filter(one => one.path !== '' && one.replyTo === undefined)
    .sort(
      (a, b) =>
        Number(a.isResolved === true) - Number(b.isResolved === true) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    )
  const settled = threads.filter(one => one.isResolved === true).length
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
      {/* While the forge is asked, the page has its shape already: a title,
          who and where, how it stands, and a description's paragraphs. */}
      {overview === undefined &&
        model.refusal === '' &&
        skeleton(
          kit,
          [0.55, 0.8, 0.4, 0, 0.22, 0.5, 0.35, 0.45, 0, 0.18, 0.9, 0.95, 0.7, 0, 0.85, 0.6, 0.9, 0.3],
          model.shell.columns - 2,
          `Asking the forge about ${model.label}…`,
        )}
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
          {/* A grey bar runs down its left side, as beside a quotation: what
              the request says of itself is set apart from what lens says of
              it, at its own brightness. The bar is a cell of background as
              tall as the text beside it. */}
          {body !== '' && (
            <Box>
              {/* A thin line, not a cell of colour: one stroke a row, laid
                  beside the text from its top to its bottom and cut off
                  there, so it is as tall as the text whatever that comes to. */}
              <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden">
                {/* About as many strokes as the text has rows, should a
                    surface not cut the line where the text ends. */}
                <Text color="#5a5a5a">
                  {'│\n'.repeat(
                    Math.min(BAR_ROWS, Math.max(1, rowsOf({ type: 'Markdown', props: { text: body.slice(0, BODY_SHOWN) } }, shell.columns - 4))),
                  )}
                </Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={2}>
                {Markdown === undefined
                  ? body
                      .slice(0, BODY_SHOWN)
                      .split('\n')
                      .slice(0, 400)
                      .map(line => <Text>{line === '' ? ' ' : line}</Text>)
                  : chunkMarkdown(markLinks(body.slice(0, BODY_SHOWN), LINK_ICON), BODY_PIECE).map(piece => (
                      <Markdown text={piece} />
                    ))}
              </Box>
            </Box>
          )}
          {body.length > BODY_SHOWN && <Text dimColor>… the rest of it is on the request's page.</Text>}

          {/* A terminal draws no picture, video or document in place: each
              is a link that opens where it can be seen. */}
          {media.length > 0 && heading(`Attachments (${media.length})`)}
          {/* The same links as in the description above, gathered: what it
              shows or attaches, apart from the pages it only points to. */}
          {media.length > 0 && (
            <Text dimColor wrap="truncate-end">
              The pictures, videos and files the description links to, gathered here; pictures are drawn.
            </Text>
          )}
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

          {/* What was said on the request as a whole: its latest few, each
              opened by its author's name, with the box to answer in. */}
          {general.length === 0 && model.canTalk && (
            <Box flexDirection="column">
              <Text> </Text>
              <Box columnGap={2}>
                <Text bold>Conversation (0)</Text>
                <Button
                  plain
                  key="talk-new"
                  hotkey="o"
                  label={model.talkReply === 'new' ? 'close' : 'comment'}
                  onPress={() => actions.writeTalk(model.talkReply === 'new' ? '' : 'new')}
                />
              </Box>
            </Box>
          )}
          {conversation(
            kit,
            {
              shell,
              comments: general,
              canTalk: model.canTalk,
              isInSection: false,
              rows: model.isTalkAll ? TALK_ALL : FOLDED,
              talkOpen: model.talkOpen,
              talkReply: model.talkReply,
              talkRound: model.talkRound,
            },
            { ...actions, open: () => undefined },
          )}
          {general.length > FOLDED && (
            <Box>
              <Button
                plain
                dimColor
                key="talk-more"
                label={
                  model.isTalkAll
                    ? `▴ show only the latest ${FOLDED}`
                    : `▾ show ${Math.min(TALK_ALL, general.length) - FOLDED} earlier comments`
                }
                onPress={actions.toggleTalkAll}
              />
            </Box>
          )}

          {/* The threads on its files, a row each: what is still open
              first. A thread's place opens its file there. */}
          {threads.length > 0 &&
            heading(`Comments on files (${threads.length - settled} open${settled === 0 ? '' : ` · ${settled} resolved`})`)}
          {threads.slice(0, model.isThreadsAll ? THREADS_ALL : FOLDED).map(one => {
            const replies = model.comments.filter(other => other.replyTo === one.id).length
            const place =
              one.line > 0
                ? `${one.path}:${one.line}`
                : `${one.path} (${isOnWholeFile(one) ? 'whole file' : one.oldLine !== undefined ? 'removed line' : 'outdated'})`

            return (
              <Box height={1} overflow="hidden">
                <Box flexShrink={0}>
                  <Text color={one.isResolved === true ? RESOLVED_COLOR : talkColor(one)}>{talkIcon(one)} </Text>
                  <Button
                    plain
                    key={`thread:${one.id}`}
                    label={place}
                    onPress={() => actions.openThread(one.path, Math.max(1, one.line))}
                  />
                </Box>
                <Text dimColor={one.isResolved === true} wrap="truncate-end">
                  {'  '}
                  {one.author === '' ? '' : `@${one.author}: `}
                  {one.body.replace(/\s+/g, ' ').slice(0, 300)}
                  {replies === 0 ? '' : `  · ${replies} ${replies === 1 ? 'reply' : 'replies'}`}
                  {one.isResolved === true ? '  ✓ resolved' : ''}
                </Text>
              </Box>
            )
          })}
          {threads.length > FOLDED && (
            <Box>
              <Button
                plain
                dimColor
                key="threads-more"
                label={
                  model.isThreadsAll
                    ? `▴ show only the first ${FOLDED}`
                    : `▾ show ${Math.min(THREADS_ALL, threads.length) - FOLDED} more threads`
                }
                onPress={actions.toggleThreadsAll}
              />
            </Box>
          )}

          {overview.commits.length > 0 && heading(`Commits (${overview.commits.length})`)}
          {/* The latest few, the newest first; the rest are a press away. */}
          {overview.commits
            .slice(model.isCommitsOpen ? -LISTED : -COMMITS_FOLDED)
            .reverse()
            .map(commit => (
              <Text wrap="truncate-end">
                <Text color="yellow">{commit.hash}</Text> {commit.subject}
                <Text dimColor>{commit.author === '' ? '' : `  @${commit.author}`}</Text>
              </Text>
            ))}
          {overview.commits.length > COMMITS_FOLDED && (
            <Box>
              <Button
                plain
                dimColor
                key="commits-more"
                label={
                  model.isCommitsOpen
                    ? `▴ show only the latest ${COMMITS_FOLDED}`
                    : `▾ show ${Math.min(LISTED, overview.commits.length) - COMMITS_FOLDED} earlier commits`
                }
                onPress={actions.toggleCommits}
              />
            </Box>
          )}
          {model.isCommitsOpen && overview.commits.length > LISTED && (
            <Text dimColor>… {overview.commits.length - LISTED} earlier still are on the request's page.</Text>
          )}
        </Box>
      )}
    </Box>
  )
}
