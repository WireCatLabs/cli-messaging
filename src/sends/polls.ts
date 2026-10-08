import { CliError } from "@leemour/cli-core"
import type { MessengerAdapter, NewPoll, Sent } from "../cli/messenger/port.js"
import { capability } from "../cli/messenger/port.js"
import { threadIdOf } from "../cli/messenger/thread.js"
import type { Id, Poll } from "../domain/models.js"
import type { SendGuard } from "./guard.js"
import { guardedWrite, type Operated } from "./guarded.js"
import { sendAsCheck } from "./send-as.js"
import { newOperationId, newSendId } from "./send-id.js"

/** A vote is shown to the others like a reaction, and counts toward nothing. */
export const guardedVote = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, answers }: { chat: string; message: string; answers: Id[] },
): Promise<Operated<{ poll: Poll }>> => {
  const vote = capability(connection, "vote", "vote in a poll")
  const { id: chatId } = await connection.resolve(chat)
  const operationId = newOperationId()
  const poll = await guardedWrite(
    guard,
    { operationId, chatId, kind: "reaction", messageId: message, key: "polls.vote" },
    () => vote(chatId, message, answers),
  )
  return { operationId, poll }
}

/** Closing changes the owner's own message for everyone in the chat, like an edit. */
export const guardedClose = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message }: { chat: string; message: string },
): Promise<Operated<{ poll: Poll }>> => {
  const close = capability(connection, "closePoll", "close a poll")
  const { id: chatId } = await connection.resolve(chat)
  const operationId = newOperationId()
  const poll = await guardedWrite(
    guard,
    { operationId, chatId, kind: "edit", messageId: message, key: "polls.close" },
    () => close(chatId, message),
  )
  return { operationId, poll }
}

/** A new poll is a new message: the recipient list and the hourly limit apply, and a send id makes a retry safe. */
export const guardedCreatePoll = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  {
    chat,
    poll,
    silent,
    sendId,
    threadId: typedThread,
    sendAs,
  }: { chat: string; poll: NewPoll; silent: boolean; sendId?: string; threadId?: Id; sendAs?: Id },
): Promise<Operated<Sent>> => {
  if (poll.answers.length < 2) throw new CliError("validation_error", "a poll needs two answers or more")
  if (poll.quiz) {
    const { correct } = poll.quiz
    if (!Number.isInteger(correct) || correct < 0 || correct >= poll.answers.length)
      throw new CliError("validation_error", `--correct takes an answer's position, 1 to ${poll.answers.length}`)
    if (poll.multiple || poll.revote)
      throw new CliError("validation_error", "a quiz takes one final answer; not with --multiple or --revote")
  }
  const threadId = threadIdOf(typedThread)
  const validate =
    threadId === undefined ? undefined : capability(connection, "validateThread", "send to a forum topic")
  const create = capability(connection, "createPoll", "create a poll")
  const checkSendAs = sendAsCheck(connection, sendAs)
  const { id: chatId } = await connection.resolve(chat)
  await checkSendAs(chatId)
  const id = sendId ?? connection.newSendId?.() ?? newSendId()
  const sent = await guardedWrite(
    guard,
    {
      chatId,
      kind: "message",
      sendId: id,
      operationId: id,
      length: poll.question.length,
      key: "polls.create",
      ...(threadId === undefined ? {} : { threadId }),
      ...(sendAs === undefined ? {} : { sendAs }),
    },
    () =>
      create(chatId, poll, {
        sendId: id,
        ...(silent ? { silent } : {}),
        ...(threadId === undefined ? {} : { threadId }),
        ...(sendAs === undefined ? {} : { sendAs }),
      }),
    (done) => ({ messageId: done.message.id }),
    validate === undefined || threadId === undefined ? undefined : () => validate(chatId, threadId, {}),
  )
  return { ...sent, operationId: id }
}

/** `--quiz --correct <n> --solution <text>` as typed, `n` from 1; refused when they do not go together. */
export const quizOf = ({
  quiz,
  correct,
  solution,
}: {
  quiz?: boolean
  correct?: number
  solution?: string
}): NewPoll["quiz"] => {
  if (quiz !== true) {
    if (correct !== undefined || solution !== undefined)
      throw new CliError("validation_error", "--correct and --solution go with --quiz")
    return undefined
  }
  if (correct === undefined)
    throw new CliError("validation_error", "a quiz needs --correct <n>, the right answer's position")
  return { correct: correct - 1, ...(solution === undefined ? {} : { solution }) }
}
