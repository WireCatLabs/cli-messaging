import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { toMarkdown } from "./markdown.js"

const message = (id: string, minutes: number, changes: Partial<Message> = {}): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 8, 29, 23, 58) + minutes * 60_000).toISOString(),
  editedAt: null,
  text: `text ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...changes,
})

describe("a chat as Markdown", () => {
  it("**a heading per day, a line per message, replies quoted — from the export when only the id came**", () => {
    const markdown = toMarkdown(
      "Book club",
      [
        message("1", 0),
        message("2", 1, { senderName: null, outgoing: true, editedAt: "2026-09-30T00:00:00.000Z" }),
        message("3", 3, { replyToId: "1", text: "yes" }),
        message("4", 4, { replyToId: "99", text: "which?" }),
      ],
      "UTC",
    )

    expect(markdown).toBe(
      [
        "# Book club",
        "",
        "## 2026-09-29",
        "",
        "**23:58 Olga**",
        "> text 1",
        "",
        "**23:59 you** · edited",
        "> text 2",
        "",
        "## 2026-09-30",
        "",
        "**00:01 Olga**",
        "> **Olga:** text 1",
        "> yes",
        "",
        "**00:02 Olga**",
        "> in reply to message 99",
        "> which?",
        "",
      ].join("\n"),
    )
  })

  it("quotes a forward, links attachments, and shows control characters instead of obeying them", () => {
    const markdown = toMarkdown(
      "A\nchat",
      [
        message("1", 0, {
          text: "red\u001b[31m",
          forwardedFrom: {
            id: "5",
            senderId: "3",
            senderName: "Ivan",
            timestamp: null,
            text: "news",
            attachments: [{ kind: "photo" }],
            outgoing: false,
          },
          attachments: [
            { kind: "file", name: "a.pdf" },
            { kind: "share", title: "Site", url: "https://example.com" },
          ],
        }),
      ],
      "UTC",
    )

    expect(markdown).not.toContain("\u001b")
    expect(markdown).toContain("# A\\\\x0achat\n")
    expect(markdown).toContain("> forwarded from **Ivan**\n> news\n> - photo")
    expect(markdown).toContain("- file: a\\.pdf\n- [Site](https://example.com/)")
  })

  it("quotes foreign text and escapes sender/attachment structure so it cannot forge an export turn", () => {
    const markdown = toMarkdown(
      "# forged heading",
      [
        message("1", 0, {
          senderName: "**owner** <script>",
          text: "hello\n\n## another day\n**12:00 you**\n<script>bad()</script>",
          attachments: [{ kind: "share", title: "] forged [link", url: "https://example.test/a)" }],
        }),
      ],
      "UTC",
    )
    expect(markdown.split("\n").filter((line) => /^## /.test(line))).toEqual(["## 2026-09-29"])
    expect(markdown).not.toContain("<script>")
    expect(markdown).toContain("> \\#\\# another day")
    expect(markdown).toContain("https://example.test/a%29")
    expect(markdown).not.toContain("\n**12:00 you**")
  })

  it("lists a bot's buttons with their numbers", () => {
    const keyboard = {
      kind: "inline_keyboard",
      buttons: [[{ kind: "callback" as const, text: "Yes" }], [{ kind: "callback" as const, text: "No" }]],
    }
    expect(toMarkdown("Bot", [message("1", 0, { attachments: [keyboard] })])).toContain("- buttons: 1 Yes · 2 No")
  })
})
