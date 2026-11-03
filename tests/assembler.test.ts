import { describe, expect, it } from "vitest";
import { buildAssembleArgs } from "../src/assembly/assembler.ts";

const args = buildAssembleArgs({
  clips: ["a.mp4", "b.mp4"],
  endCardImage: "end.png",
  endCardSeconds: 2,
  output: "final.mp4",
});
const after = (flag: string) => args[args.indexOf(flag) + 1];

describe("buildAssembleArgs", () => {
  it("adds one input per clip plus the end-card image and silence", () => {
    expect(args.filter((a) => a === "-i")).toHaveLength(4);
    expect(args).toContain("a.mp4");
    expect(args).toContain("end.png");
  });

  it("normalizes every segment to 1080x1920 @30fps and concats clips + end card", () => {
    const graph = after("-filter_complex")!;
    expect(graph.match(/scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30/g)).toHaveLength(3);
    expect(graph).toContain("concat=n=3:v=1:a=1");
  });

  it("encodes H.264 yuv420p + AAC with faststart, capped at 15s, writing the output last", () => {
    expect(after("-c:v")).toBe("libx264");
    expect(after("-pix_fmt")).toBe("yuv420p");
    expect(after("-c:a")).toBe("aac");
    expect(after("-movflags")).toBe("+faststart");
    expect(args[args.lastIndexOf("-t") + 1]).toBe("15");
    expect(args.at(-1)).toBe("final.mp4");
  });
});
