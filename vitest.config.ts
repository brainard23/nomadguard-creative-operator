import { defineConfig } from "vitest/config";

export default defineConfig({
  // Several tests render real ffmpeg video; give them headroom on slow machines.
  test: { testTimeout: 60_000 },
});
