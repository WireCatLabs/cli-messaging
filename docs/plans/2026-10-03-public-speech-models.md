# Public speech-model helpers

Status: refinement of MAX's approved shared-service migration. Existing helpers are implemented
under `src/speech/install.ts` and `src/speech/models.ts`, but no package export exposes them.
MAX's local installer and model catalogue duplicate these files.

Add an additive `./speech` entry for catalogue/types/order and verified installation/path helpers.
Keep the recognizer internal so importing this entry does not load native/WebAssembly engines.
Do not alter model URLs, hashes, sizes, configuration or the shared directory layout. MAX keeps
its language ordering and chosen setting at its consumer edge.

Validate existing integrity/reuse tests through the public source entry, explicit common-cache
override, built package self-import under Node/Bun, lint/typecheck/coverage/docs/build. Publish
before MAX pins the entry; when the consumer is blocked, use the documented release exception.
No large model downloads or live messenger calls.
