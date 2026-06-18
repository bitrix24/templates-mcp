# Reverse-proxy variants for production

`Last reviewed: 2026-06-16`

The shipped `docker-compose.yml` assumes the [`nginx-proxy`](https://github.com/nginx-proxy/nginx-proxy) + [`acme-companion`](https://github.com/nginx-proxy/acme-companion) duo. That works, but it's a **specific shop's taste** — not the default in most regions:

- **BR / LatAm hosting (Hostinger, KingHost, HostGator, AWS São Paulo)** — `certbot + plain nginx` or Caddy.
- **EU / US SMB (Hetzner, DO, Linode)** — Caddy or Traefik, occasionally plain nginx.
- **RU / CIS VPS (Selectel, Timeweb, Beget, Reg.ru)** — plain nginx + certbot, sometimes Caddy.

This guide shows three idiomatic alternatives. Pick one — they are mutually exclusive at the host level (only one process can hold port 443).

In every case the application stack itself is `docker-compose.example.yml` (single-host compose, no `proxy-net`, no `VIRTUAL_HOST` magic). Set the four `NUXT_*` env vars in `.env` and run:

```bash
docker compose -f docker-compose.example.yml up -d
```

The container now listens on host `:3000`. The proxy in front of it terminates TLS and forwards.

---

## 1. Caddy (recommended — least moving parts)

Caddy auto-fetches Let's Encrypt certs from a single config file. No companion container, no DNS-01 ceremony — works for HTTP-01 out of the box.

`/etc/caddy/Caddyfile`:

```caddy
prod.example.com {
    encode gzip
    reverse_proxy localhost:3000
}
```

Install (`apt install caddy` on Debian/Ubuntu, `brew install caddy` on macOS). Reload: `sudo systemctl reload caddy`. That's it — cert provisions on first request, auto-renews. Logs in `/var/log/caddy/`.

---

## 2. plain nginx + certbot

The most common LatAm / RU stack. Two-step bootstrap: certbot fetches a cert, nginx serves the proxy.

`/etc/nginx/sites-available/bx24-mcp.conf`:

```nginx
server {
    listen 80;
    server_name prod.example.com;
    # certbot writes ACME challenges here:
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name prod.example.com;

    ssl_certificate     /etc/letsencrypt/live/prod.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/prod.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # MCP Streamable HTTP needs long-lived responses
        proxy_read_timeout 300s;
        proxy_buffering    off;
    }
}
```

Bootstrap:

```bash
sudo ln -s /etc/nginx/sites-available/bx24-mcp.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d prod.example.com
sudo systemctl reload nginx
```

Cert renews via the certbot systemd timer that ships with the package.

---

## 3. Traefik

If you already run Traefik for other services, drop the container onto the `traefik-net` network and let labels do the work. Add to `docker-compose.example.yml` under `bx24-template-mcp:`:

```yaml
    networks: [traefik-net]
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.bx24.rule=Host(`prod.example.com`)'
      - 'traefik.http.routers.bx24.entrypoints=websecure'
      - 'traefik.http.routers.bx24.tls.certresolver=le'
      - 'traefik.http.services.bx24.loadbalancer.server.port=3000'

networks:
  traefik-net:
    external: true
```

Remove the `ports:` block — Traefik talks to the container over the shared network, no host port mapping needed.

---

## Self-hosted Bitrix24 portals on a private CA

If the **upstream** Bitrix24 you're calling (not the proxy in front of this MCP server) uses a private/self-signed cert, the MCP container needs to trust that CA. Mount the bundle and set `NODE_EXTRA_CA_CERTS` — both already wired in `docker-compose.example.yml`. Uncomment the `volumes:` block, point it at your `.pem`, and set `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/bitrix-internal-ca.pem` in `.env`.

This is independent of the TLS terminator above — your reverse proxy still gets a public Let's Encrypt cert, the private CA only matters for the outbound webhook leg.

---

## Why the shipped `docker-compose.yml` picks nginx-proxy

It pairs cleanly with the existing GitHub Actions deploy flow: `nginx-proxy` and `acme-companion` are already running on the production host as separate containers on `proxy-net`, so a new service "just appears" once it sets `VIRTUAL_HOST` / `LETSENCRYPT_HOST` env vars. Zero proxy reconfiguration per deploy. For a single-product host that's overkill; for a host with five products, it pays off.

If you have a single product, use one of the three options above instead.

---

## Hardening: deny `/api/oauth/` on webhook-only deploys

If `NUXT_BITRIX24_OAUTH_ENABLED=false` (the default — most operators run webhook-only) **and you know you will never flip the flag on this host**, block `/api/oauth/*` at the reverse-proxy layer. The application already returns `503 FLAG-OFF` for every OAuth route before any DB op (Nitro plugin + h3 middleware + `useTokenStore` all gate on the flag — see [`docs/SECURITY.md`](./SECURITY.md) → "OAuth surface inertness"). This is **defence-in-depth**: a hostile probe never reaches the Node.js process at all, log noise drops, and a future regression that exposes a route by accident is masked at the proxy.

**Remove the block before flipping `NUXT_BITRIX24_OAUTH_ENABLED=true`** — otherwise `/api/oauth/install` returns 403 instead of rendering the consent flow.

The repo ships a ready snippet at [`nginx/vhost.d/oauth-deny.conf.example`](../nginx/vhost.d/oauth-deny.conf.example):

```nginx
location /api/oauth/ {
  return 403;
  access_log off;
}
```

Pick the recipe matching your reverse-proxy stack:

### Plain nginx (Section 2 above)

Paste the `location /api/oauth/ { … }` block inside the existing `server { … }` that listens on 443, alongside the other `location /` block. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### `nginx-proxy` + acme-companion (the shipped `docker-compose.server.yml` default)

Per-vhost snippets live in the **`vhost` named volume** under `/etc/nginx/vhost.d/<your-host>_location`. Copy the example file into the running container and reload — no compose change needed:

```bash
# Adapt <your-host> to your actual VIRTUAL_HOST (e.g. `prod.example.com`).
HOST=prod.example.com

# Copy the snippet into the nginx-proxy named volume's per-vhost location dir.
docker cp nginx/vhost.d/oauth-deny.conf.example \
  nginx-proxy:/etc/nginx/vhost.d/${HOST}_location

# Reload — no restart, no downtime.
docker exec nginx-proxy nginx -s reload
```

Verify:

```bash
curl -sI https://${HOST}/api/oauth/install | head -1
# → HTTP/2 403   ← the proxy returned 403; the request never touched Node.
```

To remove: `docker exec nginx-proxy rm /etc/nginx/vhost.d/${HOST}_location && docker exec nginx-proxy nginx -s reload`.

### Caddy (Section 1 above)

Add inside the existing `prod.example.com { … }` block, BEFORE the `reverse_proxy` line:

```caddy
prod.example.com {
  encode zstd gzip

  # Deny OAuth surface on webhook-only deploys (defence-in-depth).
  # Remove before flipping NUXT_BITRIX24_OAUTH_ENABLED=true.
  @oauth path /api/oauth/*
  respond @oauth 403

  reverse_proxy localhost:3000
}
```

Then `caddy reload` (or `systemctl reload caddy`).

### Traefik (Section 3 above)

Easiest path is a dedicated higher-priority router with a redirect-to-self middleware that returns 403, or use the [`denyrouter` plugin](https://plugins.traefik.io/). Plain Caddy / nginx are simpler here — pick one of those if you only need this one rule.
