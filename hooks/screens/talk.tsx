// The conversation of a request: what was said on it as a whole, and the
// comments that sit on no line (the code under them has changed, or they are
// on a file as a whole), with the box an answer is typed in. The file tree
// draws it under the request's files, and the request's own page under what
// the request says.

import { hostOf, markLinks, mediaOf } from '../media'
import type { Comment } from '../review'
import { isOnWholeFile } from '../review'
import { wrapText } from '../text'
import type { Kit, Shell } from './frame'
import { COMMENT_COLOR, COMMIT_BOX, LINK_ICON, said, talkColor, talkIcon } from './frame'

// How many of the conversation's latest comments are listed.
export const CONVERSATION_ROWS = 15
// The most lines of one of them shown when it is opened; as markdown, the
// most characters (an element's text is bounded); and the most pictures,
// videos and files listed under it.
const TALK_LINES = 40
const TALK_SHOWN = 8000
const TALK_MEDIA = 12

export type TalkModel = {
  shell: Shell
  // The comments to list: those of them on no line are the conversation.
  comments: readonly Comment[]
  // Whether there is a request to say something on.
  canTalk: boolean
  // Whether it is drawn as part of a section above it, a step in.
  isInSection: boolean
  // How many of its latest are listed.
  rows: number
  // The comment opened in full ('' for none); the one being answered ('new'
  // for a comment of its own, '' for none); and how many have been sent.
  talkOpen: string
  talkReply: string
  talkRound: number
}

export type TalkActions = {
  // Opens the file a comment is on.
  open: (path: string) => void
  openTalk: (id: string) => void
  writeTalk: (id: string) => void
  typeTalk: (text: string) => void
  postTalk: (entered?: string) => void
}

