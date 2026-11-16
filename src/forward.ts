/**
 * rumorcheck core: a forwarding client for the hosted
 * Leonida Lab GTA 6 fact-base MCP server.
 *
 * No fact data lives on this machine. tools/list is
 * answered from the literal definitions below, which
 * reproduce a live capture of the upstream server word
 * for word (name, title, description and inputSchema
 * exactly as captured, including the `$schema` marker
 * each captured inputSchema carries). A tools/call
 * travels upstream over a streamable-HTTP JSON-RPC
 * session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to https://leonidalab.com/mcp
 * and may be replaced with the LEONIDALAB_MCP_URL
 * environment variable (that override is a labelled
 * reconstruction). The registry record declares NO
 * headers on the remote: no auth header is ever sent,
 * under any environment.
 *
 * All five captured tools are reads over published
 * data — claim checks, release information,
 * per-country prices, an edition comparison and the
 * changelog — so the full captured surface is served
 * and nothing is submitted or purchased.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out — become an isError result
 * whose text begins with `rumorcheck error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://leonidalab.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/leonidalab-tools-original.json;         */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
    {
      "name": "check_claim",
      "title": "Is this GTA 6 claim confirmed?",
      "description": "Checks one claim about GTA 6 (Grand Theft Auto VI) against the record: a PC version, 60 FPS, the frame rate, online at launch, a disc, crossplay, early access, map size, story length, age rating, microtransactions and more. Returns the closest matches, each with its status (official, reported or not announced), the detail, the sources with their dates and the page. A miss lists the topics that are covered. Unofficial: Leonida Lab is not affiliated with Rockstar Games or Take-Two.",
      "inputSchema": {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "query": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "The claim or topic in a few words: \"PC version\", \"60 FPS on PS5 Pro\", \"is there a disc\", \"online at launch\"."
          },
          "limit": {
            "default": 5,
            "description": "How many matches at most (1-10).",
            "type": "integer",
            "minimum": 1,
            "maximum": 10
          }
        },
        "required": [
          "query"
        ]
      }
    },
    {
      "name": "release_info",
      "title": "GTA 6 release date and unlock time",
      "description": "When GTA 6 comes out: the official date (November 19, 2026), the platforms and which are not announced, the unlock time in each of 15 regions or in the one place you name, and the dates around launch (boxed copies and preload, the pre-order deadline). Each part carries its own status: the unlock hour is not necessarily official, and the answer says which. Unofficial: not affiliated with Rockstar Games or Take-Two.",
      "inputSchema": {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "place": {
            "description": "A country, region, city or IANA time zone for the unlock time: \"Germany\", \"US West\", \"Tokyo\", \"Europe/Rome\". Omit it for every region.",
            "type": "string",
            "minLength": 1,
            "maxLength": 60
          }
        }
      }
    },
    {
      "name": "price_in_country",
      "title": "GTA 6 price in a country",
      "description": "What a buyer pays for GTA 6 in one of 63 markets, Standard and Ultimate, read from the official PlayStation Store and Xbox Store listings: the price at checkout in local currency, its US dollar value at the official exchange rate, and whether tax is inside the price, added at checkout or unconfirmed. A price listed before tax is labelled and is never called cheaper. Unofficial: not affiliated with Rockstar Games or Take-Two.",
      "inputSchema": {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "country": {
            "type": "string",
            "minLength": 1,
            "maxLength": 60,
            "description": "A country by name or two-letter code: \"Brazil\", \"UK\", \"Japan\", \"DE\"."
          },
          "platform": {
            "description": "Only this store. Omit it for both.",
            "type": "string",
            "enum": [
              "playstation",
              "xbox"
            ]
          }
        },
        "required": [
          "country"
        ]
      }
    },
    {
      "name": "compare_editions",
      "title": "GTA 6 Standard vs Ultimate",
      "description": "The two GTA 6 editions side by side: US list prices, what each includes, every Ultimate Edition bonus as Rockstar lists it, the pre-order bonus and its deadline, the fact that there is no disc (boxed copies hold a download code), and the Collector's Box, which is merchandise without the game. Each line carries its status and source. Unofficial: not affiliated with Rockstar Games or Take-Two.",
      "inputSchema": {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {}
      }
    },
    {
      "name": "recent_changes",
      "title": "What changed about GTA 6",
      "description": "Dated entries from the Leonida Lab changelog, newest first: what Rockstar Games, Take-Two or the stores announced, what press reported, and changes to the site itself, each labelled and linked to its source. Optionally only entries since a date. Unofficial: not affiliated with Rockstar Games or Take-Two.",
      "inputSchema": {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "since": {
            "description": "Only entries on or after this date (YYYY-MM-DD).",
            "type": "string",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
          },
          "limit": {
            "default": 10,
            "description": "How many entries, newest first (1-30).",
            "type": "integer",
            "minimum": 1,
            "maximum": 30
          }
        }
      }
    }
  ];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured full surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `rumorcheck error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class RumorcheckClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).LEONIDALAB_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    // The registry record declares NO headers on the remote:
    // no Authorization (or any other auth) header is ever sent.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "rumorcheck", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): RumorcheckClient {
  return new RumorcheckClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new RumorcheckClient(deps).callTool(name, args);
}
