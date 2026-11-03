import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { technicalQa } from "../src/qa/technical.ts";
import { makeClip } from "./support.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomadguard-qa-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("technicalQa", () => {
  it("passes a 12s 1080x1920 clip", async () => {
    const p = join(dir, "ok.mp4");
    await makeClip(p, { width: 1080, height: 1920, seconds: 12 });
    const r = await technicalQa(p);
    expect(r).toMatchObject({ exists: true, playable: true, width: 1080, height: 1920, aspect_ratio: "9:16", codec: "h264", valid: true, reasons: [] });
    expect(r.duration).toBeCloseTo(12, 0);
  });

  it("fails a 16:9 clip with resolution and aspect reasons", async () => {
    const p = join(dir, "wide.mp4");
    await makeClip(p, { width: 1920, height: 1080, seconds: 12 });
    const r = await technicalQa(p);
    expect(r.valid).toBe(false);
    expect(r.aspect_ratio).toBe("16:9");
    expect(r.reasons.join("\n")).toMatch(/resolution 1920x1080/);
    expect(r.reasons.join("\n")).toMatch(/aspect ratio 16:9/);
  });

  it("fails a 20s clip with a duration reason", async () => {
    const p = join(dir, "long.mp4");
    await makeClip(p, { width: 1080, height: 1920, seconds: 20 });
    const r = await technicalQa(p);
    expect(r.valid).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/duration 20\.\d+s is outside 10-15s/);
  });

  it("fails a missing file cleanly", async () => {
    const r = await technicalQa(join(dir, "nope.mp4"));
    expect(r).toMatchObject({ exists: false, playable: false, valid: false });
    expect(r.reasons[0]).toMatch(/does not exist/);
  });

  it("fails a corrupt file cleanly", async () => {
    const p = join(dir, "garbage.mp4");
    await writeFile(p, Buffer.from("this is definitely not an mp4 file".repeat(50)));
    const r = await technicalQa(p);
    expect(r).toMatchObject({ exists: true, playable: false, valid: false });
    expect(r.reasons[0]).toMatch(/not playable/);
  });
});
