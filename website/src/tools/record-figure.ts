/**
 * Records the README's "See it work" GIF, `docs/assets/fig1.gif`, from the built site: Fig 1 in dark mode sends the
 * Prices card (a MISS that travels out to Pearl Abyss and back), sends it again (a HIT from the rack), then floods the
 * turnstile (a 429). Run it with `moon run website:record-figure` after the figure or the site's look changes.
 *
 * It serves `website/dist` on a free port of its own, drives Chromium with playwright-core, collects the frames the page
 * paints over the DevTools screencast, keeps the latest frame at every tenth of a second, and has ffmpeg crop them to
 * the figure's console and plate, scale them to the README's 760px and encode the GIF with a palette made for them.
 *
 * Needs `ffmpeg` on the PATH and the Chromium build this playwright-core expects:
 * `pnpm --filter @agris/website exec playwright-core install chromium-headless-shell`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Page } from "playwright-core";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const OUTPUT = fileURLToPath(new URL("../../../docs/assets/fig1.gif", import.meta.url));

/** A small desktop window: the figure is 1060px wide with its console on two rows, which scales to 760 × 572. */
const VIEWPORT = { width: 1100, height: 1000 };
/** The GIF's width in the README, and its frame rate. */
const GIF_WIDTH = 760;
const FPS = 10;
/** How long to dwell before the first send and after each answer, so a reader can take in the strip and narration. */
const LEAD_MS = 600;
const HOLD_MS = 1000;
const LAST_HOLD_MS = 2400;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Serves the built site from `DIST` on 127.0.0.1, on a port the system picks, so it never takes one in use. */
async function serveDist(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
    const file = join(DIST, relative);
    if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep) || !isFile(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The site server has no port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface Frame {
  /** Seconds since the epoch, from the screencast. */
  readonly at: number;
  readonly png: Buffer;
}

/** The figure's console and plate, in the window's CSS pixels. */
interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Clicks a console button, then moves the pointer off the figure so no hover state or part label shows. */
async function press(page: Page, selector: string) {
  await page.locator(selector).click();
  await page.mouse.move(VIEWPORT.width - 8, VIEWPORT.height - 8);
}

/** Waits until the figure's step strip reports `status`, then until its card is back in the tray. */
async function settled(page: Page, status: string) {
  await page.waitForSelector(`[data-exchange][data-status="${status}"]`, { timeout: 60_000 });
  await page.waitForSelector("[data-exchange]:not([data-busy])", { timeout: 60_000 });
}

async function record(origin: string): Promise<{ frames: Frame[]; clip: Clip }> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    // The console's top sits just under the sticky header, with the plate below it in the window.
    await page.evaluate(() => {
      const bar = document.querySelector(".fx-console");
      if (bar === null) throw new Error("Fig 1's console is missing");
      window.scrollTo({ top: bar.getBoundingClientRect().top + window.scrollY - 96, behavior: "instant" });
    });
    // Choosing the card takes the figure over from its idle tour; the recording sends every card itself.
    await page.locator('[data-exchange] [data-pick="prices"]').click();
    await page.mouse.move(VIEWPORT.width - 8, VIEWPORT.height - 8);
    await page.waitForTimeout(600);

    const clip: Clip = await page.evaluate(() => {
      const bar = document.querySelector(".fx-console")?.getBoundingClientRect();
      const plate = document.querySelector("[data-exchange] .iso-plate")?.getBoundingClientRect();
      if (bar === undefined || plate === undefined) throw new Error("Fig 1's console or plate is missing");
      const height = plate.bottom - bar.top;
      return {
        x: Math.round(bar.left),
        y: Math.round(bar.top),
        width: Math.round(bar.width),
        height: Math.round(height),
      };
    });
    if (clip.y + clip.height > VIEWPORT.height)
      throw new Error(`Fig 1 is ${clip.height}px tall and does not fit the window`);

    const frames: Frame[] = [];
    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (frame) => {
      frames.push({ at: frame.metadata.timestamp ?? Date.now() / 1000, png: Buffer.from(frame.data, "base64") });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    const started = Date.now() / 1000;
    await page.waitForTimeout(LEAD_MS);

    // A MISS, all the way out to Pearl Abyss and back.
    await press(page, "[data-send-selected]");
    await settled(page, "miss");
    await page.waitForTimeout(HOLD_MS);
    // A HIT: once the rack has answered, the flood is queued behind the card on its way back to the tray.
    await press(page, "[data-send-selected]");
    await page.waitForSelector('[data-exchange][data-status="hit"]', { timeout: 60_000 });
    await page.waitForTimeout(HOLD_MS);
    // The flood: the GIF ends on the 429 and its narration.
    await press(page, '[data-send="flood"]');
    await page.waitForSelector('[data-exchange][data-status="rejected"]', { timeout: 60_000 });
    await page.waitForTimeout(LAST_HOLD_MS);

    await cdp.send("Page.stopScreencast");
    const stopped = Date.now() / 1000;
    const first = frames[0];
    const last = frames.at(-1);
    if (first === undefined || last === undefined) throw new Error("The screencast sent no frames");
    // The page paints only when something changes: the first frame stands for the moment recording started, and the
    // last one holds until it stopped.
    return { frames: [{ at: started, png: first.png }, ...frames, { at: stopped, png: last.png }], clip };
  } finally {
    await browser.close();
  }
}

