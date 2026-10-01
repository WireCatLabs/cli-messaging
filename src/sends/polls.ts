import { CliError } from "@leemour/cli-core"
import type { MessengerAdapter, NewPoll, Sent } from "../cli/messenger/port.js"
import { capability } from "../cli/messenger/port.js"
import type { Id, Poll } from "../domain/models.js"
import type { SendGuard } from "./guard.js"
import { guardedWrite, type Operated } from "./guarded.js"
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
  { chat, poll, silent, sendId }: { chat: string; poll: NewPoll; silent: boolean; sendId?: string },
): Promise<Operated<Sent>> => {
  if (poll.answers.length < 2) throw new CliError("validation_error", "a poll needs two answers or more")
  const create = capability(connection, "createPoll", "create a poll")
  const { id: chatId } = await connection.resolve(chat)
  const id = sendId ?? connection.newSendId?.() ?? newSendId()
  const sent = await guardedWrite(
    guard,
    { chatId, kind: "message", sendId: id, operationId: id, length: poll.question.length, key: "polls.create" },
    () => create(chatId, poll, { sendId: id, ...(silent ? { silent } : {}) }),
    (done) => ({ messageId: done.message.id }),
  )
  return { ...sent, operationId: id }
}
