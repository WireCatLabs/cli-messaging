import { Command } from "commander"
import { readEvidencePacket } from "../../services/evidence-read.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

export const evidenceCommand = (messenger: Messenger): Command =>
  new Command("evidence")
    .description("a bounded evidence packet from stored messages, newest first")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many, 1–100", positiveCount("--limit"))
    .option("--before-id <id>", "only messages older than this message id")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { beforeId } = this.opts<{ beforeId?: string }>()
      const packet = await context.withStore((store, account) =>
        readEvidencePacket(
          store,
          account,
          { chat, limit: context.settings.limit, ...(beforeId === undefined ? {} : { before: beforeId }) },
          messenger,
        ),
      )
      if (context.format !== "pretty") {
        context.renderer.result(packet)
        return
      }
      context.renderer.result(
        packet.items.map(({ locator, timestamp, senderName, text }) => ({ locator, timestamp, senderName, text })),
      )
      context.renderer.note(
        `${packet.coverage.included} of ${packet.coverage.provided} selected messages; history coverage unknown`,
      )
      if (packet.coverage.truncatedBy) context.renderer.note(`packet truncated by ${packet.coverage.truncatedBy}`)
      if (packet.nextBeforeId !== null) context.renderer.note(`older messages: --before-id ${packet.nextBeforeId}`)
    })
