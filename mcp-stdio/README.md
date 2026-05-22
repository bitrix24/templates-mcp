# bx24-template-mcp — Claude Desktop bundle (DXT)

This directory builds the **local stdio** distribution: a single `.dxt` file that Claude Desktop installs in two clicks, with no server to operate.

## What's in the bundle

- `server/index.mjs` — esbuild-bundled Node entry point, every dependency inlined (`@modelcontextprotocol/sdk`, `@nuxtjs/mcp-toolkit/server`, `@bitrix24/b24jssdk`, zod, …).
- `manifest.json` — DXT manifest. Declares the Node entry point and a `user_config` form with one required field: the Bitrix24 webhook URL.
- `LICENSE` — MIT, same as upstream.

Tool code is the same as the HTTP server — same files in `server/mcp/tools/**`, same util layer. The only stdio-specific code is:

- `nuxt-shims.ts` — synthesises `useRuntimeConfig()` from `process.env` and redirects `console.log`/`info` to **stderr** so they cannot corrupt the JSON-RPC frame stream on stdout.
- `tools.ts` — explicit tool registry (no Nuxt file-based auto-discovery in this build).
- `server.ts` — entry point: `McpServer` + `StdioServerTransport`, tools registered through the same `registerToolFromDefinition` helper Nuxt uses.

## Build

```bash
pnpm install
pnpm build:dxt
# → dist/bx24-template-mcp.dxt
```

Requires Node 22 and a system `zip` binary (`apt install zip` / preinstalled on macOS).

## Install in Claude Desktop

1. Open Claude Desktop → Settings → Extensions.
2. Drag the `.dxt` file onto the window, or click *Install from file*.
3. When prompted, paste your Bitrix24 webhook URL. The URL pattern is:
   - **Cloud:** `https://<portal>.bitrix24.<tld>/rest/<user_id>/<secret>/` — any TLD (`.com` / `.ru` / `.com.br` / `.es` / `.de` / …).
   - **Self-Hosted (on-prem):** `https://<your-internal-host>/rest/<user_id>/<secret>/` — same shape, any domain.
4. Optionally set the GitHub feedback PAT (enables `bx24mcp_submit_feedback`).
5. Enable the extension. Ask the assistant: *"Show me my Bitrix24 current user."*

The webhook secret is stored in Claude Desktop's OS-backed encrypted user_config (macOS Keychain / Windows DPAPI / Linux libsecret); it never leaves the device.

**Self-Hosted with a private CA?** Set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in your shell **before launching Claude Desktop** so the spawned extension process inherits the variable.

**Localised step-by-step guides:**
- 🇷🇺 [`INSTALL.ru.md`](./INSTALL.ru.md)
- 🇧🇷 [`INSTALL.pt-BR.md`](./INSTALL.pt-BR.md)

**Privacy / data residency:** no outbound calls except your Bitrix24 portal and (optionally) the GitHub Issues API. Webhook URL is redacted from every log sink via `makeRedactingLogger`. Full details in the root README's *Data residency, telemetry, LGPD / GDPR* section.

## Local dry-run (without Claude Desktop)

```bash
pnpm build:dxt
NUXT_BITRIX24_WEBHOOK_URL='https://your.bitrix24.com/rest/.../...' \
  node dist/dxt/server/index.mjs
```

The process reads JSON-RPC frames from stdin and writes frames to stdout. Use the [MCP inspector](https://github.com/modelcontextprotocol/inspector) for an interactive harness.

## Adding a new tool

Two registries to keep in sync:

1. The file under `server/mcp/tools/**` (used by the HTTP server via auto-discovery).
2. An explicit import in [`tools.ts`](./tools.ts) (used by the stdio bundle).

A parity check belongs in unit tests so a missing registration fails CI.
