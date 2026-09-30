import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "./config.js";
import { SELECTORS, resolve } from "./selectors.js";

export interface Msg {
  role: string;
  text: string;
}

export interface ChatImage {
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
}

/** Videos are large, so they are written to disk and returned by path rather than inline. */
export interface ChatVideo {
  path: string;
  mimeType: string;
  bytes: number;
}

interface RawMedia {
  kind: "image" | "video";
  mimeType: string;
  data: string;
}

const VIDEO_EXT: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

async function saveVideo(m: RawMedia, index: number): Promise<ChatVideo> {
  await mkdir(config.outputDir, { recursive: true });
  const file = path.join(config.outputDir, `muse-${Date.now()}-${index}.${VIDEO_EXT[m.mimeType] ?? "mp4"}`);
  const bytes = Buffer.from(m.data, "base64");
  await writeFile(file, bytes);
  return { path: file, mimeType: m.mimeType, bytes: bytes.length };
}

export interface ChatResult {
  reply: string;
  images: ChatImage[];
  videos: ChatVideo[];
  warnings?: string[];
  timedOut: boolean;
  error?: string;
  elapsedMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOGIN_TTL_MS = 30_000; // only positive checks are cached, so a logout is noticed within this window

export class MuseDriver {
  private context?: BrowserContext;
  private browser?: Browser; // set only when attached over CDP
  private page?: Page;
  private loggedInAt = 0;

  private async launch(): Promise<void> {
    if (this.context) return;
    if (config.cdpUrl) {
      this.browser = await chromium.connectOverCDP(config.cdpUrl);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      return;
    }
    try {
      this.context = await chromium.launchPersistentContext(config.profileDir, {
        channel: config.channel,
        headless: config.headless,
        viewport: null,
        timeout: config.launchTimeoutMs,
      });
    } catch (e) {
      // Profile locked by a running Chrome: fall back to CDP if available.
      const fallback = "http://127.0.0.1:9222";
      try {
        this.browser = await chromium.connectOverCDP(fallback);
        this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      } catch {
        throw new Error(
          `Cannot launch Chrome (${(e as Error).message}). ` +
            `Close the Chrome using ${config.profileDir} or start it with --remote-debugging-port=9222 and set MUSE_CDP.`,
        );
      }
    }
  }

