import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  RumorcheckClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Leonida Lab endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/leonidalab-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const CLAIM = "check_claim";
const RELEASE = "release_info";
const PRICE = "price_in_country";
const EDITIONS = "compare_editions";
const CHANGES = "recent_changes";
const ALL_TOOLS = [CLAIM, RELEASE, PRICE, EDITIONS, CHANGES];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"status\":\"official\"}" }],
  structuredContent: { status: "official" },
};

const SAMPLE_ARGS = { query: "PC version" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "leonidalab", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new RumorcheckClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured full surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Is this GTA 6 claim confirmed?",
        "GTA 6 release date and unlock time",
        "GTA 6 price in a country",
        "GTA 6 Standard vs Ultimate",
        "What changed about GTA 6",
      ],
    );
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(CLAIM).description, /Checks one claim about GTA 6/);
    assert.match(defOf(PRICE).description, /one of 63 markets/);
  });

  it("carries the fixture's required fields per tool", () => {
    assert.deepEqual(schemaOf(defOf(CLAIM)).required, ["query"]);
    assert.equal(schemaOf(defOf(RELEASE)).required, undefined);
    assert.deepEqual(schemaOf(defOf(PRICE)).required, ["country"]);
    assert.equal(schemaOf(defOf(EDITIONS)).required, undefined);
    assert.equal(schemaOf(defOf(CHANGES)).required, undefined);
  });

  it("carries the $schema marker and object type on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("check_claim carries query then limit, in fixture order", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(CLAIM)).properties), [
      "query",
      "limit",
    ]);
  });

  it("check_claim query is a string of 1..200 characters", () => {
    const query = schemaOf(defOf(CLAIM)).properties.query;
    assert.equal(query.type, "string");
    assert.equal(query.minLength, 1);
    assert.equal(query.maxLength, 200);
  });

  it("check_claim limit is an integer 1..10 defaulting to 5", () => {
    const limit = schemaOf(defOf(CLAIM)).properties.limit;
    assert.equal(limit.type, "integer");
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, 10);
    assert.equal(limit.default, 5);
  });

  it("release_info carries only the optional place string of 1..60 characters", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(RELEASE)).properties), ["place"]);
    const place = schemaOf(defOf(RELEASE)).properties.place;
    assert.equal(place.type, "string");
    assert.equal(place.minLength, 1);
    assert.equal(place.maxLength, 60);
  });

  it("price_in_country carries country then platform, in fixture order", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(PRICE)).properties), [
      "country",
      "platform",
    ]);
  });

  it("price_in_country country is a string of 1..60 characters", () => {
    const country = schemaOf(defOf(PRICE)).properties.country;
    assert.equal(country.type, "string");
    assert.equal(country.minLength, 1);
    assert.equal(country.maxLength, 60);
  });

  it("price_in_country platform is the playstation/xbox enum", () => {
    const platform = schemaOf(defOf(PRICE)).properties.platform;
    assert.equal(platform.type, "string");
    assert.deepEqual(platform.enum, ["playstation", "xbox"]);
  });

  it("compare_editions takes no properties", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(EDITIONS)).properties), []);
  });

  it("recent_changes carries since then limit, in fixture order", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(CHANGES)).properties), [
      "since",
      "limit",
    ]);
  });

  it("recent_changes since is a dated string with the fixture pattern", () => {
    const since = schemaOf(defOf(CHANGES)).properties.since;
    assert.equal(since.type, "string");
    assert.equal(since.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
  });

  it("recent_changes limit is an integer 1..30 defaulting to 10", () => {
    const limit = schemaOf(defOf(CHANGES)).properties.limit;
    assert.equal(limit.type, "integer");
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, 30);
    assert.equal(limit.default, 10);
  });

  it("isKnownTool recognises the surface tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("check_claims"), false);
    assert.equal(isKnownTool("release_date"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://leonidalab.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name rumorcheck and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CLAIM, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "rumorcheck", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CLAIM, SAMPLE_ARGS);
    await c.callTool(RELEASE, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LEONIDALAB_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new RumorcheckClient({
      fetchFn: upstream.fetchFn,
      env: { LEONIDALAB_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LEONIDALAB_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new RumorcheckClient({
      fetchFn: upstream.fetchFn,
      env: { LEONIDALAB_MCP_URL: "   " },
    });
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LEONIDALAB_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new RumorcheckClient({
      fetchFn: upstream.fetchFn,
      env: { LEONIDALAB_API_KEY: "some-key-42" },
    });
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new RumorcheckClient({
      fetchFn: upstream.fetchFn,
      env: { AUTHORIZATION: "Bearer x", API_KEY: "y", LEONIDALAB_TOKEN: "z" },
    });
    await c.callTool(RELEASE, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new RumorcheckClient({
      fetchFn: upstream.fetchFn,
      env: { LEONIDALAB_API_KEY: "some-key-42" },
    });
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a check_claim call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CLAIM, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CLAIM);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a check_claim call with an explicit limit verbatim", async () => {
    const args = { query: "60 FPS on PS5 Pro", limit: 3 };
    const { client: c, calls } = stubClient();
    await c.callTool(CLAIM, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CLAIM);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards release_info under its own name with a place", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(RELEASE, { place: "Germany" });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RELEASE);
    assert.deepEqual(params.arguments, { place: "Germany" });
  });

  it("forwards price_in_country under its own name with country and platform", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(PRICE, { country: "Brazil", platform: "xbox" });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRICE);
    assert.deepEqual(params.arguments, { country: "Brazil", platform: "xbox" });
  });

  it("forwards compare_editions with empty arguments", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(EDITIONS, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EDITIONS);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards recent_changes under its own name with since and limit", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(CHANGES, { since: "2026-01-01", limit: 5 });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHANGES);
    assert.deepEqual(params.arguments, { since: "2026-01-01", limit: 5 });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no match upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(RELEASE, {});
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      PRICE,
      { country: "DE" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRICE);
    assert.deepEqual(params.arguments, { country: "DE" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as rumorcheck error text", () => {
  it("maps a JSON-RPC error to `rumorcheck error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "claim check failed upstream" },
    });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rumorcheck error: claim check failed upstream");
  });

  it("maps an initialize JSON-RPC error to rumorcheck error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rumorcheck error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rumorcheck error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rumorcheck error: malformed response");
  });

  it("maps a non-2xx upstream status to rumorcheck error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rumorcheck error: HTTP 500");
  });

  it("maps a throwing fetch to rumorcheck error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^rumorcheck error: /);
  });

  it("maps a throwing initialize fetch to rumorcheck error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rumorcheck error: socket hang up");
  });

  it("maps a timed-out call to rumorcheck error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(CLAIM, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^rumorcheck error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, CLAIM, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, CLAIM, "query=PC"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid check_claim call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, CLAIM, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a valid price_in_country call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PRICE, {
      country: "Japan",
      platform: "playstation",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRICE);
    assert.deepEqual(params.arguments, {
      country: "Japan",
      platform: "playstation",
    });
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, EDITIONS, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([CLAIM, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([CLAIM, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([CLAIM, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
