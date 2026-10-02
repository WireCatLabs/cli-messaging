import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { guardedClose, guardedCreatePoll, guardedVote } from "../../sends/polls.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"
import { threadIdOf } from "./thread.js"

/**
 * `polls show|vote|close|create`. An answer is named by its id, as `polls show` prints it — never by
 * position, which changes nothing for a person and everything for a vote.
 */
export const pollsCommand = (messenger: Messenger): Command => {
  const polls = new Command("polls").description("read a poll, vote in it, close your own, create one")

  polls
    .command("show")
    .description("a poll and its answer ids, as the message carries it now")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the message that carries the poll")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger(async (connection) => {
          const poll = capability(connection, "poll", "read a poll")
          return poll((await connection.resolve(chat)).id, message.trim())
        }),
      )
    })

  annotate(polls.command("vote"), { mutates: true })
    .description("vote in a poll, or take your vote back; the others see it unless the poll is anonymous")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the message that carries the poll")
    .argument("[answers...]", "answer ids, as `polls show` prints them")
    .option("--retract", "take your vote back")
    .action(async function (this: Command, chat: string, message: string, answers: string[]) {
      const context = messengerContext(this, messenger)
      const { retract } = this.opts<{ retract?: boolean }>()
      if (retract && answers.length > 0) {
        throw new CliError("validation_error", "`--retract` takes no answers: it removes the vote you have")
      }
      if (!retract && answers.length === 0) {
        throw new CliError(
          "validation_error",
          "name at least one answer id (`polls show` prints them), or pass --retract",
        )
      }
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedVote(context.guard, connection, {
            chat,
            message: message.trim(),
            answers: answers.map((a) => a.trim()),
          }),
        ),
      )
    })

  annotate(polls.command("close"), { mutates: true })
    .description("close your own poll; nobody can vote after that, and it cannot be reopened")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of your own message that carries the poll")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedClose(context.guard, connection, { chat, message: message.trim() }),
        ),
      )
    })

  annotate(polls.command("create"), { mutates: true })
    .description("send a poll to a chat, as a message of its own; public unless --anonymous")
    .argument("<chat>", messenger.chatArgument)
    .argument("<question>", "the question")
    .argument("<answers...>", "two answers or more")
    .option("--topic <id>", "send to this forum topic; unsupported by messengers without topics")
    .option("--multiple", "people may pick several answers")
    .option("--anonymous", "nobody sees who voted for what")
    .option("--revote", "people may change their vote")
    .option("--silent", "send without a notification")
    .option("--send-id <id>", "repeat a create whose outcome was unknown, without risking a second poll")
    .action(async function (this: Command, chat: string, question: string, answers: string[]) {
      const context = messengerContext(this, messenger)
      const { multiple, anonymous, revote, silent, sendId, topic } = this.opts<{
        topic?: string
        multiple?: boolean
        anonymous?: boolean
        revote?: boolean
        silent?: boolean
        sendId?: string
      }>()
      const threadId = threadIdOf(topic)
      const sent = await context.withMessenger((connection) =>
        guardedCreatePoll(context.guard, connection, {
          chat,
          ...(threadId === undefined ? {} : { threadId }),
          poll: {
            question,
            answers,
            multiple: multiple === true,
            anonymous: anonymous === true,
            revote: revote === true,
          },
          silent: silent === true,
          ...(sendId === undefined ? {} : { sendId }),
        }),
      )
      context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message })
    })

  return polls
}
