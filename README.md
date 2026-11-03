# NomadGuard AI Creative Operator

A small TypeScript CLI that turns a marketing brief into a 10-15 second, 9:16 social ad:

```
Brief -> Strategy (3+ angles, 1 selected) -> Storyboard -> Prompt builder
      -> Video provider -> Assembly (ffmpeg) -> Technical QA -> Creative QA (Gemini vision) -> final.mp4
```

Brand and brief: fictional NomadGuard travel protection ([`briefs/`](briefs/)).

## Final video

[`submission/final.mp4`](https://github.com/brainard23/nomadguard-creative-operator/blob/main/submission/final.mp4) is the submitted advertisement: 14s, 1080x1920 (9:16), H.264 + AAC. Clips were made with Veo 3.1 in Google Flow, then assembled and checked by this pipeline (technical QA valid; creative QA scores in [`submission/qa.json`](submission/qa.json): realism 9, consistency 8, brief adherence 9, hook 8, ad quality 9). The raw Flow clips are in [`submission/clips/`](submission/clips/) ([s1](https://github.com/brainard23/nomadguard-creative-operator/blob/main/submission/clips/s1.mp4), [s2](https://github.com/brainard23/nomadguard-creative-operator/blob/main/submission/clips/s2.mp4), [s3](https://github.com/brainard23/nomadguard-creative-operator/blob/main/submission/clips/s3.mp4)). See "Providers" for why the clips are made by hand.

## Setup

Requires Node >= 24, pnpm and ffmpeg (`brew install ffmpeg`).

```bash
pnpm install
cp .env.example .env     # set GEMINI_API_KEY (free key from https://aistudio.google.com/apikey)
pnpm test && pnpm typecheck
```

## Run

```bash
# Offline, no keys, no network: fake LLM fixtures + ffmpeg-rendered mock clips
pnpm start run --provider mock --llm fake            # -> runs/<id>/final.mp4 + qa.json

# Real planning with Gemini, real video made by hand in Google Flow (free path)
pnpm start run --provider manual                     # plans, writes prompts, pauses (exit 0)
#   runs/<id>/inbox/<sceneId>.prompt.md  -> paste into Flow (Veo 3.1, 9:16), save as inbox/<sceneId>.mp4
pnpm start resume <runId> --provider manual          # imports clips, assembles, QA, finalizes

pnpm start status [runId]                            # state, per-shot progress, errors, artifacts
pnpm start resume <runId> --redo s2                  # regenerate/re-import one shot, reassemble, rerun QA
pnpm start resume <runId> --reassemble               # after editing storyboard.json (overlay / trimStart)
pnpm start run --plan-only                           # strategy + storyboard + prompts only
```

Each run lives in `runs/<runId>/`: `job.json` (state), `brief.json`, `strategy.json`, `storyboard.json`, `prompts.json`, `clips/`, `final.mp4`, `qa.json`.

## Architecture

- `src/creative/` strategist, storyboard writer (+ normalizer that snaps scene durations to 10-15s total) and a pure Veo prompt builder. All LLM output is zod-validated with one repair retry.
- `src/llm/` `LlmClient` interface (`generateJson`, `generateJsonFromImages`). Gemini via an AI Studio key or Vertex; a fake client with fixtures for offline tests. Transient errors (429/503/network) retry with backoff, separately from the JSON repair retry.
- `src/video/` `VideoProvider { generate, getStatus, getResult }`. Implementations: `manual`, `mock`, `veo`. The workflow never imports a concrete provider.
- `src/pipeline/` stages (planning, generation, assembly, qa) run by a small runner. Each stage knows if its output exists, so `resume` skips finished work.
- `src/jobs/` file-based job store. Lifecycle: `CREATED -> PLANNING -> PLANNED -> GENERATING (or AWAITING_CLIPS) -> ASSEMBLING -> EVALUATING -> FINALIZED | NEEDS_REVIEW | FAILED`.
- `src/assembly/`, `src/qa/` ffmpeg assembly (trim, normalise, silent audio, end card, notification overlay) and QA.

## Providers

| Provider | Use | Notes |
| --- | --- | --- |
| `manual` | **Used for the submitted video** | Writes a paste-ready prompt per shot, waits for `inbox/<sceneId>.mp4`, validates with ffprobe, imports. |
| `veo` | Production path | Veo 3.1 on Vertex AI (`GOOGLE_CLOUD_PROJECT`, ADC, billing). Implemented and unit-tested against a fake client, not exercised live. |
| `mock` | Tests / demo | Renders real ffmpeg clips offline. |

LLM: Gemini (`gemini-3.8-flash`, `GEMINI_MODEL` overrides) through `@google/genai`. With no `GEMINI_API_KEY` it falls back to Vertex AI.

## Reliability and QA

- Jobs persist after every step. A failed shot records its error and retryability and does not stop the other shots. `resume` re-polls submitted shots instead of resubmitting.
- Transient provider errors retry with exponential backoff; permanent ones (safety filter, corrupt file) fail only that shot with a message naming it.
- Ctrl-C saves state; any unexpected error is persisted as `FAILED` with the stage and message.
- **Technical QA**: exists, decodes cleanly, duration 10-15s, 1080x1920, 9:16.
- **Creative QA**: 6 frames (one in the hook window, one in the last scene) go to Gemini vision with the brief, angle and storyboard. It scores realism, visual consistency, brief adherence, hook strength and advertising quality (1-10, with notes) and names the weakest scene. Pass = average >= 7 and no score < 5 (`CREATIVE_QA_MIN_AVG`, `CREATIVE_QA_MIN_SCORE`), else `NEEDS_REVIEW` with reasons. If the vision call itself fails the run goes to `NEEDS_REVIEW`, never silently `FINALIZED`.

## Key decisions and trade-offs

- **CLI, not a UI**: the brief said a UI is optional; time went into reliability and QA.
- **Manual video provider as the delivered path**: no practical free video API. The provider interface is real and Veo is implemented, but the shipped clips come from Flow, so the manual provider turns that human step into a resumable, validated workflow instead of a script.
- **One consistent style guide repeated in every prompt** (character, wardrobe, setting, grade) to fight identity drift between independently generated clips.
- **Notification UI is composited in post** (ffmpeg overlay), because video models cannot render legible UI text. The same goes for the end card.
- **Filesystem job store**: simple and inspectable; no queue or database.
- **Creative QA is advisory-strict**: a vision model is a noisy judge, so low scores route to human review rather than auto-failing.

## Tests

`pnpm test` runs 160+ tests, all offline (real ffmpeg, no network). The highest-risk ones:

- `tests/resilience.test.ts` retries, resume without resubmitting, failure isolation per shot.
- `tests/manualProvider.test.ts` the full pause / drop clips / resume flow, garbage clip handling, clips of different length or without audio.
- `tests/creativeQaPipeline.test.ts` FINALIZED vs NEEDS_REVIEW routing and invalid vision JSON.
- `tests/technicalQa.test.ts`, `tests/normalizeStoryboard.test.ts`, `tests/promptBuilder.test.ts`.

## Not implemented

- No web UI or HTTP API.
- Veo provider not run against a live Vertex project (no billing in the challenge).
- No audio design (music, voice-over) beyond what the clips contain.
- No A/B generation of multiple candidate videos.

## What I would do next

1. Run the Veo provider live and compare cost and quality against Flow, with image-conditioned shots (reference frame from the previous shot) for stronger consistency.
2. Generate N candidates per shot and let creative QA pick the best, automatically redoing the weakest scene.
3. Add a minimal web view over `runs/` (status, strategy, storyboard, video) and move the job store to SQLite plus a worker queue.
