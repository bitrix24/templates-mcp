<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
  title: 'Bitrix24 MCP — give your AI a seat at the desk',
  meta: [
    { charset: 'UTF-8' },
    { name: 'viewport', content: 'width=device-width,initial-scale=1,minimum-scale=1' },
    {
      name: 'description',
      content:
        'Production-grade Model Context Protocol server for Bitrix24. Hand your AI assistant the keys to tasks, deals, contacts and checklists — through one Bearer-protected /mcp endpoint.',
    },
    { name: 'theme-color', content: '#0382ff' },
  ],
})

const tools = [
  {
    group: 'Connectivity',
    count: 2,
    items: ['current_user', 'find_user'],
    blurb: 'AI talks in names, not numeric IDs. Resolve operators before every mutation.',
  },
  {
    group: 'Tasks lifecycle',
    count: 11,
    items: ['create', 'list', 'update', 'comment', 'start', 'pause', 'complete', 'approve', 'disapprove', 'defer', 'renew'],
    blurb: 'Full CRUD plus the eleven state transitions Bitrix24 actually has — batched, retried, rate-limited.',
  },
  {
    group: 'Checklists & results',
    count: 8,
    items: ['add_checklist_item', 'list_checklist_items', 'complete_checklist_item', 'renew_checklist_item', 'delete_checklist_item', 'add_task_result', 'list_task_results', 'update_task_result'],
    blurb: 'Checklists as flat trees, free-form outcomes separate from comments — the way operators expect them.',
  },
  {
    group: 'Quality of life',
    count: 3,
    items: ['rate_task', 'delete_task_result', 'submit_feedback'],
    blurb: 'Rate work, retract a result, and let the AI file a structured GitHub issue when something feels off.',
  },
]

const stack = [
  { name: 'Nuxt 4 + Nitro', detail: 'Edge-ready Node server, file-based MCP tool discovery.' },
  { name: '@bitrix24/b24jssdk', detail: 'Official SDK. RestrictionManager handles 50/2-rps burst control + retries.' },
  { name: 'Bearer auth', detail: 'Single token guards /mcp. Health probe stays public for rollback automation.' },
  { name: 'Docker + acme', detail: 'nginx-proxy + acme-companion. Hands-off TLS in production.' },
  { name: 'Three test layers', detail: 'Vitest unit, real-portal integration, Evalite + DeepSeek tool-selection evals.' },
  { name: 'Renovate', detail: 'Dependencies stay current without anyone babysitting them.' },
]

const totalTools = tools.reduce((sum, t) => sum + t.count, 0)
</script>

