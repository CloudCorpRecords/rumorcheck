# rumorcheck

Is that GTA 6 rumour actually true? rumorcheck is a local forwarding client for the hosted Leonida Lab fact-base service: it answers `tools/list` on your own machine from the captured tool definitions and forwards every read to the service, returning the answers exactly as they come back.

Everything here is a published read over one fact base. You can check a single claim about the game — a PC version, 60 FPS, crossplay, map size — and get the closest matching facts back, each tagged official, reported or not announced, with its sources. You can pull the release date and the unlock time for your region, look up what the game costs in one of 63 markets on the PlayStation Store or Xbox Store, compare the Standard and Ultimate editions side by side, and read the dated changelog of what changed. Nothing is submitted, ordered or purchased by any tool in this package; the pricing tool reads published store listings, it does not buy anything. The fact base is unofficial: Leonida Lab is not affiliated with Rockstar Games or Take-Two.

## The tools

- **`check_claim`** — Checks one claim about GTA 6 against the record and returns the closest matches, each with its status (official, reported or not announced), the detail, dated sources and the page; a miss lists the topics that are covered. `query` is required; `limit` (1–10, default 5) caps how many matches come back.
- **`release_info`** — The official release date (November 19, 2026), the announced platforms and the ones not announced, the unlock time in each of 15 regions, and the dates around launch. Pass `place` — a country, region, city or IANA time zone — to get just that region's unlock time; omit it for every region. Each part carries its own status.
- **`price_in_country`** — What a buyer pays for GTA 6 in one of 63 markets, Standard and Ultimate, read from the official PlayStation Store and Xbox Store listings: the checkout price in local currency, its US dollar value at the official exchange rate, and whether tax is inside the price, added at checkout or unconfirmed. `country` (name or two-letter code) is required; `platform` (`playstation` or `xbox`) narrows it to one store.
- **`compare_editions`** — The two editions side by side: US list prices, what each includes, every Ultimate Edition bonus as listed, the pre-order bonus and its deadline, and the Collector's Box. Takes no arguments.
- **`recent_changes`** — Dated changelog entries, newest first: what Rockstar Games, Take-Two or the stores announced, what press reported, and changes to the site itself, each labelled and linked to its source. `since` (YYYY-MM-DD) keeps only entries on or after that date; `limit` (1–30, default 10) caps the count.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/rumorcheck mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "rumorcheck": {
      "command": "npx",
      "args": ["-y", "@reneturcios/rumorcheck", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/rumorcheck
docker run --rm ghcr.io/cloudcorprecords/rumorcheck compare_editions '{}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
rumorcheck check_claim '{"query":"PC version"}'
rumorcheck check_claim '{"query":"60 FPS on PS5 Pro","limit":3}'
rumorcheck release_info '{}'
rumorcheck release_info '{"place":"Tokyo"}'
rumorcheck price_in_country '{"country":"Brazil"}'
rumorcheck price_in_country '{"country":"DE","platform":"xbox"}'
rumorcheck compare_editions '{}'
rumorcheck recent_changes '{"since":"2026-01-01","limit":5}'
rumorcheck --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `LEONIDALAB_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://leonidalab.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The Leonida Lab registry record declares no headers on its remote, so rumorcheck sends no authentication header of any kind — the reads are keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `rumorcheck error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured full surface, exercises the session handshake and its reuse, asserts that no `Authorization` header is sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
