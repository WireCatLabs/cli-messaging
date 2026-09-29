import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { CliError, resolvePaths } from "@leemour/cli-core"
import type { AppIdentity } from "../cli/app.js"
import { storePath } from "../store/path.js"

export type UploadKind = "photo" | "file"

/** A file read for sending. Its name goes to the messenger and never to the journal. */
export interface Upload {
  kind: UploadKind
  name: string
  bytes: Uint8Array
}

const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp"])

/**
 * A file somebody talked an agent into sending would be a key or a token: those live in hidden
 * files and folders, `~/.ssh` among them, in the CLI's own folders — the session is there — and in
 * the message store (max-cli `NEED-274`). The real path is checked as well as the typed one, so a
 * link does not hide where it points.
 */
const refusedPlace = (path: string, app: AppIdentity, env: NodeJS.ProcessEnv): boolean => {
  const own = [
    ...Object.values(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })),
    dirname(storePath(env)),
  ]
  let real = resolve(path)
  try {
    real = realpathSync(path)
  } catch {}
  return [resolve(path), real].some(
    (candidate) =>
      candidate.split(sep).some((part) => part.startsWith(".") && part !== "." && part !== "..") ||
      own.some((dir) => inside(candidate, dir)),
  )
}

const inside = (path: string, dir: string): boolean => {
  const way = relative(resolve(dir), path)
  return way === "" || (!way.startsWith("..") && !isAbsolute(way))
}

export const readUpload = async (
  kind: UploadKind,
  path: string,
  { app, env = process.env, anyFile = false }: { app: AppIdentity; env?: NodeJS.ProcessEnv; anyFile?: boolean },
): Promise<Upload> => {
  if (kind === "photo" && !PHOTO.has(extname(path).toLowerCase())) {
    throw new CliError("validation_error", `a photo is a .jpg, .png or .webp — send ${path} as a file instead`)
  }
  if (!anyFile && refusedPlace(path, app, env)) {
    throw new CliError(
      "validation_error",
      `cannot send ${path}: hidden files and folders, ~/.ssh, ${app.command}'s own folders and the message store ` +
        `are not sent — the owner adds --allow-any-file to \`${app.command} messages send\` if this file is meant to go`,
    )
  }
  try {
    return { kind, name: basename(path), bytes: await readFile(path) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a folder" : "it cannot be read"
    throw new CliError("validation_error", `cannot send ${path}: ${reason}`)
  }
}