  private async getPage(): Promise<Page> {
    await this.launch();
    if (this.page && !this.page.isClosed()) return this.page;
    const ctx = this.context!;
    const existing = ctx.pages().find((p) => p.url().startsWith(config.url));
    this.page = existing ?? ctx.pages()[0] ?? (await ctx.newPage());
    if (!this.page.url().startsWith(config.url)) {
      await this.page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.launchTimeoutMs });
    }
    return this.page;
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    return page
      .evaluate(async () => {
        try {
          const r = await fetch("/api/auth/check", { method: "POST" });
          if (!r.ok) return false;
          const j = await r.json();
          return Boolean(j?.ok);
        } catch {
          return false;
        }
      })
      .catch(() => false);
  }

  async status() {
    const page = await this.getPage();
    const loggedIn = await this.isLoggedIn(page);
    const composerReady = (await resolve(page, "editor")) !== null;
    return { url: page.url(), loggedIn, composerReady, attachedOverCdp: Boolean(this.browser) };
  }

  async waitForLogin(timeoutMs: number): Promise<boolean> {
    const page = await this.getPage();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.isLoggedIn(page)) return true;
      await sleep(1500);
    }
    return false;
  }

  private async readMessages(page: Page): Promise<Msg[]> {
    const sel = (await resolve(page, "message")) ?? SELECTORS.message[0];
    return page.evaluate((s) => {
      return Array.from(document.querySelectorAll(s)).map((el) => ({
        role: el.getAttribute("data-message-role") ?? "unknown",
        text: (el as HTMLElement).innerText ?? "",
      }));
    }, sel);
  }

  /** One round-trip per poll: error notice, streaming flag, assistant count and the assistant items after `from`. */
  private async pollState(page: Page, from: number) {
    return page.evaluate(
      ({ msg, err, stop, from }) => {
        const visible = (sel: string[]): HTMLElement | null => {
          for (const s of sel) {
            const el = document.querySelector(s) as HTMLElement | null;
            if (el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return el;
          }
          return null;
        };
        const errEl = visible(err);
        const msgSel = msg.find((s) => document.querySelector(s)) ?? msg[0];
        const a = Array.from(document.querySelectorAll(msgSel)).filter((el) => el.getAttribute("data-message-role") === "assistant");
        return {
          error: errEl ? errEl.innerText : (null as string | null),
          streaming: visible(stop) !== null,
          count: a.length,
          items: a.slice(from).map((el) => ({ text: (el as HTMLElement).innerText, media: el.querySelectorAll("img, video").length })),
        };
      },
      { msg: [...SELECTORS.message], err: [...SELECTORS.errorNotice], stop: [...SELECTORS.stopButton], from },
    );
  }

  /** Read the images/videos Muse rendered after `from` out of the page (they are blob: URLs, unusable outside it). */
  private async collectMedia(page: Page, from: number): Promise<{ media: RawMedia[]; warnings: string[] }> {
    const sel = (await resolve(page, "message")) ?? SELECTORS.message[0];
    return page.evaluate(
      async ({ sel, from }) => {
        const assistants = Array.from(document.querySelectorAll(sel)).filter((el) => el.getAttribute("data-message-role") === "assistant");
        const els = assistants.slice(from).flatMap((el) => Array.from(el.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")));
        const media: { kind: "image" | "video"; mimeType: string; data: string }[] = [];
        const warnings: string[] = [];
        for (const el of els) {
          const kind = el instanceof HTMLVideoElement ? "video" : "image";
          const src = el.currentSrc || el.src;
          try {
            if (el instanceof HTMLImageElement) await el.decode();
            const blob = await (await fetch(src)).blob();
            const url = await new Promise<string>((ok, fail) => {
              const fr = new FileReader();
              fr.onload = () => ok(String(fr.result));
              fr.onerror = () => fail(fr.error);
              fr.readAsDataURL(blob);
            });
            media.push({ kind, mimeType: blob.type || (kind === "video" ? "video/mp4" : "image/png"), data: url.slice(url.indexOf(",") + 1) });
          } catch (e) {
            warnings.push(`${kind} not readable (${src.slice(0, 80)}): ${(e as Error).message}`);
          }
        }
        return { media, warnings };
      },
      { sel, from },
    );
  }

  async readLast(): Promise<string> {
    const page = await this.getPage();
    const msgs = await this.readMessages(page);
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    return last?.text ?? "";
  }

  async newChat(): Promise<void> {
    const page = await this.getPage();
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.launchTimeoutMs });
    // domcontentloaded fires before the SPA hydrates; snapshotting messages earlier races the old thread.
    await page.waitForSelector(SELECTORS.editor.join(","), { timeout: config.launchTimeoutMs });
  }

  private async type(page: Page, prompt: string): Promise<void> {
    const editorSel = await resolve(page, "editor");
    if (!editorSel) throw new Error("Composer not found. Are you logged in? Try muse_status.");
    const editor = page.locator(editorSel).first();
    await editor.click();
    const tag = await editor.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "textarea") {
      await editor.fill(prompt);
    } else {
      // Rich editors: insert as one text op so newlines do not trigger send.
      await page.keyboard.insertText(prompt);
    }
    await page.keyboard.press("Enter");
  }

  async chat(prompt: string, opts: { timeoutMs?: number; newThread?: boolean } = {}): Promise<ChatResult> {
    const t0 = Date.now();
    const timeoutMs = opts.timeoutMs ?? config.defaultChatTimeoutMs;
    const page = await this.getPage();
    if (opts.newThread) await this.newChat();
    if (Date.now() - this.loggedInAt > LOGIN_TTL_MS) {
      if (!(await this.isLoggedIn(page))) {
        return { reply: "", images: [], videos: [], timedOut: false, error: "Not logged in. Run muse_login first.", elapsedMs: 0 };
      }
      this.loggedInAt = Date.now();
    }

    const beforeCount = (await this.readMessages(page)).filter((m) => m.role === "assistant").length;

    await this.type(page, prompt);

    let lastSig = "";
    let lastChangeAt = Date.now();
    let sawActivity = false;
    let reply = "";
    let mediaCount = 0;

    while (Date.now() - t0 < timeoutMs) {
      await sleep(config.pollMs);

      const s = await this.pollState(page, beforeCount);
      if (s.error !== null) {
        return { reply, images: [], videos: [], timedOut: false, error: s.error || "Muse reported an error", elapsedMs: Date.now() - t0 };
      }

      const isNew = s.count > beforeCount;
      if (s.streaming || isNew) sawActivity = true;
      if (!isNew) continue;

      // Everything Muse appended since the prompt: text bubbles and image/video bubbles, in order.
      const sig = s.items.map((i) => `${i.text}\u0000${i.media}`).join("\u0001");
      if (sig !== lastSig) {
        lastSig = sig;
        lastChangeAt = Date.now();
        reply = s.items.map((i) => i.text).filter(Boolean).join("\n\n");
        mediaCount = s.items.reduce((n, i) => n + i.media, 0);
      }

      const quiet = Date.now() - lastChangeAt >= config.quietMs;
      if (sawActivity && !s.streaming && quiet && (reply.length > 0 || mediaCount > 0)) {
        const out = mediaCount > 0 ? await this.collectMedia(page, beforeCount) : { media: [], warnings: [] };
        const images: ChatImage[] = [];
        const videos: ChatVideo[] = [];
        for (const m of out.media) {
          if (m.kind === "image") images.push({ mimeType: m.mimeType, data: m.data });
          else videos.push(await saveVideo(m, videos.length));
        }
        return { reply, images, videos, ...(out.warnings.length ? { warnings: out.warnings } : {}), timedOut: false, elapsedMs: Date.now() - t0 };
      }
    }
    return { reply, images: [], videos: [], timedOut: true, elapsedMs: Date.now() - t0 };
  }

  async close(): Promise<void> {
    // CDP-attached: only disconnect. Own browser: close it.
    if (this.browser) await this.browser.close().catch(() => undefined);
    else if (this.context) await this.context.close().catch(() => undefined);
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.loggedInAt = 0;
  }
}