<template>
  <div class="page">
    <div class="aurora" aria-hidden="true" />

    <header class="topbar">
      <div class="brand">
        <svg viewBox="0 0 174 33" xmlns="http://www.w3.org/2000/svg" fill="currentColor" class="brand__logo" aria-label="Bitrix24">
          <path d="M 3.05176e-06 27.1L 18.7 27.1L 18.7 23L 6.3 23C 8 16.2 18.4 14.7 18.4 7.1C 18.4 3 15.6 0 9.80001 0C 6.10001 0 3 1.1 0.799998 2.2L 2.1 6C 4.1 5.1 6.3 4.2 9 4.2C 11.2 4.2 13.2 5.1 13.2 7.6C 13.3 13.2 1.1 13.6 3.05176e-06 27.1Z" transform="translate(106.8 5.3)" />
          <path d="M 10.4 20.8C 4.7 20.8 0 16.1 0 10.4C 0 4.7 4.7 0 10.4 0C 16.1 0 20.8 4.7 20.8 10.4C 20.8 16.1 16.1 20.8 10.4 20.8ZM 10.4 1.9C 5.7 1.9 1.9 5.7 1.9 10.4C 1.9 15.1 5.7 18.9 10.4 18.9C 15.1 18.9 18.9 15.1 18.9 10.4C 18.9 5.7 15.1 1.9 10.4 1.9Z" transform="translate(152.5 5.9)" />
          <path d="M 6.6 5.2L 1.4 5.2L 1.4 0L 0 0L 0 6.6L 6.6 6.6L 6.6 5.2Z" transform="translate(162.2 11.1)" />
          <path d="M 0 0L 9 0C 15.6 0 18.6 3.8 18.6 7.8C 18.6 10.5 17.3 12.9 14.9 14.2L 14.9 14.3C 18.5 15.2 20.7 18.1 20.7 21.7C 20.7 26.5 17.1 30.8 9.9 30.8L 0 30.8L 0 0ZM 8.3 12.9C 11.4 12.9 13.1 11.2 13.1 8.8C 13.1 6.5 11.6 4.7 8.3 4.7L 5.7 4.7L 5.7 12.9L 8.3 12.9ZM 9.2 26.2C 12.9 26.2 15 24.8 15 21.7C 15 19.1 13 17.5 9.9 17.5L 5.7 17.5L 5.7 26.2L 9.2 26.2Z" transform="translate(0 1.6)" />
          <path d="M 0 3.4C 0 1.5 1.5 0 3.4 0C 5.3 0 6.9 1.4 6.9 3.4C 6.9 5.2 5.4 6.7 3.4 6.7C 1.4 6.7 0 5.3 0 3.4ZM 0.6 10.3L 6.2 10.3L 6.2 32.4L 0.6 32.4L 0.6 10.3Z" transform="translate(24.9 0)" />
          <path d="M 4 23.4L 4 11.1L 0 11.1L 0 6.7L 4 6.7L 4 1.6L 9.6 0L 9.6 6.7L 16.3 6.7L 14.9 11.1L 9.6 11.1L 9.6 22C 9.6 24.1 10.3 24.8 11.8 24.8C 13.1 24.8 14.3 24.3 15.2 23.7L 16.9 27.5C 15.3 28.6 12.6 29.2 10.4 29.2C 6.4 29.3 4 27.1 4 23.4Z" transform="translate(34.6 3.6)" />
          <path d="M 0.1 0.5L 4.8 0.5L 5.4 3C 7.4 1 9.2 0 11.5 0C 12.5 0 13.7 0.3 14.6 0.9L 12.6 5.6C 11.6 5 10.7 4.9 10.1 4.9C 8.6 4.9 7.4 5.5 5.6 7.1L 5.6 22.7L 0 22.7L 0 0.5L 0.1 0.5Z" transform="translate(54.4 9.8)" />
          <path d="M 0 3.4C 0 1.5 1.5 0 3.4 0C 5.3 0 6.8 1.5 6.8 3.4C 6.8 5.2 5.3 6.7 3.3 6.7C 1.3 6.7 0 5.3 0 3.4ZM 0.6 10.3L 6.2 10.3L 6.2 32.4L 0.6 32.4L 0.6 10.3Z" transform="translate(71.2 0)" />
          <path d="M 8.1 11L 0.1 0L 5.9 0L 11.1 7.2L 16.4 0L 22.2 0L 14.1 11L 22.3 22.1L 16.5 22.1L 11.2 14.7L 5.8 22.1L 0 22.1L 8.1 11Z" transform="translate(80.6 10.3)" />
          <path d="M 16.8 16.6L 16.8 0L 13.3 0L 0 17.3L 0 20.6L 12 20.6L 12 27.2L 16.8 27.2L 16.8 20.6L 20.8 20.6L 20.8 16.6L 16.8 16.6ZM 12 12.7L 12 16.5L 8.8 16.5C 7.8 16.5 6 16.6 5.4 16.6L 12.2 7.4C 12.2 8.2 12 10.6 12 12.7Z" transform="translate(126.1 5.3)" />
        </svg>
        <span class="brand__divider" aria-hidden="true">/</span>
        <span class="brand__product">MCP server</span>
      </div>

      <nav class="topbar__nav">
        <a href="https://github.com/bitrix24/templates-mcp" class="link" target="_blank" rel="noopener">GitHub</a>
        <a href="/api/health" class="link" target="_blank" rel="noopener">Health</a>
        <a href="https://github.com/bitrix24/templates-mcp/blob/main/PROJECT-BRIEF.md" class="link" target="_blank" rel="noopener">Brief</a>
      </nav>
    </header>

    <main class="hero">
      <div class="hero__pill">
        <span class="pulse" />
        Phase 2 · MVP shipped · {{ totalTools }} tools live
      </div>

      <h1 class="hero__title">
        Give your AI<br>
        <span class="hero__title--accent">a seat at the Bitrix24 desk.</span>
      </h1>

      <p class="hero__lede">
        A production-grade Model Context Protocol server that turns Claude (and friends)
        into a real teammate inside your portal — creating tasks, chasing deadlines,
        ticking checklists, rating outcomes. One Bearer-protected endpoint. No glue code.
      </p>

      <div class="hero__cta">
        <a class="btn btn--primary" href="https://github.com/bitrix24/templates-mcp" target="_blank" rel="noopener">
          <span>Star on GitHub</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M17 7H8M17 7v9" /></svg>
        </a>
        <a class="btn btn--ghost" href="https://github.com/bitrix24/templates-mcp/blob/main/README.md#connecting-claude" target="_blank" rel="noopener">
          Connect Claude in 5 steps
        </a>
      </div>

      <dl class="stats" aria-label="Project highlights">
        <div>
          <dt>{{ totalTools }}</dt>
          <dd>MCP tools shipped</dd>
        </div>
        <div>
          <dt>1</dt>
          <dd>Bearer endpoint to secure</dd>
        </div>
        <div>
          <dt>50 / 2</dt>
          <dd>Burst / steady RPS handled</dd>
        </div>
        <div>
          <dt>3×</dt>
          <dd>Test layers — unit, real-portal, evals</dd>
        </div>
      </dl>
    </main>

    <section class="endpoints">
      <h2 class="section__title">Endpoints, at a glance</h2>
      <div class="endpoints__grid">
        <article class="card card--endpoint">
          <header>
            <span class="tag tag--auth">Bearer</span>
            <code>POST /mcp</code>
          </header>
          <p>Speak MCP. Auto-discovers every tool in <code>server/mcp/tools/</code>. Pair with <code>Authorization: Bearer …</code>.</p>
        </article>
        <article class="card card--endpoint">
          <header>
            <span class="tag tag--public">Public</span>
            <code>GET /api/health</code>
          </header>
          <p>Stable shape: <code>{ status, service, version, timestamp }</code>. The deploy workflow polls it to decide on rollback.</p>
        </article>
        <article class="card card--endpoint">
          <header>
            <span class="tag tag--devtools">DevTools</span>
            <code>MCP Inspector</code>
          </header>
          <p>Run <code>pnpm dev</code>, open Nuxt DevTools, click the MCP tab — debug every tool interactively without a client.</p>
        </article>
      </div>
    </section>

    <section class="tools">
      <h2 class="section__title">{{ totalTools }} tools, four jobs to be done</h2>
      <p class="section__lede">
        Every tool is a thin, named verb — what an operator would actually ask for.
        No leaky abstractions, no <em>generic “query” endpoint</em>, no UPPERCASE Bitrix24 jargon
        crossing the AI boundary unless the user wanted it there.
      </p>
      <div class="tools__grid">
        <article v-for="g in tools" :key="g.group" class="card card--tool">
          <header class="card__head">
            <h3>{{ g.group }}</h3>
            <span class="count">{{ g.count }}</span>
          </header>
          <p class="card__blurb">{{ g.blurb }}</p>
          <ul class="card__chips">
            <li v-for="t in g.items" :key="t">
              <code>{{ t }}</code>
            </li>
          </ul>
        </article>
      </div>
    </section>

    <section class="stack">
      <h2 class="section__title">Built like the production system it wants to be</h2>
      <div class="stack__grid">
        <article v-for="s in stack" :key="s.name" class="card card--stack">
          <h3>{{ s.name }}</h3>
          <p>{{ s.detail }}</p>
        </article>
      </div>
    </section>

    <section class="quickstart">
      <h2 class="section__title">From clone to first AI-driven task — three minutes</h2>
      <ol class="quickstart__steps">
        <li>
          <span class="step__num">1</span>
          <div>
            <h3>Clone &amp; configure</h3>
            <pre><code>git clone https://github.com/bitrix24/templates-mcp.git
