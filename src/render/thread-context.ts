import type { ThreadContext } from "../services/thread-context.js"

export const renderThreadLinks = ({ links }: Pick<ThreadContext, "links">): string =>
  links
    .map(
      (link) =>
        `${link.messageId} ← ${link.parentId ?? "start"}  ${link.source}/${link.kind} · confidence ${link.confidence} · ${link.method}${link.stale ? " · stale" : ""}`,
    )
    .join("\n")
