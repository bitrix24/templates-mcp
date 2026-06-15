# bx24-template-mcp — Claude Desktop bundle (DXT)

This directory builds the **local stdio** distribution: a single `.dxt` file that Claude Desktop installs in two clicks, with no server to operate.

## What's in the bundle

- `server/index.mjs` — esbuild-bundled Node entry point, every dependency inlined (`@modelcontextprotocol/sdk`, `@nuxtjs/mcp-toolkit/server`, `@bitrix24/b24jssdk`, zod, …).
- `manifest.json` — DXT manifest. Declares the Node entry point and a `user_config` form: webhook URL (webhook mode); portal host + Client ID + Client Secret (OAuth mode); optional GitHub feedback token, repo, and log level. None of the fields are `required: true` at the schema level — the bundle resolves the mode at boot from which fields are filled (`mcp-stdio/auth-mode.ts:resolveAuthMode`); if none, it exits with an instruction printed to stderr.
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
3. Choose ONE auth mode and fill in the corresponding `user_config` fields:
   - **Webhook (default):** paste your Bitrix24 incoming-webhook URL. The pattern is `https://<portal>.bitrix24.<tld>/rest/<user_id>/<secret>/` for Cloud (any TLD — `.com` / `.ru` / `.com.br` / `.es` / `.de` / …) or `https://<your-internal-host>/rest/<user_id>/<secret>/` for Self-Hosted. The secret is stored in Claude Desktop's OS-backed encrypted user_config (macOS Keychain / Windows DPAPI / Linux libsecret).
   - **OAuth:** leave the webhook URL empty and fill **three** OAuth fields — **Bitrix24 portal host** (e.g. `mycompany.bitrix24.com`), **Bitrix24 OAuth Client ID**, and **Bitrix24 OAuth Client Secret**. Get the latter two by registering a Bitrix24 Marketplace application of type *"without `redirect_uri`"* in your partner cabinet. Complete the [OOB code-paste flow](#oauth-mode-oob-code-paste) on first launch.
4. Optionally set the GitHub feedback PAT (enables `bx24mcp_submit_feedback`).
5. Enable the extension. Ask the assistant: *"Show me my Bitrix24 current user."*

## OAuth mode (OOB code-paste)

The OAuth credentials (`CLIENT_ID` + `CLIENT_SECRET`) come from **Claude Desktop's `user_config` block** — paste them into the two extension fields. They are NOT baked into the `.dxt` bundle at build time anymore (#247). One upstream `.dxt` covers both webhook-only and OAuth use cases; the operator picks the mode at install time by which fields they fill.

When a bundle sees a non-empty `bitrix24_portal_host` + `bitrix24_oauth_client_id` + `bitrix24_oauth_client_secret` triple AND no tokens on disk yet, the extension boots in **onboarding mode**:

1. The extension log prints `https://<your-portal>/oauth/authorize/?client_id=...&state=...`. Open it in a browser.
2. Sign in to your Bitrix24 portal and grant consent. Bitrix24 displays a short code on the consent page (TTL ~30 seconds).
3. In Claude, ask the assistant to call `bx24mcp_oauth_paste_code` with the code (e.g. *"complete the Bitrix24 OAuth setup with code XXXXXX"*).
4. The extension exchanges the code for a per-user access/refresh token pair, persists them to `<user-data>/bx24-template-mcp/oauth.json` (file mode 0o600), and switches to **active** mode. Every subsequent tool call acts under the consenting user's Bitrix24 identity and permissions; the SDK silently refreshes the access token on 401.
5. If the refresh token is later revoked on the portal side (operator uninstalls the app), tools return a friendly *"re-onboarding required"* message and `bx24mcp_oauth_paste_code` can be re-run.

Logs and audit are written to the same user-data directory: `audit.log` is JSONL with one entry per oauth.upsert.exchange / .refresh / .fail.* event — same taxonomy as the HTTP server's audit log.

**Credentials live in the OS keychain.** Claude Desktop persists `bitrix24_oauth_client_secret` (`sensitive: true` in the manifest) through the platform-native keychain — macOS Keychain, Windows DPAPI, Linux libsecret. The secret never appears inside the `.dxt` bundle. Rotation = paste a new value into the field, restart the extension; old installs need re-onboarding only if you ALSO revoked the application on the Bitrix24 side. (Bitrix24 doesn't publish a PKCE flow yet, so a long-lived `CLIENT_SECRET` is still required — but it's per-install, not per-build.)

**Self-Hosted with a private CA?** Set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in your shell **before launching Claude Desktop** so the spawned extension process inherits the variable.

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

> **Dev shell-history caveat.** When dry-running OAuth mode (`NUXT_BITRIX24_DXT_OAUTH_CLIENT_SECRET=… node …`), the secret lands in your shell history, `ps auxe`, and `/proc/<pid>/environ` (readable by any process of the same user). For one-off smoke tests it's acceptable, but for repeated dev work use a `.env` file loaded by `direnv` / `dotenv` instead, or set `HISTIGNORE="*OAUTH_CLIENT_SECRET=*"` for your shell. The production Claude Desktop install path doesn't have this exposure — the secret flows through the keychain, never appears on the command line.

## Adding a new tool

Two registries to keep in sync:

1. The file under `server/mcp/tools/**` (used by the HTTP server via auto-discovery).
2. An explicit import in [`tools.ts`](./tools.ts) (used by the stdio bundle).

A parity check belongs in unit tests so a missing registration fails CI.
