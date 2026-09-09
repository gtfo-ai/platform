# TD-009 — Embedding provider port; default local Qwen3-Embedding-0.6B via transformers.js (phase 2)

- **Status:** proposed (phase 2; benchmark required)
- **Date:** 2026-08-28
- **Relates to:** research/07, technical/07, BD-012, BD-029

## Decision
`EmbeddingProvider { embed(texts, kind), dims, modelId, version }` with implementations: local in-process transformers.js (`@huggingface/transformers` 4.x, ONNX Runtime CPU) with **Qwen3-Embedding-0.6B int8 (Apache-2.0, 1024 dims, multilingual)** as default, Ollama sidecar, Voyage API (voyage-4 family; `voyage-4-nano` shares the space). Weights downloaded to a named volume on first use, never baked into the image. EmbeddingGemma is not the default (Gemma Terms licence).

## Consequences
- Phase-2 spike must benchmark chunks/s on 4 vCPU and image/volume size before enabling by default.
- Index rows record model id and dims; switching triggers a rebuild.
