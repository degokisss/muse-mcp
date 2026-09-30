import os from "node:os";
import path from "node:path";

const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  url: env.MUSE_URL ?? "https://muse.ai/",
  profileDir: path.resolve(env.MUSE_PROFILE_DIR ?? "./.muse-profile"),
  outputDir: path.resolve(env.MUSE_OUTPUT_DIR ?? path.join(os.tmpdir(), "muse-mcp")),
  channel: (env.MUSE_CHANNEL ?? "chrome") as "chrome" | "msedge",
  headless: env.MUSE_HEADLESS === "1",
  cdpUrl: env.MUSE_CDP,
  pollMs: num(env.MUSE_POLL_MS, 250),
  quietMs: num(env.MUSE_QUIET_MS, 1200),
  launchTimeoutMs: num(env.MUSE_LAUNCH_TIMEOUT_MS, 60_000),
  defaultChatTimeoutMs: num(env.MUSE_CHAT_TIMEOUT_MS, 240_000),
};
