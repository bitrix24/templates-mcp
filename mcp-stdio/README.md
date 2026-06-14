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
3. Choose ONE auth mode and fill in the corresponding `user_config` field:
   - **Webhook (default — works on every build):** paste your Bitrix24 incoming-webhook URL. The pattern is `https://<portal>.bitrix24.<tld>/rest/<user_id>/<secret>/` for Cloud (any TLD — `.com` / `.ru` / `.com.br` / `.es` / `.de` / …) or `https://<your-internal-host>/rest/<user_id>/<secret>/` for Self-Hosted. The secret is stored in Claude Desktop's OS-backed encrypted user_config (macOS Keychain / Windows DPAPI / Linux libsecret).
   - **OAuth (only if this bundle was built with Marketplace credentials — see the [OAuth section](#oauth-mode-oob-code-paste) below):** leave the webhook field empty and set the **Bitrix24 portal host** field to your portal hostname (e.g. `mycompany.bitrix24.com`). On first launch the extension log will show a consent URL; complete the [OOB code-paste flow](#oauth-mode-oob-code-paste).
4. Optionally set the GitHub feedback PAT (enables `bx24mcp_submit_feedback`).
5. Enable the extension. Ask the assistant: *"Show me my Bitrix24 current user."*

## OAuth mode (OOB code-paste)

The upstream Marketplace release of this DXT ships with `BITRIX24_DXT_OAUTH_CLIENT_ID` / `BITRIX24_DXT_OAUTH_CLIENT_SECRET` baked in at build time. Forks rebuild with their own Marketplace app id (`BITRIX24_DXT_OAUTH_CLIENT_ID=… BITRIX24_DXT_OAUTH_CLIENT_SECRET=… pnpm build:dxt`). A build without these secrets is webhook-only — the OAuth path stays gated off at runtime.

When a bundle with baked OAuth credentials sees a `bitrix24_portal_host` user_config value AND no tokens on disk yet, the extension boots in **onboarding mode**:

1. The extension log prints `https://<your-portal>/oauth/authorize/?client_id=...&state=...`. Open it in a browser.
2. Sign in to your Bitrix24 portal and grant consent. Bitrix24 displays a short code on the consent page (TTL ~30 seconds).
3. In Claude, ask the assistant to call `bx24mcp_oauth_paste_code` with the code (e.g. *"complete the Bitrix24 OAuth setup with code XXXXXX"*).
4. The extension exchanges the code for a per-user access/refresh token pair, persists them to `<user-data>/bx24-template-mcp/oauth.json` (file mode 0o600), and switches to **active** mode. Every subsequent tool call acts under the consenting user's Bitrix24 identity and permissions; the SDK silently refreshes the access token on 401.
5. If the refresh token is later revoked on the portal side (operator uninstalls the app), tools return a friendly *"re-onboarding required"* message and `bx24mcp_oauth_paste_code` can be re-run.

Logs and audit are written to the same user-data directory: `audit.log` is JSONL with one entry per oauth.upsert.exchange / .refresh / .fail.* event — same taxonomy as the HTTP server's audit log.

**`client_secret` is in the bundle.** Bitrix24 does not advertise PKCE today, so the `client_secret` for a public client ships inside the `.dxt`. This is the documented OOB trade-off — the secret protects the Marketplace **app identity**, not the user's tokens (those are per-user and live only on the device). Rotation = rebuild + republish; old installs need re-onboarding.

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

## Adding a new tool

Two registries to keep in sync:

1. The file under `server/mcp/tools/**` (used by the HTTP server via auto-discovery).
2. An explicit import in [`tools.ts`](./tools.ts) (used by the stdio bundle).

A parity check belongs in unit tests so a missing registration fails CI.
