# NomadGuard — AI Creative Operator

Brief → Strategy → Storyboard → Video (Google Flow by hand, or Vertex AI Veo 3.1) → QA → final 9:16 ad.

Work in progress. Setup and architecture notes land here as slices merge.

## Quick start (plan-only, S1)

```bash
pnpm install
pnpm start run --plan-only --llm fake      # offline, canned fixtures
pnpm start run --provider mock --llm fake  # full offline run -> runs/<id>/final.mp4 + qa.json (needs ffmpeg)
cp .env.example .env                       # set GEMINI_API_KEY (free AI Studio key)
pnpm start run --plan-only                 # Gemini via the API key
pnpm test && pnpm typecheck
```

Each run writes `runs/<runId>/` with `job.json`, `brief.json`, `strategy.json`, `storyboard.json` and `prompts.json`, plus `clips/`, `final.mp4` and `qa.json` for full runs.

## Free path (default): AI Studio key + manual clips

1. Create a key at https://aistudio.google.com/apikey and set `GEMINI_API_KEY` in `.env` (no Google Cloud project needed). `GEMINI_MODEL` defaults to `gemini-3.8-flash` in this mode; if you get a "model not found" message, set `GEMINI_MODEL` to a current model.
2. `pnpm start run --provider manual` plans the ad, writes one `runs/<id>/inbox/<sceneId>.prompt.md` per shot plus `inbox/README.md`, then pauses (state `AWAITING_CLIPS`, exit code 0).
3. Make each shot in [Google Flow](https://labs.google/flow) (Veo 3.1, 9:16, closest length at least the shot duration) and save it as `inbox/<sceneId>.mp4`.
4. `pnpm start resume <runId> --provider manual` imports whatever is present, assembles, and runs QA. Missing clips pause the run again. Longer clips are trimmed to the storyboard duration, shorter ones are used as-is (noted in the job), and clips without audio get silence. A broken file fails only that shot; replace it and resume.

`--llm gemini` is the default (`vertex` is accepted as an alias); it uses the API key when `GEMINI_API_KEY` is set, otherwise Vertex AI.

## Providers

- `--provider manual`: the free path above (Flow by hand).

- `--provider mock` (default when `GOOGLE_CLOUD_PROJECT` is unset): offline ffmpeg-rendered clips.
- `--provider veo` (production path; default when `GOOGLE_CLOUD_PROJECT` is set): Veo 3.1 on Vertex AI.
  - Enable the **Vertex AI API** (`gcloud services enable aiplatform.googleapis.com`) on the project, with billing active.
  - Auth is ADC: `gcloud auth application-default login`.
  - Set `GOOGLE_CLOUD_LOCATION=us-central1` (Veo region). `VEO_MODEL`, `VEO_RESOLUTION` and `VEO_MAX_CONCURRENCY` are optional, see `.env.example`.
  - Clips come back as inline bytes (no GCS bucket needed). Veo bills per generated second.
  - The `providerJobId` is the Vertex operation name, so polling works from that string alone.
