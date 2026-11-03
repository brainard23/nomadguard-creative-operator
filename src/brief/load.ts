import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BriefSchema, type Brief } from "./schema.ts";

export const DEFAULT_BRIEF_PATH = "briefs/nomadguard.json";

export class BriefError extends Error {
  override name = "BriefError";
}

export async function loadBrief(path: string = DEFAULT_BRIEF_PATH): Promise<Brief> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new BriefError(`Cannot read brief at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new BriefError(`Brief at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = BriefSchema.safeParse(json);
  if (!parsed.success) {
    throw new BriefError(`Brief at ${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
