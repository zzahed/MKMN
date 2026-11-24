# NPU model-loading research

Written on 2026-10-25 from the first test bench (`model testing.zip`, 89 models) and from the logs of the test bench and of the NPU load test. **Facts** = read in our logs or in the cited sources. **Hypotheses** = deductions, to be verified.

## 1. What our logs say

PC: Snapdragon X Plus X1P64100 (10 cores), 15,6 GB of RAM, Windows 26300.9711, NPU driver 10.0.26100.1, GenieX 0.9.3. The server is launched by the app with `--compute npu`: according to the GenieX notes, `npu` pins **the whole model on a single NPU session (HTP0)**.

| Model (file) | Window | Buffers placed on HTP0 (weights + cache + compute) | Rejected buffer |
|---|---|---|---|
| Qwen3-4B-Thinking-2507 (2,3 GB) | 16 384 | ~2,3 GB + cache 2 304 MiB + compute 780 MiB | 622 333 952 B (594 MiB), error 0x200 |
| Ministral-8B-Instruct (4,3 GB) | 2 048 (scale) | ~4,3 GB + cache 288 MiB + compute 724 MiB | 536 875 008 B (512 MiB + 8 KiB), 0x200 |
| Gemma-2-9B-it (5,1 GB) | 3 072 | ~5,1 GB + cache 2 x 504 MiB + compute 1 236 MiB | 1 057 542 144 B (1 009 MiB), 0x200 |