cd templates-mcp &amp;&amp; cp .env.example .env</code></pre>
            <p>Fill in <code>NUXT_BITRIX24_WEBHOOK_URL</code> and pick a strong <code>NUXT_MCP_AUTH_TOKEN</code>.</p>
          </div>
        </li>
        <li>
          <span class="step__num">2</span>
          <div>
            <h3>Boot the server</h3>
            <pre><code>pnpm install &amp;&amp; pnpm dev</code></pre>
            <p>Health check: <code>curl http://localhost:3000/api/health</code> should return <code>status: ok</code>.</p>
          </div>
        </li>
        <li>
          <span class="step__num">3</span>
          <div>
            <h3>Wire up Claude</h3>
            <p>
              Claude.ai → <em>Settings → Connectors → Add custom connector</em> →
              URL <code>https://your-host/mcp</code>, header <code>Authorization: Bearer …</code>.
              Ask Claude “Show me my Bitrix24 current user”. Done.
            </p>
          </div>
        </li>
      </ol>
    </section>

    <footer class="footer">
      <p>
        MIT licensed. Built on the official
        <a href="https://bitrix24.github.io/b24jssdk/" target="_blank" rel="noopener">Bitrix24 JS SDK</a>,
        <a href="https://nuxt.com/" target="_blank" rel="noopener">Nuxt 4</a> and
        <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener">Model Context Protocol</a>.
      </p>
      <p class="footer__small">
        Feedback travels both ways — the AI itself can file a structured issue via the
        <code>bx24mcp_submit_feedback</code> meta-tool.
      </p>
    </footer>
  </div>
