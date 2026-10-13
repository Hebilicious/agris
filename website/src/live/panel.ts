/**
 * The result panel under a live example: the Run button sends the query to the shared demo, and the panel shows the
 * status, the round-trip time, what the cache did and the answer as coloured JSON. `LiveQuery.astro` draws the parts;
 * this module moves them. Everything it writes is text or elements it creates, never HTML from the response.
 *
 * One panel is in one of three states, and `enter` is the only place that changes it:
 *
 * | State     | Run                     | Its answer arrives | Close               | Collapse |
 * | --------- | ----------------------- | ------------------ | ------------------- | -------- |
 * | `closed`  | sends: `loading`        | (none in flight)   | ignored             | ignored  |
 * | `loading` | ignored (aria-disabled) | `shown`            | aborts it: `closed` | toggles  |
 * | `shown`   | sends again: `loading`  | (none in flight)   | `closed`            | toggles  |
 *
 * An answer to a request the panel no longer waits for, because the reader closed it, is dropped.
 *
 * Where the result sits is up to the page's CSS, which says so in `--live-layout`: `below` the query, or `beside` it,
 * where an open, expanded result makes its card a whole row. In the `beside` layout, opening, closing, collapsing and
 * expanding move the cards around it, so those changes are drawn through `reflow`, a frame late, inside a view
 * transition; `state` changes at once, and whatever it is by then is what gets drawn.
 */
import { ageOf } from "../figure/model.ts";
import { cooldownLeft, runQuery, type CacheReport, type LiveResult } from "./client.ts";
import { jsonTextOf, jsonTokens } from "./json.ts";
import { reflow } from "./reflow.ts";

/** A guard on a request that never settles; the demo gives up on Pearl Abyss well before it. */
const TIMEOUT_MS = 45_000;

type PanelState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "loading";
      readonly request: AbortController;
      readonly expanded: boolean;
      /** The answer to the last run, shown dimmed until the new one replaces it. */
      readonly previous: LiveResult | null;
    }
  | { readonly kind: "shown"; readonly result: LiveResult; readonly expanded: boolean };

const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

type Tone = "ok" | "error" | "hit" | "miss" | "stale" | "neutral";

interface Chip {
  /** Read before the value by screen readers only, such as "Status". */
  readonly name: string;
  readonly value: string;
  readonly tone: Tone;
}

