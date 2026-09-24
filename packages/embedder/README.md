# @omgbase/embedder

Local sentence-embedding server for [omgbase](https://github.com/omgbase/omgbase), shipped as the `omgbase-embedder` binary. It runs [transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`, ONNX runtime — no Python, no native build step of your own) and serves vectors to the engine over a newline-delimited JSON protocol on stdin/stdout.

- Default model: `Xenova/gte-base`, **768** dimensions (`DEFAULT_MODEL` / `DEFAULT_DIM` in `src/index.ts`), mean-pooled and L2-normalized (unit vectors, so dot product = cosine).
- Max input: 512 tokens (gte-base's sequence limit; longer inputs are truncated by the model). Reported in the handshake so the engine can pick whole-doc vs pooled embedding from the model's real limit.
- The omgbase engine and CLI carry **no ML dependency** and never import this package: `embedding.provider` names a *process or endpoint*, and this package is the default local one.

## How omgbase uses it

```bash
npm install -g @omgbase/embedder                              # puts omgbase-embedder on PATH
omg config set embedding.provider omgbase-embedder --repo ""  # workspace layer ⇒ every repo shares one vector space
omg embed status && omg embed drain                           # queue depth / embed now
omg find "how are ids kept stable"                            # hybrid FTS ⊕ vector (RRF)
omg q 'from blocks order by semantic("crash safety") desc' -n 5
```

`omg init` offers to set this automatically when `omgbase-embedder` is already on `PATH` (`--yes` accepts, `--embedder <cmd|url>` sets any provider verbatim, `--no-embedder` skips). Without a provider, semantic ranking simply reports `semantic_unavailable` and everything else works. A provider that *is* configured but fails to spawn or handshake is a loud `embedder_failed` — never a silent downgrade.

The provider value is either a shell command (split on whitespace, spawned, spoken to over stdio) or an `http(s)://` URL. It is **not** a package name to `import` — the stale "package exporting `createProvider`" wording in `packages/core/src/search/provider.ts` comments and `docs/graph-and-query.md` §6 predates `search/external.ts`, which is the code that actually runs.

## The stdio protocol

Both sides are small: `src/bin.ts` here, `connectStdio()` in `packages/core/src/search/external.ts` in core. stdout carries **only** protocol JSON, one object per line; all logs go to stderr (core pipes the child's stderr through to its own).

1. **Handshake** — the embedder writes exactly one line on startup, before any request:
   ```json
   {"model":"Xenova/gte-base","dim":768,"maxInputTokens":512}
   ```
   Core reads `model`, `dim` and (optionally) `maxInputTokens` from it; whatever the handshake reports **wins** over `embedding.model` / `embedding.dim` / `embedding.maxInputTokens` in repo settings, which are only fallbacks for an embedder whose handshake omits them. A non-JSON first line is a hard `invalid handshake` error.
2. **Request** — core writes `{"id":<n>,"texts":["…","…"]}` with a monotonically increasing `id` (an empty `texts` array never reaches the process; core short-circuits it).
3. **Response** — `{"id":<n>,"vectors":[[…768 numbers…],…]}`, one vector per input text, or `{"id":<n>,"error":"<message>"}` if the model load or inference threw. Core matches responses by `id` (tolerating interleaving) and turns an `error` into a thrown `embedder error: …`.
4. **Shutdown** — core ends stdin; the embedder answers anything still queued, then exits 0. If it lingers, core sends SIGTERM and after 2 s SIGKILL.

Requests are processed strictly in order through one promise chain, and the (slow) first model load is single-flighted so concurrent requests share it. Constructing the provider is cheap; weights load lazily on the first `embed()`.

## Configuration (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `OMGBASE_EMBEDDER_MODEL` | `Xenova/gte-base` | transformers.js model id to load |
| `OMGBASE_EMBEDDER_DIM` | `768` | dimension reported in the handshake (must match the model) |
| `OMGBASE_EMBEDDER_MAX_TOKENS` | `512` | `maxInputTokens` reported in the handshake |

Note that `embedding.model` / `embedding.dim` in omgbase settings are **not** forwarded to the spawned process — to change the model, set these env vars where the engine runs (e.g. `OMGBASE_EMBEDDER_MODEL=Xenova/bge-small-en-v1.5 OMGBASE_EMBEDDER_DIM=384 omg embed drain`), then `omg embed drain --prune` to drop vectors left by the previous model.

## First run: model download and cache

The package does not set any transformers.js cache options, so the library defaults apply: on the first `embed()` the model files (`config.json`, `tokenizer*.json`, `onnx/model.onnx`) are fetched from the Hugging Face Hub into `env.cacheDir`, which for `@huggingface/transformers` 4.x is **`<installed package dir>/.cache/`** — i.e. inside `node_modules/@huggingface/transformers/`, not in your home directory. Expect several hundred MB for gte-base (the fp32 `model.onnx` alone is ~435 MB on disk); after that the process runs fully offline. Reinstalling or upgrading the package discards the cache and re-downloads. There is currently no env var to relocate the cache (transformers.js 4.x does not read `HF_HUB_CACHE`/`TRANSFORMERS_CACHE`); if you need one, use `createProvider()` from your own script after setting `env.cacheDir`.

### `onnxruntime-node` and install scripts

`@huggingface/transformers` depends on `onnxruntime-node`, whose `postinstall` (`node ./script/install`) fetches the native runtime binary. Under `npm --ignore-scripts`, or pnpm 10+ which blocks dependency build scripts by default, that step is skipped and the embedder fails at first load — omgbase surfaces it as `embedder_failed` naming the provider and reason. Fix: allow the script (pnpm: `allowBuilds: { onnxruntime-node: true }` in `pnpm-workspace.yaml`, as this monorepo does; or `pnpm approve-builds`) and reinstall.

## Running it standalone

The process reads newline-delimited requests until stdin closes, answers every request it received (waiting for the lazy model load if needed), and then exits 0 — so a plain pipe works:

```bash
printf '{"id":1,"texts":["the cat sat on the mat","quarterly projections"]}\n' | omgbase-embedder
# stderr: [omgbase-embedder] ready: Xenova/gte-base (768d)
# stdout: {"model":"Xenova/gte-base","dim":768,"maxInputTokens":512}
#         {"id":1,"vectors":[[-0.0241,-0.0508,-0.0098,…],[…]]}     ← two 768-d unit vectors
```

(Or drive it interactively: run `omgbase-embedder`, paste request lines, Ctrl-D to quit.) If the model is not yet cached, the first response waits on the download.

## Using a different provider

Anything that speaks the protocol above works: `omg config set embedding.provider "python my_embedder.py"`. Or point at an HTTP service, which core reaches with `fetch`:

- `GET <url>` → `{"model":"…","dim":N,"maxInputTokens":M}` (best-effort metadata handshake; settings values are the fallback).
- `POST <url>` with `{"texts":[…],"model":"…"}` → `{"vectors":[[…],…]}`.

```bash
omg config set embedding.provider https://embed.internal/embed --repo ""
```

The CLI prints an egress notice before sending block text to a remote endpoint.

## Library use

```ts
import { createProvider } from "@omgbase/embedder";
const p = createProvider();                       // or { model: "Xenova/bge-small-en-v1.5", dim: 384 }
const [v] = await p.embed(["hello world"]);       // number[] of length p.dim
```

`createProvider()` returns `{ model, dim, embed(texts) => Promise<number[][]> }` — structurally the same `EmbeddingProvider` contract `@omgbase/core` uses.

## Tests

`pnpm test` runs fast offline shape checks. The real download + inference test is env-gated so CI never fetches weights:

```bash
OMGBASE_EMBEDDER_E2E=1 pnpm test    # embeds three sentences, checks 768-d unit vectors and that cat ≈ feline > finance
```

## License

MIT — see [LICENSE](./LICENSE).