Facts:
- Message: `ggml-hex: HTP0 buffer mapping failed : domain_id 3 size N fd F error 0x00000200`, then `fastrpc_mmap failed`, then the API error `-100201 SDKError(Model loading failed)`.
- `n_ubatch = 1024`, `n_batch = 2048`, `flash_attn = enabled` in our launches. GenieX set `n_ubatch` to 128 under Linux to avoid exactly this kind of failure (GenieX #1503); under Windows it is not changed.
- None of the 14 settings tried (windows 8 192 to 2 048, `GGML_HEXAGON_MBUF`, `GGML_HEXAGON_DEVICES`) made a model load. The size of the rejected buffer does not depend on the window.
- After a failure, the NPU counter can stay at 2 or 3 GB while the server is stopped.
- Many failures are a **server crash** (`fetch failed`, Go panic trace), not a 500 error.
- The Windows counters work ("compute-only" adapter, 0,22 GB at rest): the memory measurements are reliable.

Sources: llama.cpp `docs/backend/snapdragon/README.md` (one NPU session: ~3,5 GB of mapping; beyond that, the weights are mapped dynamically; large models spread over several sessions), llama.cpp #26123 (a shared 4 GB address window, failures below the total budget that suggest fragmentation), x1e-npu (output tensor that cannot be split by `GGML_HEXAGON_MBUF`, a 1 GiB aligned hole is required; a failure can leave the driver in a bad state), GenieX #1531 (same error on a 1 GiB compute buffer with `n_ubatch` 1024), GenieX #1530 (a 64 MiB cap removed under Windows to run Qwen3.5-9B on X Elite).

**Main hypothesis**: it is not the size of the model that matters but what has to be mapped at the same time on the session (weights split into 1 GiB chunks, context cache, compute buffer) and the possibility of finding a **contiguous and aligned** hole for each chunk. The rejected buffer is each time a weight chunk (a remainder or the last one), which fits with mappings that accumulate until exhaustion.

## 2. What ran and what did not run (first bench, same PC)

**Ran to completion on the NPU (30 models)**, including large ones: Qwen3.5-4B, Qwen3-4B-Instruct-2507, Qwen3-8B (4,8 GB), Qwen3.5-9B (5,4 GB), Ministral-3-8B-Reasoning, Ministral-8B-Instruct-2410 (4,3 GB), GLM-4-9B-0414, MiMo-V2.6-Distill-Qwen-9B, Gemma-4-E2B-it, Gemma-3-4B-it, Gemma-3-1B-it, Qwen2.5-Coder-3B and 1.5B, Qwen2.5-1.5B, LFM2 (1.2B, 2.6B), LFM2.5 (1.2B, 2.6B, 8B-A1B), Nemotron-3-Nano-4B (NPU + CPU), Arch-Function-3B, xLAM-2-3B-fc-r, EXAONE-4.0-1.2B, DeepScaleR-1.5B, VibeThinker-3B, Qwen3-1.7B (native NPU bundle), Qwen3-4B-Thinking-2507 (partial).

**Did not load (56 models, with the only repository tried)**, by family:
- **Llama and derivatives**: Llama-3.1-8B, Llama-3.2-3B, Hermes-3-Llama-3.1-8B, Llama-3-Groq-8B-Tool-Use, Llama-xLAM-2-8B, LongWriter-Llama3.1-8B, Llama-3-8B-Finance-RAG, Dolphin3-Cyber-8B, Seed-Coder-8B (2), Yi-Coder-9B, OpenCoder-8B.
- **Gemma 2 and some Gemma 3/4**: Gemma-2-9B-it, SPPO-Iter3, Gemma-4-E4B-it, **MedGemma-4B-it**, **TranslateGemma-4B-it** (gemma3 architecture, like Gemma-3-4B-it which ran).
- **Phi / Granite / OLMo / Hunyuan / InternLM / MiniCPM / Cohere**: Phi-4-mini (2), Granite-4.0-H-Tiny, Granite-4.2-8B, Olmo-3 (2), Hunyuan (4B, 7B, MT-7B), InternLM3-8B, MiniCPM4.1-8B, MiniCPM5-2B, Aya-Expanse-8B, Tiny-Aya.
- **Others**: Apertus, EuroLLM, Salamandra, Falcon3 and Falcon-H1R, EXAONE-Deep-7.8B, SmolLM3, Nemotron-Nano-9B-v2, Nemotron-3.5-Bolt, Seed-X, TwIL, NuExtract (2).
- **Same architecture as models that ran, but failure**: Qwen2.5-7B-Instruct (and 1M), Jan-v1-4B / Jan-nano / Jan-code-4B (Qwen3 base), Qwen3-4B and Qwen3-1.7B "custom" (bartowski GGUF), Ministral-3-8B-Instruct and 3B (the Reasoning one ran).
- Qwen2.5-Coder-7B: rejected by the app (9,2 GB estimated), not tried on the NPU.

## 3. Similarities and differences

1. **Architecture alone is not decisive.** The same architectures appear on both sides (qwen3, gemma3, ministral). So runtime support for the architecture does not explain everything.
2. **The GGUF file matters.** Qwen3-1.7B as a native NPU bundle ran, the "custom" GGUF did not. Gemma-3-4B-it ran, MedGemma-4B and TranslateGemma-4B (same architecture, same size) did not. Hypothesis: the way the GGUF is built (type of the output tensor and of the embedding, `output.weight` separate or shared, mixed quantization Q4_0 + Q6_K/Q8_0, vocabulary size, weight splitting) changes the chunks to be mapped.
3. **The families that run are the ones Qualcomm and the community test the most**: Qwen2.5/3/3.5 (and derivatives), Gemma 3 (1B, 4B), Gemma-4-E2B, LFM2/2.5, Ministral 3 Reasoning, GLM-4. The families that almost all fail (Llama, Gemma-2, Phi, Granite, OLMo, Hunyuan…) have larger vocabularies, tied embeddings or unusual layers (SWA, hybrid): **to be checked in the GGUF files**.
4. **Size is not the criterion**: Qwen3.5-9B (5,4 GB) ran, Qwen3-4B-Thinking (2,3 GB) and MedGemma-4B (2,4 GB) did not. A 5,4 GB model that runs contradicts the idea of a 4 GB limit; the most likely explanation (hypothesis) is that models above about 3,5 GB have their weights mapped dynamically, whereas those of 2 to 3 GB with a large context cache remain mapped in one block.
5. **Things have changed since the first bench.** Qwen3-4B-Thinking and Qwen3.5-4B had run; they now fail on the same PC. To check: GenieX update (0.9.3?), Windows update (Insider build 26300), NPU driver update, or a larger window (16 384). **Simple test to do on the PC**: rerun Qwen3-4B-Instruct-2507 (which had run) with the NPU load test. If it also fails, it is the environment that changed, not the models.

## 4. What the app now does

- The **NPU load test** (Settings, Developer) tries 2 to 4 NPU sessions, smaller weight chunks and smaller windows, **all on NPU**, from the least restrictive to the most restrictive.
- **Hybrid mode** (part of the model on the CPU) is never used on its own. It is tried as a last resort only if the "hybrid" checkbox is ticked, in the test and in the bench. A model that loads only this way is flagged "part on the CPU".
- The setting that works is kept per model, and the app then starts that model with it.

## 5. Follow-up observations

These observations compare a Gemini research report with the benchmark logs.

Result on the user's machine: **a reboot of the PC gets everything working again, and only that.** The NPU therefore stays in a bad state after a failure (the report explains it: the DSP keeps the mappings of the dead process).

**Verified by us (arithmetic on our logs):** the rejected buffer is exactly `n_ubatch x vocabulary size x 4 bytes + 4096`, with `n_ubatch = 1024`: Qwen3 (151 936) = 622 333 952 B, Ministral (131 072) = 536 875 008 B. It is the f32 logits buffer of a micro-batch of 1024 tokens. Gemma-2 (256 000) gives 1 048 576 000 B, the log shows 1 057 542 144 (8,9 MB more, unexplained). With `n_ubatch = 128` this buffer would be 8 times smaller.

**Stated by the report, not verified:** `geniex serve` sets `n_ubatch` to 1024 with no option to change it (GenieX #1557); `GGML_HEXAGON_MBUF` and `GGML_HEXAGON_DEVICES` are not read (the variables read would be `GGML_HEXAGON_NDEV`, `NHVX`, `HOSTBUF`, `VERBOSE`, `PROFILE`, `OPMASK`), which would explain why our attempts changed nothing; an HTP session maps about 3,5 GB; GGUF files with Q6_K/Q4_K/BF16 tensors (bartowski, mradermacher, QuantFactory imatrix) are rejected by the NPU path; the Q4_0 `--pure` GGUF files, those from Google (QAT), LiquidAI and Qwen pass; hybrid mode keeps 85 to 95 % of the weights on the NPU and places the output head on the CPU.

**Applied in the app:**
- **Reset the NPU** button (Settings, Developer): stops geniex and restarts the NPU node with `pnputil /restart-device` (Windows asks for permission). Not tested on a real machine: if the models still fail afterwards, reboot the PC.
- The useless settings (`GGML_HEXAGON_MBUF`, `DEVICES`) are removed from the ladder; `GGML_HEXAGON_HOSTBUF=1` is added to it.
- A setting is kept only if the model answers a real prompt of ~1 500 tokens, and its answer is not noise.

## Evidence gaps

The report did not verify the tensor types of the failing GGUF files or every
candidate repository and ticket it cited. Its driver explanation is also
unconfirmed. The observed driver was `10.0.26100.1` (Microsoft generic), while
the report describes Qualcomm drivers as `30.0.x`.
