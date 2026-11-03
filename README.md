# NomadGuard — AI Creative Operator

Brief → Strategy → Storyboard → Video (Vertex AI Veo 3.1) → QA → final 9:16 ad.

Work in progress. Setup and architecture notes land here as slices merge.

## Quick start (plan-only, S1)

```bash
pnpm install
pnpm start run --plan-only --llm fake      # offline, canned fixtures
pnpm start run --provider mock --llm fake  # full offline run -> runs/<id>/final.mp4 + qa.json (needs ffmpeg)
cp .env.example .env                       # set GOOGLE_CLOUD_PROJECT / LOCATION, then:
gcloud auth application-default login
pnpm start run --plan-only                 # Gemini on Vertex AI
pnpm test && pnpm typecheck
```

Each run writes `runs/<runId>/` with `job.json`, `brief.json`, `strategy.json`, `storyboard.json` and `prompts.json`, plus `clips/`, `final.mp4` and `qa.json` for full runs.

## Providers

- `--provider mock` (default when `GOOGLE_CLOUD_PROJECT` is unset): offline ffmpeg-rendered clips.
- `--provider veo` (default when `GOOGLE_CLOUD_PROJECT` is set): Veo 3.1 on Vertex AI.
  - Enable the **Vertex AI API** (`gcloud services enable aiplatform.googleapis.com`) on the project, with billing active.
  - Auth is ADC: `gcloud auth application-default login`.
  - Set `GOOGLE_CLOUD_LOCATION=us-central1` (Veo region). `VEO_MODEL`, `VEO_RESOLUTION` and `VEO_MAX_CONCURRENCY` are optional, see `.env.example`.
  - Clips come back as inline bytes (no GCS bucket needed). Veo bills per generated second.
  - The `providerJobId` is the Vertex operation name, so polling works from that string alone.
