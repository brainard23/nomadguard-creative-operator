# AI usage

## Tools

- **Claude Code** (Opus as lead session, Sonnet 5.5 as per-slice worker agents in separate git worktrees) for planning, implementation, tests and review.
- **Google Gemini** (AI Studio API) and **Veo 3.1 in Google Flow** are product components, not development tools: Gemini plans the ad and scores frames, Flow rendered the clips.

## What AI was used for

- Splitting the work into slices (plan-only, mock end to end, reliability and resume, Veo provider, creative QA, free path with manual import, overlay and re-run tooling), each implemented test-first by a worker agent and reviewed by the lead session before merging.
- Writing the code, tests and prompts for those slices.
- Writing this documentation.

Approximately all of the source and tests were AI-generated under human direction. The human chose the product direction (a CLI, no Google Cloud, Flow for video), decided what to accept at each review, ran the real Gemini and Flow steps, and judged the video.

## One AI decision I changed

The first design assumed Vertex AI end to end (Gemini on Vertex and the Veo API). That needed a billed Google Cloud project, which was not practical for this exercise. I replaced it with an AI Studio key for Gemini and a `manual` video provider that exports prompts and imports clips made in Flow. The Veo provider stays as the production path behind the same `VideoProvider` interface.

Other AI output I rejected or changed in review:

- **QA frame sampling.** The worker deliberately never sampled the end card. The vision judge then marked the ad down for "no branding", which was wrong because the brand and CTA sit on the end card. I changed the sampler so the last frame is always from the end card, and told the judge which frame that is.
- **Stateful `getResult` in the Veo provider.** The first version kept job results in memory, so `resume` after a crash could never collect a finished clip. I sent it back. It is now stateless (`getResult(id, target)`), with a typed `VideoProviderError` carrying `retryable`.
- **Video content.** The pipeline's creative QA flagged that the storyboard's key "payout on the watch" moment never appeared on screen. Rather than keep regenerating in Veo (which broke hand anatomy and skin tone), I chose to composite the notification as a graphic in post.

## One problem introduced by AI that was caught and corrected

The prompt builder joined style-guide fields without cleaning them. Gemini writes fields that already end in a period, so the first real run produced prompts like `...the frozen queue.. Subject: ... composed expression., wearing Charcoal grey...`. The offline fixtures never ended in punctuation, so every test passed. It was found by reading a real run, fixed in `buildVeoPrompt` (trim trailing punctuation, lowercase the wardrobe after "wearing") and pinned with a regression test using the exact real fields.

Related finds from the first real runs: a 503 "high demand" error from Gemini failed a whole run, which led to transport retries in the LLM client, and the default model name had been retired for new API-key users, which now produces a clear message pointing to `GEMINI_MODEL`.
