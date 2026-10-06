import { Command } from "commander"
import { environmentOf, outputFor } from "../../dist/cli/context.js"
import { run } from "../../dist/cli/program.js"
import { readSecret } from "../../dist/terminal/prompt.js"

const app = {
  command: "fixture",
  appName: "fixture-cli",
  envPrefix: "FIXTURE",
  version: "1.0.0",
  description: "Synthetic execution checks",
}
const code = await run(process.argv.slice(2), {
  app,
  configuration: {
    resolveSettings: () => ({ profile: "default", keepFailedRuns: false, keepRunsForDays: 1, skillHint: false }),
  },
  commands: () => [
    new Command("probe").option("--mode <kind>", "synthetic operation", "wait").action(async function () {
      const environment = environmentOf(this)
      const timer = setInterval(() => {}, 1000)
      environment.trackCloseable({ close: async () => clearInterval(timer) })
      outputFor(this).renderer.result({ ready: true })
      if (this.opts().mode === "input") await readSecret("synthetic", { input: environment.stdin })
      else if (this.opts().mode === "pipe") {
        for (;;) {
          outputFor(this).renderer.result({ synthetic: "x".repeat(8192) })
          await new Promise((resolve) => setImmediate(resolve))
        }
      } else await new Promise(() => {})
    }),
  ],
})
process.exitCode = code