export function mountLiveQuery(root: HTMLElement): void {
  const find = <T extends Element>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (element === null) throw new Error(`A live example is missing ${selector}`);
    return element;
  };
  const runButton = find<HTMLButtonElement>("[data-live-run]");
  const panel = find<HTMLElement>("[data-live-panel]");
  const summary = find<HTMLElement>("[data-live-summary]");
  const copyButton = find<HTMLButtonElement>("[data-live-copy]");
  const toggleButton = find<HTMLButtonElement>("[data-live-toggle]");
  const closeButton = find<HTMLButtonElement>("[data-live-close]");
  const body = find<HTMLElement>("[data-live-body]");
  const note = find<HTMLElement>("[data-live-note]");
  const meta = find<HTMLElement>("[data-live-meta]");
  const well = find<HTMLElement>("[data-live-well]");
  const code = find<HTMLElement>("[data-live-json]");

  const endpoint = root.dataset.endpoint ?? "";
  const query = root.dataset.query ?? "";
  const fallbackRetryAfter = Number(root.dataset.retryAfter) || 60;
  /** The example card the panel belongs to, which the `beside` layout widens. */
  const card = root.closest<HTMLElement>("[data-live-card]");

  let state: PanelState = { kind: "closed" };
  /** The state the page shows; behind `state` only while a reflow waits for its transition to draw. */
  let drawn: PanelState = state;
  let reflowing = false;
  /** Ticks a busy result's countdown while that result is shown. */
  let countdown = 0;

  function enter(next: PanelState) {
    const moves = card !== null && isOpen(state) !== isOpen(next) && besideLayout();
    window.clearInterval(countdown);
    countdown = 0;
    state = next;
    // A reflow already waiting draws whatever `state` is when its transition runs.
    if (reflowing) return;
    if (!moves) {
      draw();
      return;
    }
    reflowing = true;
    reflow(card, () => {
      reflowing = false;
      draw();
    });
  }

  /** Brings the page up to `state`. */
  function draw() {
    const before = drawn;
    drawn = state;
    renderFrame();
    // Collapsing or expanding keeps the result: redrawing it would make the live region say it again.
    if (before.kind !== state.kind || resultOf(before) !== resultOf(state)) renderResult();
    if (state.kind === "shown" && state.result.kind === "busy" && countdown === 0) {
      countdown = window.setInterval(() => renderBusyNote(), 1000);
    }
  }

  /** Whether the CSS lays an open result beside its query, as it does on a wide screen. */
  function besideLayout(): boolean {
    return getComputedStyle(root).getPropertyValue("--live-layout").trim() === "beside";
  }

  async function run() {
    if (state.kind === "loading") return;
    const request = new AbortController();
    const previous = state.kind === "shown" ? state.result : null;
    enter({ kind: "loading", request, expanded: true, previous });
    const result = await runQuery({
      endpoint,
      query,
      signal: request.signal,
      fallbackRetryAfter,
      timeoutMs: TIMEOUT_MS,
    });
    // An answer to a request the reader closed in the meantime is dropped.
    const waiting = waitingFor(request);
    if (waiting === null) return;
    // A reader who collapsed the panel while it was loading keeps it collapsed.
    enter({ kind: "shown", result, expanded: waiting.expanded });
  }

  /** The loading state still waiting for `request`, or `null` once the reader has closed it or run again. */
  function waitingFor(request: AbortController): Extract<PanelState, { kind: "loading" }> | null {
    return state.kind === "loading" && state.request === request ? state : null;
  }

  function close() {
    if (state.kind === "closed") return;
    if (state.kind === "loading") state.request.abort();
    const focusWasInside = panel.contains(document.activeElement);
    enter({ kind: "closed" });
    if (focusWasInside) runButton.focus({ preventScroll: true });
  }

  function toggle() {
    if (state.kind === "closed") return;
    enter({ ...state, expanded: !state.expanded });
  }

  /* ------------------------------------------------------------ drawing */

  /** The button, the panel's visibility and the collapse control. */
  function renderFrame() {
    const loading = state.kind === "loading";
    root.dataset.state = state.kind === "shown" ? state.result.kind : state.kind;
    // `aria-disabled` rather than `disabled`: a disabled button drops the keyboard focus a reader just put on it.
    // `run` ignores the button while a query is in flight.
    runButton.setAttribute("aria-disabled", String(loading));
    panel.hidden = state.kind === "closed";
    panel.setAttribute("aria-busy", String(loading));
    const expanded = isOpen(state);
    // The page's CSS lays the card out from this: an open, expanded result may sit beside the query.
    root.dataset.expanded = String(expanded);
    body.hidden = !expanded;
    toggleButton.setAttribute("aria-expanded", String(expanded));
    toggleButton.setAttribute("aria-label", expanded ? "Collapse the result" : "Expand the result");
  }

  /** The summary, the note, the headers and the JSON. */
  function renderResult() {
    if (state.kind === "closed") return;
    const loading = state.kind === "loading";
    const result = resultOf(state);
    // The summary is the panel's live region: it says the outcome once, and the note's message with it, while the
    // busy note's countdown ticks outside it.
    const announcement = renderNote(result);
    if (loading) summary.replaceChildren(textSpan("live-running", "Running on the shared demo…"));
    else if (result !== null) {
      summary.replaceChildren(...chipsOf(result).map(chipElement), textSpan("visually-hidden", announcement));
    }

    renderMeta(result?.kind === "data" || result?.kind === "errors" ? result.cache : null);
    const json = result?.kind === "data" || result?.kind === "errors" ? result.body : undefined;
    well.hidden = json === undefined;
    copyButton.hidden = json === undefined || loading;
    if (json === undefined) {
      code.replaceChildren();
      copyButton.dataset.copy = "";
      return;
    }
    const tokens = jsonTokens(json);
    code.replaceChildren(highlighted(tokens));
    copyButton.dataset.copy = jsonTextOf(tokens);
  }

  /** Draws the note above the JSON and returns what it says, for the live region. */
  function renderNote(result: LiveResult | null): string {
    note.hidden = result === null || result.kind === "data";
    if (result === null || result.kind === "data") return "";
    note.dataset.tone = result.kind === "errors" ? "error" : result.kind;
    if (result.kind === "busy") {
      renderBusyNote();
      return `The shared demo is busy. Try again in ${result.retryAfter} seconds, or deploy your own.`;
    }
    if (result.kind === "failed") {
      note.replaceChildren(result.message);
      return result.message;
    }
    const count = result.messages.length;
    const lead = count === 1 ? "The demo answered with an error:" : `The demo answered with ${count} errors:`;
    const list = document.createElement("ul");
    for (const message of result.messages) list.append(textElement("li", message));
    note.replaceChildren(textSpan("live-note-lead", lead), list);
    return `${lead} ${result.messages.join(" ")}`;
  }

  /** The 429 note, with the seconds left before the demo takes requests again. */
  function renderBusyNote() {
    const left = cooldownLeft();
    // The note is built once; each tick rewrites only the text before the link, so a reader who has tabbed to
    // the link keeps their focus on it, including when the countdown runs out.
    let message = note.querySelector<HTMLSpanElement>(".live-busy-message");
    if (!message) {
      message = textSpan("live-busy-message", "");
      const deploy = document.createElement("a");
      deploy.className = "live-deploy";
      deploy.href = "#deploy";
      deploy.textContent = "deploy your own";
      note.replaceChildren(message, deploy, ".");
    }
    if (left > 0) {
      message.replaceChildren(
        "The shared demo is busy. Try again in ",
        textSpan("live-countdown", `${left} s`),
        ", or ",
      );
    } else {
      window.clearInterval(countdown);
      countdown = 0;
      message.replaceChildren("The shared demo should take queries again: press Run query. Or ");
    }
  }

  function renderMeta(cache: CacheReport | null) {
    const rows: [string, string][] = [];
    if (cache?.control) rows.push(["Cache-Control", cache.control]);
    if (cache?.source) rows.push(["Market data", cache.source]);
    meta.hidden = rows.length === 0;
    meta.replaceChildren(
      ...rows.map(([name, value]) => {
        const row = document.createElement("div");
        row.append(textElement("dt", name), textElement("dd", value));
        return row;
      }),
    );
  }

  runButton.addEventListener("click", () => void run());
  closeButton.addEventListener("click", close);
  toggleButton.addEventListener("click", toggle);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  renderFrame();
}

