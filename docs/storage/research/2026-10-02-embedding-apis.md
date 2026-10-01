# Hosted embedding APIs — from their own documentation

2026-10-02, for [phase 5](../plans/phase-5.md) E11, after the owner asked for an external model with the
user's own key. Every fact is from the provider's official page, linked below, read on 2026-10-02 through
a fetch tool that summarises pages (not the raw HTML). "Not stated" means the page read did not say it.
Three facts come only from search snippets and are marked **unverified**. No API was called.

| | OpenAI | Gemini | Cohere | Voyage | Mistral | Jina |
|---|---|---|---|---|---|---|
| models | text-embedding-3-small, -3-large, ada-002 | gemini-embedding-2 (preview), gemini-embedding-001 | embed-v5.0-pro, -fast, v4.0, multilingual-v3 | voyage-4-large, -4, -4-lite | mistral-embed | v5-text-small, v5-text-nano |
| default dims | 1536 / 3072 | up to 3072 | 2048 (v5), 1536 (v4) | 1024 | 1024 | 1024 / 768 |
| shorter vectors | `dimensions` (v3) | 128–3072 | `output_dimension` 256–2048 | `output_dimension` 256/512/2048 | `output_dimension` (values not stated) | down to 32 |
| tokens per text | 8,192 | 8,192 (v2) / 2,048 (001) | 128k (v4/v5), 512 (v3) | 32,000 | 8k | 32k / 8k |
| inputs per request | 2,048 | not stated (100 **unverified**) | 96 | 1,000 | not stated | "no hard limit" |
| tokens per request | 300,000 | not stated | not stated | 120k / 320k / 1M | not stated | not stated |
| price per 1M tokens | $0.02 / $0.13 / $0.10 | $0.20 (v2, paid) | $0.12 / $0.08 **unverified** | $0.12 / $0.06 / $0.02; first 200M free | $0.10 | ~$0.05 **unverified**; 10M free |
| batch discount | no embeddings row | $0.10 | not stated | 33% | half | none |
| lowest paid tier | 3,000 req/min, 1M tokens/min (3-small) | in AI Studio only | 2,000 inputs/min | 2,000 req/min; 3M/8M/16M tokens/min | in the admin panel only | 500 req/min, 2M tokens/min |
| Russian | not stated | "over 100 languages" | named (multilingual v3) | "multilingual" (blog only) | not stated | 119+ (model card) |
| query / document input | no | `task_type` (001 only) | `input_type` | `input_type` | no | `task` |
| OpenAI request shape | native | yes, own base URL | compatibility layer, without `dimensions` and `input_type` | nearly: `output_dimension` | nearly: `output_dimension` | yes |
| trains on API inputs by default | no | free tier yes, paid no | paying: no, with opt-out; trial: privacy policy | **yes**, unless an admin opts out | free mode may; paid no | never |

Gemini prices dated 2026-10-01, Voyage 2026-09-29; the other pages show no date.

**Local servers.** [Ollama](https://docs.ollama.com/api/openai-compatibility) (`http://localhost:11434/v1/`,
accepts `dimensions`) and [LM Studio](https://lmstudio.ai/docs/developer/openai-compat)
(`http://localhost:1234/v1`) both serve an OpenAI-shaped `/v1/embeddings`.

**Vectors from different models do not mix.** "The embedding spaces between gemini-embedding-001 and
gemini-embedding-2 are incompatible" ([Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings));
Voyage's 4-series is the one documented exception, "compatible with each other"
([Voyage embeddings](https://docs.voyageai.com/docs/embeddings)). So a vector carries its provider, model
and size, and a change of any of them means embedding again.

## Sources

- **OpenAI**: [embeddings guide](https://developers.openai.com/api/docs/guides/embeddings) (models, dims,
  `dimensions`, 8,192 tokens); [create embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
  (2,048 inputs, 300k tokens); [pricing](https://developers.openai.com/api/docs/pricing);
  [text-embedding-3-small](https://developers.openai.com/api/docs/models/text-embedding-3-small) (Tier 1
  limits); [rate limits](https://developers.openai.com/api/docs/guides/rate-limits);
  [your data](https://developers.openai.com/api/docs/guides/your-data) (no training by default; 30-day
  abuse-monitoring logs).
- **Gemini**: [embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings) (updated 2026-09-17);
  [pricing](https://ai.google.dev/gemini-api/docs/pricing); [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits);
  [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) (base URL
  `https://generativelanguage.googleapis.com/v1beta/openai/`); [terms](https://ai.google.dev/gemini-api/terms);
  [API reference](https://ai.google.dev/api/embeddings) (no batch size stated).
- **Cohere**: [embed reference](https://docs.cohere.com/reference/embed) (96 texts, `input_type`,
  `output_dimension`); [embed models](https://docs.cohere.com/docs/cohere-embed);
  [rate limits](https://docs.cohere.com/docs/rate-limits); [compatibility API](https://docs.cohere.com/docs/compatibility-api);
  [data usage](https://cohere.com/data-usage-policy); [pricing](https://cohere.com/pricing) showed no token
  prices when read.
- **Voyage**: [embeddings](https://docs.voyageai.com/docs/embeddings); [API reference](https://docs.voyageai.com/reference/embeddings-api);
  [pricing](https://docs.voyageai.com/docs/pricing); [rate limits](https://docs.voyageai.com/docs/rate-limits);
  [FAQ](https://docs.voyageai.com/docs/faq) (training and the opt-out); "multilingual" only in the
  [Voyage 4 post](https://blog.voyageai.com/2026/01/15/voyage-4/).
- **Mistral**: [text embeddings](https://docs.mistral.ai/studio/knowledge-rag/embeddings/text_embeddings);
  [API reference](https://docs.mistral.ai/api/endpoint/embeddings); [mistral-embed](https://docs.mistral.ai/models/mistral-embed-23-12);
  [pricing](https://mistral.ai/pricing/api); [limits](https://docs.mistral.ai/admin/user-management-finops/tier);
  [training](https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models).
- **Jina**: [embeddings](https://jina.ai/embeddings/); [rate limits](https://jina.ai/api-dashboard/rate-limit);
  [model card](https://huggingface.co/jinaai/jina-embeddings-v5-text-small) (119+ languages).