/** One frame per tick: the latest frame painted at or before it. */
function resample(frames: readonly Frame[]): Buffer[] {
  const sorted = [...frames].sort((a, b) => a.at - b.at);
  const start = sorted[0]?.at ?? 0;
  const end = sorted[sorted.length - 1]?.at ?? 0;
  const ticks: Buffer[] = [];
  let index = 0;
  for (let at = start; at <= end; at += 1 / FPS) {
    while (index + 1 < sorted.length && (sorted[index + 1]?.at ?? Infinity) <= at) index += 1;
    const frame = sorted[index];
    if (frame !== undefined) ticks.push(frame.png);
  }
  return ticks;
}

function encode(ticks: readonly Buffer[], clip: Clip) {
  const work = mkdtempSync(join(tmpdir(), "agris-fig1-"));
  try {
    ticks.forEach((png, index) => writeFileSync(join(work, `${String(index).padStart(5, "0")}.png`), png));
    // Crop to the figure, scale it down, then build one palette from every frame's changes and map the frames onto
    // it, writing only the rectangle that changed in each.
    const graph = [
      `[0:v]crop=${clip.width}:${clip.height}:${clip.x}:${clip.y},scale=${GIF_WIDTH}:-2:flags=lanczos,split[frames][copy]`,
      "[copy]palettegen=max_colors=192:stats_mode=diff[palette]",
      "[frames][palette]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
    ].join(";");
    const input = join(work, "%05d.png");
    const ffmpeg = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-framerate", String(FPS), "-i", input, "-filter_complex", graph, "-loop", "0", OUTPUT],
      { stdio: "inherit" },
    );
    if (ffmpeg.error !== undefined) throw new Error(`ffmpeg could not start: ${ffmpeg.error.message}`);
    if (ffmpeg.status !== 0) throw new Error(`ffmpeg exited with ${ffmpeg.status}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const { server, origin } = await serveDist();
try {
  const { frames, clip } = await record(origin);
  const ticks = resample(frames);
  encode(ticks, clip);
  const bytes = statSync(OUTPUT).size;
  console.log(
    `Wrote ${OUTPUT}: ${ticks.length} frames at ${FPS} fps (${(ticks.length / FPS).toFixed(1)} s), ${GIF_WIDTH}px wide, ${(bytes / 1024).toFixed(0)} KiB, from ${frames.length} painted frames of a ${clip.width} × ${clip.height} figure.`,
  );
} finally {
  server.close();
}
