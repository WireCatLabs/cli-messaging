import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { renderList } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

const collect = (value: string, previous: string[] = []) => [...previous, value]

/** `chats folders …`, in max-cli's words. */
export const foldersCommand = (messenger: Messenger): Command => {
  const folders = new Command("folders").description("your chat folders")
  folders
    .command("list")
    .description("your chat folders, in the order the app shows them")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      renderList(context.renderer, context.format, await context.withServices((services) => services.folders.list()))
    })
  folders.addCommand(
    annotate(new Command("create"), { mutates: true })
      .description("create a chat folder")
      .argument("<title>", "the folder's name; the app may refuse a long one")
      .option("--chat <chat>", "a chat to put in it, by id or name; repeat it for more", collect)
      .action(async function (this: Command, title: string) {
        const context = messengerContext(this, messenger)
        const { chat = [] } = this.opts<{ chat?: string[] }>()
        context.renderer.result(await context.withServices((services) => services.folders.create(title, chat)))
      }),
  )
  folders.addCommand(
    annotate(new Command("update"), { mutates: true })
      .description("rename a folder, or change which chats are in it")
      .argument("<folder>", "folder id, or its title exactly")
      .option("--title <title>", "a new name")
      .option("--add <chat>", "put a chat in it; repeat it for more", collect)
      .option("--remove <chat>", "take a chat out of it; repeat it for more", collect)
      .action(async function (this: Command, folder: string) {
        const context = messengerContext(this, messenger)
        const edit = this.opts<{ title?: string; add?: string[]; remove?: string[] }>()
        context.renderer.result(await context.withServices((services) => services.folders.update(folder, edit)))
      }),
  )
  folders.addCommand(
    annotate(new Command("delete"), { mutates: true })
      .description("delete a folder; the chats in it stay")
      .argument("<folder>", "folder id, or its title exactly")
      .action(async function (this: Command, folder: string) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.folders.delete(folder)))
      }),
  )
  return folders
}