/** Whether the panel shows its result's body: open and not collapsed. */
function isOpen(state: PanelState): boolean {
  return state.kind !== "closed" && state.expanded;
}

/** The answer a panel shows: its result, or while a new run is in flight the previous one, dimmed. */
function resultOf(state: PanelState): LiveResult | null {
  if (state.kind === "shown") return state.result;
  if (state.kind === "loading") return state.previous;
  return null;
}

/** The summary line: status, round trip and cache, in that order. */
function chipsOf(result: LiveResult): Chip[] {
  switch (result.kind) {
    case "busy":
      return result.sent
        ? [
            { name: "Status", value: "429 Too Many Requests", tone: "error" },
            ...(result.ms === null ? [] : [timeChip(result.ms)]),
          ]
        : [{ name: "Status", value: "Not sent: the demo is busy", tone: "error" }];
    case "failed":
      return [
        { name: "Status", value: result.status === null ? "No answer" : statusText(result.status), tone: "error" },
        timeChip(result.ms),
      ];
    case "data":
    case "errors": {
      const ok = result.status >= 200 && result.status <= 299;
      const cache = cacheChip(result.cache);
      return [
        { name: "Status", value: statusText(result.status), tone: ok && result.kind === "data" ? "ok" : "error" },
        timeChip(result.ms),
        ...(cache === null ? [] : [cache]),
      ];
    }
  }
}

function statusText(status: number): string {
  const reason = REASONS[status];
  return reason === undefined ? String(status) : `${status} ${reason}`;
}

function timeChip(ms: number): Chip {
  const value = ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
  return { name: "Round trip", value, tone: "neutral" };
}

/** Cloudflare's cache status and the answer's age, or "Not stored" for an answer the gateway marked `no-store`. */
function cacheChip(cache: CacheReport): Chip | null {
  const noStore = cache.control !== null && /\bno-store\b/i.test(cache.control);
  if (cache.edge === null) return noStore ? { name: "Cache", value: "Not stored", tone: "neutral" } : null;
  const age = cache.age !== null && cache.age > 0 ? ` · ${ageOf(cache.age)} old` : "";
  return { name: "Cache", value: `${cache.edge}${age}`, tone: toneOfEdge(cache.edge) };
}

function toneOfEdge(edge: string): Tone {
  if (edge === "HIT") return "hit";
  if (edge === "MISS") return "miss";
  if (edge === "STALE" || edge === "UPDATING" || edge === "REVALIDATED" || edge === "EXPIRED") return "stale";
  return "neutral";
}

function chipElement(chip: Chip): HTMLElement {
  const element = textSpan("live-chip", "");
  element.dataset.tone = chip.tone;
  const name = textSpan("visually-hidden", `${chip.name}: `);
  element.append(name, chip.value);
  return element;
}

function highlighted(tokens: ReturnType<typeof jsonTokens>): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    if (token.kind === "space") fragment.append(token.text);
    else fragment.append(textSpan(`j-${token.kind}`, token.text));
  }
  return fragment;
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  if (className !== "") span.className = className;
  span.textContent = text;
  return span;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