</template>

<style scoped>
.page {
  position: relative;
  min-height: 100vh;
  color: #f3f9ff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: #0382ff linear-gradient(162deg, #34e9c0 0.21%, #0382ff 58.71%) fixed;
  overflow-x: hidden;
}

.aurora {
  position: fixed;
  inset: -20% -10%;
  pointer-events: none;
  background:
    radial-gradient(40% 35% at 12% 18%, rgba(52, 233, 192, 0.55), transparent 70%),
    radial-gradient(35% 30% at 88% 10%, rgba(255, 255, 255, 0.18), transparent 70%),
    radial-gradient(45% 40% at 75% 90%, rgba(3, 130, 255, 0.65), transparent 70%);
  filter: blur(30px);
  z-index: 0;
}

.page > *:not(.aurora) {
  position: relative;
  z-index: 1;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 28px clamp(20px, 5vw, 64px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
  color: #ffffff;
}
.brand__logo { width: 128px; height: auto; }
.brand__divider { opacity: 0.4; font-weight: 300; }
.brand__product {
  font-size: 13px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  opacity: 0.85;
}

.topbar__nav { display: flex; gap: 22px; }
.link {
  color: #ffffff;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  opacity: 0.82;
  transition: opacity 0.2s ease;
}
.link:hover { opacity: 1; }

.hero {
  max-width: 1080px;
  margin: 0 auto;
  padding: clamp(40px, 8vw, 96px) clamp(20px, 5vw, 64px) clamp(64px, 10vw, 120px);
}

.hero__pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #34e9c0;
  box-shadow: 0 0 0 0 rgba(52, 233, 192, 0.7);
  animation: pulse 2.2s ease-out infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(52, 233, 192, 0.7); }
  70% { box-shadow: 0 0 0 12px rgba(52, 233, 192, 0); }
  100% { box-shadow: 0 0 0 0 rgba(52, 233, 192, 0); }
}

