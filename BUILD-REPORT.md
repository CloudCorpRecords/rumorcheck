# BUILD REPORT — rumorcheck

Clean-room rebuild of `com.leonidalab/gta6-facts` v1.0.0
(remote-only MCP server at `https://leonidalab.com/mcp`), built
2026-10-28 as a forwarding client. Package: `@reneturcios/rumorcheck`
0.1.0, registry name `io.github.CloudCorpRecords/rumorcheck`.

## Surface built

**FULL SURFACE: 5 of 5 captured tools built**, no omissions.

| Tool | Required fields as served |
|------|---------------------------|
| `check_claim` | `query` |
| `release_info` | *(none — no `required` key)* |
| `price_in_country` | `country` |
| `compare_editions` | *(none — no `required` key)* |
| `recent_changes` | *(none — no `required` key)* |

All five tools are reads over one published fact base about an
upcoming game release: claim checking against the base (each fact
tagged official or reported), release information, published
per-country pricing, edition comparison, and recent changes to
the base. Nothing is submitted or purchased — `price_in_country`
is a published price read — so the full captured surface is
served, with no omissions to record.

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, with the `inputSchema.$schema` marker
(`https://json-schema.org/draft/2020-12/schema`) exactly as captured.
The tool literals were generated programmatically from
`harness/fixtures/leonidalab-tools-original.json` by the script at
`/tmp/laneb3-rumorcheck-scratch/gen.py` (parse + re-serialise,
placeholder substitution into `src/forward.ts` from the template in
the same scratch dir) — never retyped — and a post-generation check
(the registration-integrity test suite, plus the parity harness)
confirmed the served literals deep-equal the fixture's 5 tool
objects, in order. Tools are registered via the MCP SDK low-level
Server API (`ListToolsRequestSchema` / `CallToolRequestSchema`
handlers), not McpServer+zod.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
titles, descriptions, required fields (`check_claim` requires
`query`; `price_in_country` requires `country`; `release_info`,
`compare_editions` and `recent_changes` carry no `required` key)
and property shapes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://leonidalab.com/mcp`.
- Env override `LEONIDALAB_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header) is sent with an
  empty environment, with a `LEONIDALAB_API_KEY`-style variable
  present, and with `AUTHORIZATION` / `API_KEY` / `LEONIDALAB_TOKEN`
  variables present.
- Error rendering `rumorcheck error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3), then node_modules populated with
  `npm ci --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/rumorcheck`.
- Package entries: **128**.
- sha256: `00342312b55fee2b302c75f7110634e234eaf7d9b66726d15da9c972acb71830`
  (re-verified unchanged after the subsequent offline `npm ci`).

## server.json

- Description exactly: "GTA 6 fact base: check claims, release
  info, per-country pricing and editions." — **78 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/rumorcheck:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/rumorcheck"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/rumorcheck`
  and its smoke test asserts the server name `rumorcheck`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **70 tests, 70 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 5
   tools; plus session handling/reuse, env override, the
   no-Authorization-header assertions under every environment,
   verbatim argument forwarding for all five tools and result
   pass-through including upstream isError, SSE parsing, error
   rendering, MCP-layer validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/leonidalab-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/rumorcheck/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/rumorcheck/parity-out` → **verdict PASS, parity 100.0**
   (5/5 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
