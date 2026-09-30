#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MuseDriver } from "./driver.js";
import { Queue } from "./queue.js";

const driver = new MuseDriver();
const queue = new Queue();

interface ToolResult {
  [key: string]: unknown; // required by the MCP SDK handler result type
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: true;
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true as const } : {}),
});
const json = (o: unknown, isError = false) => text(JSON.stringify(o, null, 2), isError);

/** Run a driver job serialized on the queue; map success, turn any throw into an MCP error result. */
async function run<T>(job: () => Promise<T>, ok: (v: T) => ToolResult): Promise<ToolResult> {
  try {
    return ok(await queue.run(job));
  } catch (e) {
    return text((e as Error).message, true);
  }
}

const TEXT_ONLY_PREFIX =
  "Answer with plain text only. Do not browse, run code, use tools, or start background tasks. " +
  "Reply directly to the request below.\n\n";

async function loginCli() {
  console.error("Opening Chrome. Sign in to your Meta account, this window closes when done.");
  const ok = await driver.waitForLogin(10 * 60_000);
  console.error(ok ? "Logged in. Session saved to the profile dir." : "Timed out waiting for login.");
  await driver.close();
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes("--login")) return loginCli();

  const server = new McpServer({ name: "muse-mcp", version: "0.1.0" });

  server.registerTool(
    "muse_status",
    { description: "Check browser, login and composer state for Muse." },
    async () => {
      return run(() => driver.status(), (s) => json(s));
    },
  );

  server.registerTool(
    "muse_login",
    {
      description: "Wait for the user to finish signing in to Meta in the opened Chrome window.",
      inputSchema: { timeout_sec: z.number().int().min(10).max(900).optional() },
    },
    async ({ timeout_sec }) => {
      return run(
        () => driver.waitForLogin((timeout_sec ?? 300) * 1000),
        (ok) => json({ loggedIn: ok }, !ok),
      );
    },
  );

  server.registerTool(
    "muse_chat",
    {
      description:
        "Send a prompt to Muse and return its reply. Muse is one persistent thread, so it keeps context " +
        "between calls: send only the new message, not the whole history. Use it to delegate a focused " +
        "question, review, or draft. Calls are serialized.",
      inputSchema: {
        prompt: z.string().min(1),
        instructions: z.string().optional().describe("Optional standing instructions placed before the prompt."),
        text_only: z.boolean().optional().describe("Default true: tell Muse not to run tools or browse."),
        new_thread: z.boolean().optional().describe("Navigate to the home composer first (best-effort fresh context)."),
        timeout_sec: z.number().int().min(10).max(1800).optional(),
      },
    },
    async ({ prompt, instructions, text_only, new_thread, timeout_sec }) => {
      const parts = [
        text_only === false ? "" : TEXT_ONLY_PREFIX,
        instructions ? `${instructions}\n\n` : "",
        prompt,
      ];
      return run(
        () => driver.chat(parts.join(""), { timeoutMs: timeout_sec ? timeout_sec * 1000 : undefined, newThread: new_thread }),
        ({ images, ...meta }) => {
          const failed = Boolean(meta.error) || (meta.timedOut && !meta.reply && images.length === 0);
          const res = json({ ...meta, imageCount: images.length }, failed);
          res.content.push(...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })));
          return res;
        },
      );
    },
  );

  server.registerTool(
    "muse_read_last",
    { description: "Return the latest assistant message without sending anything." },
    async () => {
      return run(() => driver.readLast(), (t) => text(t));
    },
  );

  server.registerTool(
    "muse_new_chat",
    { description: "Navigate to the Muse home composer." },
    async () => {
      return run(() => driver.newChat(), () => text("ok"));
    },
  );

  server.registerTool(
    "muse_close",
    { description: "Close the browser (only disconnects if attached over CDP)." },
    async () => {
      await queue.run(() => driver.close());
      return text("closed");
    },
  );

  const shutdown = async () => {
    await driver.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown); // client gone: do not orphan Chrome holding the profile lock

  await server.connect(new StdioServerTransport());
  console.error("muse-mcp ready on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
