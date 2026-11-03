# NomadGuard — AI Creative Operator

Brief → Strategy → Storyboard → Video (Vertex AI Veo 3.1) → QA → final 9:16 ad.

Work in progress. Setup and architecture notes land here as slices merge.

## Quick start (plan-only, S1)

```bash
pnpm install
pnpm start run --plan-only --llm fake      # offline, canned fixtures
cp .env.example .env                       # set GOOGLE_CLOUD_PROJECT / LOCATION, then:
gcloud auth application-default login
pnpm start run --plan-only                 # Gemini on Vertex AI
pnpm test && pnpm typecheck
```

Each run writes `runs/<runId>/` with `job.json`, `brief.json`, `strategy.json`, `storyboard.json` and `prompts.json`.
