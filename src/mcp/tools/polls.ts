import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { guardedClose, guardedCreatePoll, guardedVote } from "../../sends/polls.js"
import { type AnyTool, chatOf, message, READ, tool, WRITE } from "../tool.js"

const answerId = v.pipe(v.string(), v.minLength(1), v.description("an answer id, as polls_show gives it"))

export const pollReadTools = (messenger: Messenger): Record<string, AnyTool> => ({
  polls_show: tool({
    title: "Show a poll",
    description: "A poll as the message carries it now: its question, and each answer with the id a vote names.",
    input: v.object({ chat: chatOf(messenger), message }),
    annotations: { ...READ, idempotentHint: true },
    online: async (adapter, args) => {
      const poll = capability(adapter, "poll", "read a poll")
      return poll((await adapter.resolve(args.chat)).id, args.message)
    },
  }),
})

/** Offered with `--allow-send`, each under the permission its guard kind names. */
export const pollWriteTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  return {
    polls_vote: tool({
      title: "Vote in a poll",
      description:
        "Vote as the owner, by answer ids from polls_show; an empty list takes the vote back. The others see it " +
        "unless the poll is anonymous. Only when the owner asked for this vote.",
      input: v.object({ chat, message, answers: v.array(answerId) }),
      annotations: WRITE,
      permission: "reaction",
      online: (adapter, args, { guard }) =>
        guardedVote(guard, adapter, { chat: args.chat, message: args.message, answers: args.answers }),
    }),
    polls_close: tool({
      title: "Close a poll",
      description: "Close the owner's own poll; it cannot be reopened. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      permission: "edit",
      online: (adapter, args, { guard }) => guardedClose(guard, adapter, { chat: args.chat, message: args.message }),
    }),
    polls_create: tool({
      title: "Create a poll",
      description:
        "Send a poll as the owner: public unless anonymous is true. Only when the owner asked for this exact poll " +
        "in this exact chat. On outcome_unknown, retry with the send_id it returns, never a new one.",
      input: v.object({
        chat,
        text: v.pipe(v.string(), v.minLength(1), v.description("the question")),
        answers: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(2)),
        multiple: v.optional(v.boolean()),
        anonymous: v.optional(v.boolean()),
        revote: v.optional(v.pipe(v.boolean(), v.description("people may change their vote; without it they cannot"))),
        topic: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("the forum topic id; unsupported without topics")),
        ),
        send_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
      }),
      annotations: WRITE,
      permission: "send",
      online: async (adapter, args, { guard }) => {
        const sent = await guardedCreatePoll(guard, adapter, {
          chat: args.chat,
          poll: {
            question: args.text,
            answers: args.answers,
            multiple: args.multiple === true,
            anonymous: args.anonymous === true,
            revote: args.revote === true,
          },
          silent: false,
          ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          ...(args.topic === undefined ? {} : { threadId: args.topic }),
        })
        return { sendId: sent.sendId, operationId: sent.operationId, message: sent.message }
      },
    }),
  }
}