export const conversation = (kit: Kit, model: TalkModel, actions: TalkActions) => {
  const { Box, Button, Text, Input, Markdown, Link } = kit
  const { shell, comments, canTalk, isInSection } = model
  const quoted = comments.find(one => one.id === model.talkReply && one.path === '')

  return (
    <Box flexDirection="column">
      {comments.some(one => one.line === 0) && !isInSection && <Text> </Text>}
      {comments.some(one => one.line === 0) && (
        <Box columnGap={2}>
          <Text bold={!isInSection} dimColor={isInSection}>
            {isInSection ? '  ' : ''}Conversation ({comments.filter(one => one.line === 0).length})
          </Text>
          {canTalk && (
            <Button
              plain
              key="talk-new"
              hotkey="o"
              label={model.talkReply === 'new' ? 'close' : 'comment'}
              onPress={() => actions.writeTalk(model.talkReply === 'new' ? '' : 'new')}
            />
          )}
          <Text dimColor>press a name to read it all</Text>
        </Box>
      )}
      {comments
        .filter(one => one.line === 0)
        .slice(-model.rows)
        .map(one =>
          one.path === '' ? (
            // A comment on the request as a whole: its mark in the comments'
            // colour, and its author's name opens it in full, with a way to
            // answer it.
            <Box flexDirection="column">
              <Box height={1} overflow="hidden">
                <Box flexShrink={0}>
                  <Text color={COMMENT_COLOR}>
                    {isInSection ? '  ' : ''}
                    {talkIcon(one)}{' '}
                  </Text>
                  <Button
                    plain
                    key={`talk-open:${one.id}`}
                    label={one.author}
                    onPress={() => actions.openTalk(model.talkOpen === one.id ? '' : one.id)}
                  />
                </Box>
                <Text dimColor={model.talkOpen === one.id} wrap="truncate-end">
                  {' '}
                  {model.talkOpen === one.id
                    ? `· ${one.when.slice(0, 10)}`
                    : `: ${one.body.replace(/\s+/g, ' ')}`}
                </Text>
              </Box>
              {/* Opened, the comment reads as it was written: the surface
                  renders its markdown where it can, and what it links to
                  that a terminal cannot show (a picture, a video, a file)
                  is listed under it, each with the site it goes to. */}
              {model.talkOpen === one.id &&
                (Markdown !== undefined ? (
                  <Box marginLeft={isInSection ? 4 : 2} flexDirection="column">
                    <Markdown text={markLinks(one.body.trim().slice(0, TALK_SHOWN), LINK_ICON)} />
                  </Box>
                ) : (
                  wrapText(one.body.trim(), Math.max(20, shell.columns - 6))
                    .slice(0, TALK_LINES)
                    .map(line => (
                      <Text wrap="truncate-end">
                        {isInSection ? '  ' : ''}
                        <Text color={COMMENT_COLOR}>┃</Text> {line === '' ? ' ' : line}
                      </Text>
                    ))
                ))}
              {model.talkOpen === one.id &&
                mediaOf(one.body)
                  .slice(0, TALK_MEDIA)
                  .map(media => (
                    <Box height={1} overflow="hidden" marginLeft={isInSection ? 4 : 2}>
                      <Text dimColor>{media.kind === 'image' ? 'picture ' : `${media.kind} `}</Text>
                      {/* `mediaOf` keeps http and https links alone; the test
                          is made here too, as the overview makes it, so the
                          link does not rest on that one place. */}
                      {Link !== undefined && /^https?:\/\//i.test(media.url) ? (
                        <Text color={COMMIT_BOX} underline>
                          <Link href={media.url}>
                            {media.label} {LINK_ICON}
                          </Link>
                        </Text>
                      ) : (
                        <Text>{media.label}</Text>
                      )}
                      <Text dimColor> → {hostOf(media.url)}</Text>
                    </Box>
                  ))}
              {model.talkOpen === one.id && canTalk && (
                <Box columnGap={2} marginLeft={isInSection ? 4 : 2}>
                  <Button
                    plain
                    key={`talk-quote:${one.id}`}
                    label="quote reply"
                    onPress={() => actions.writeTalk(one.id)}
                  />
                  <Button plain key={`talk-close:${one.id}`} label="close" onPress={() => actions.openTalk('')} />
                </Box>
              )}
            </Box>
          ) : (
            // A comment on a file names it, and the name opens the file.
            <Box height={1} overflow="hidden">
              <Box flexShrink={0}>
                <Text color={talkColor(one)}>
                  {isInSection ? '  ' : ''}
                  {talkIcon(one)}{' '}
                </Text>
                <Button
                  plain
                  key={`talk-file:${one.id}`}
                  label={one.path}
                  onPress={() => actions.open(one.path)}
                />
              </Box>
              {/* A ledger finding with no line is on its file as a whole; a
                  request's comment with none has lost its line to an edit. */}
              <Text color={talkColor(one)} wrap="truncate-end">
                {' '}
                ({isOnWholeFile(one) ? 'whole file' : one.oldLine !== undefined ? 'removed line' : 'outdated'}) · {said(one)}
              </Text>
            </Box>
          ),
        )}
      {/* The box a comment on the request as a whole is typed in: a new one,
          or an answer that starts by quoting the comment it answers. It sits
          under the conversation, where the next thing said will go. Nothing
          is sent until Enter or its button. */}
      {canTalk && Input !== undefined && model.talkReply !== '' && (
        <Box flexDirection="column" borderStyle="round" borderColor={COMMENT_COLOR} paddingX={1}>
          {quoted !== undefined && (
            <Text dimColor wrap="truncate-end">
              &gt; {quoted.author}: {quoted.body.replace(/\s+/g, ' ')}
            </Text>
          )}
          <Input
            key={`talk-text:${model.talkRound}:${model.talkReply}`}
            label={quoted === undefined ? 'comment' : 'reply'}
            placeholder={
              quoted === undefined
                ? 'a comment on the request as a whole'
                : `your answer to ${quoted.author}; their comment is quoted above it`
            }
            submitLabel="post"
            autoFocus
            onInput={actions.typeTalk}
            onSubmit={value => actions.postTalk(value)}
          />
          <Box columnGap={2}>
            <Button key="talk-post" variant="primary" label="post" onPress={() => actions.postTalk()} />
            <Button key="talk-cancel" label="cancel" onPress={() => actions.writeTalk('')} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
