# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Leonida Lab GTA 6 fact-base MCP server. All five captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `check_claim`, `release_info`, `price_in_country`, `compare_editions`, `recent_changes` — the full captured surface, 5 of 5 tools. All five are reads over published data; nothing is submitted or purchased.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `rumorcheck error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LEONIDALAB_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
