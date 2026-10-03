import { readFileSync } from "node:fs"
import type { Chat, Message } from "../domain/models.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export interface SearchRecipes {
  chats: Pick<Chat, "id" | "title" | "kind">[]
  messages: Pick<Message, "id" | "chatId" | "text" | "timestamp" | "senderId" | "senderName">[]
  recipes: { title: string; query: string; ids: string[] }[]
  negative: { query: string; code: string; reason: string }[]
}
export const searchRecipes: SearchRecipes = JSON.parse(
  readFileSync(new URL("../../docs/search/recipes.json", import.meta.url), "utf8"),
)
export const seedSearchRecipes = async (store: MessageStore, account: AccountKey): Promise<void> => {
  await store.saveChats(
    account,
    searchRecipes.chats.map((chat) => ({ ...chat, unreadCount: 0, lastMessageAt: null, participantsCount: null })),
  )
  for (const { id } of searchRecipes.chats) {
    await store.saveMessages(
      account,
      id,
      searchRecipes.messages
        .filter(({ chatId }) => chatId === id)
        .map((row) => ({
          editedAt: null,
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
          ...row,
        })),
      { via: "history" },
    )
  }
}