.hero__title {
  margin: 28px 0 22px;
  font-size: clamp(40px, 6vw, 72px);
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.hero__title--accent {
  background: linear-gradient(96deg, #ffffff 8%, #34e9c0 75%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero__lede {
  max-width: 720px;
  font-size: clamp(16px, 1.4vw, 19px);
  line-height: 1.6;
  opacity: 0.92;
  margin: 0 0 36px;
}

.hero__cta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 56px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 14px 22px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.btn--primary {
  background: #ffffff;
  color: #0382ff;
  box-shadow: 0 12px 30px rgba(3, 130, 255, 0.35);
}
.btn--primary:hover { transform: translateY(-1px); box-shadow: 0 16px 38px rgba(3, 130, 255, 0.45); }
.btn--ghost {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.3);
  backdrop-filter: blur(8px);
}
.btn--ghost:hover { background: rgba(255, 255, 255, 0.18); }

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 28px 36px;
  margin: 0;
  padding: 28px 0 0;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
}
.stats > div { display: flex; flex-direction: column; gap: 6px; }
.stats dt {
  font-size: clamp(28px, 3.5vw, 40px);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.stats dd {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.78;
}

.section__title {
  font-size: clamp(26px, 3vw, 36px);
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 18px;
}
.section__lede {
  max-width: 720px;
  font-size: 16px;
  line-height: 1.6;
  opacity: 0.88;
  margin: 0 0 36px;
}
.section__lede em { font-style: italic; opacity: 0.7; }

.endpoints,
.tools,
.stack,
.quickstart {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 clamp(20px, 5vw, 64px) clamp(60px, 8vw, 96px);
}

.endpoints__grid,
.tools__grid,
.stack__grid {
  display: grid;
  gap: 20px;
}
.endpoints__grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.tools__grid { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.stack__grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }

.card {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 18px;
  padding: 22px 22px 20px;
  backdrop-filter: blur(14px);
  transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}
.card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.32);
  background: rgba(255, 255, 255, 0.12);
}
.card header,
.card__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.card h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.005em;
}
.card p {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.55;
  opacity: 0.86;
}
.card code {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.22);
  padding: 2px 8px;
  border-radius: 6px;
}

.tag {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 4px 8px;
  border-radius: 6px;
}
.tag--auth { background: rgba(255, 200, 80, 0.22); color: #ffdc8a; }
.tag--public { background: rgba(52, 233, 192, 0.22); color: #b6f5e1; }
.tag--devtools { background: rgba(255, 255, 255, 0.18); color: #ffffff; }

.count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  font-size: 12px;
  font-weight: 700;
}

.card__blurb { margin-bottom: 14px; }
.card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.card__chips li code {
  font-size: 11.5px;
  padding: 3px 8px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.quickstart__steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 22px;
}
.quickstart__steps li {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 22px;
  align-items: start;
  padding: 22px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 18px;
  backdrop-filter: blur(14px);
}
.step__num {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  font-weight: 700;
}
.quickstart h3 {
  margin: 4px 0 10px;
  font-size: 17px;
  font-weight: 600;
}
.quickstart pre {
  margin: 0 0 12px;
  padding: 14px 16px;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow-x: auto;
}
.quickstart pre code {
  background: transparent;
  padding: 0;
  font-size: 13px;
  line-height: 1.55;
  color: #d6f0ff;
}
.quickstart p {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.55;
  opacity: 0.86;
}

.footer {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 clamp(20px, 5vw, 64px) 64px;
  border-top: 1px solid rgba(255, 255, 255, 0.16);
  padding-top: 36px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.footer p { margin: 0; font-size: 14px; opacity: 0.84; line-height: 1.55; }
.footer a { color: #ffffff; text-decoration: underline; text-underline-offset: 3px; }
.footer__small { opacity: 0.68; font-size: 13px; }

@media (max-width: 640px) {
  .topbar { flex-direction: column; gap: 14px; align-items: flex-start; }
  .topbar__nav { gap: 16px; }
  .quickstart__steps li { grid-template-columns: 1fr; }
  .step__num { width: 40px; height: 40px; }
}
</style>
