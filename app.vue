<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
  title: 'Bitrix24 MCP server',
  meta: [
    { charset: 'UTF-8' },
    { name: 'viewport', content: 'width=device-width,initial-scale=1,minimum-scale=1' },
    {
      name: 'description',
      content:
        'Model Context Protocol server for Bitrix24. Gives AI assistants access to tasks, deals, contacts, and more — through a single Bearer-protected /mcp endpoint.',
    },
    { name: 'theme-color', content: '#0382ff' },
  ],
})
</script>

<template>
  <div class="page">
    <main class="hero">
      <svg viewBox="0 0 174 33" xmlns="http://www.w3.org/2000/svg" fill="currentColor" class="logo" role="img" aria-label="Bitrix24">
        <path d="M 0 27.1L 18.7 27.1L 18.7 23L 6.3 23C 8 16.2 18.4 14.7 18.4 7.1C 18.4 3 15.6 0 9.8 0C 6.1 0 3 1.1 0.8 2.2L 2.1 6C 4.1 5.1 6.3 4.2 9 4.2C 11.2 4.2 13.2 5.1 13.2 7.6C 13.3 13.2 1.1 13.6 0 27.1Z" transform="translate(106.8 5.3)" />
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

      <h1 class="kicker">MCP server</h1>

      <p class="lede">
        Model Context Protocol server for Bitrix24. Gives AI assistants access
        to tasks, deals, contacts, and more — through a single Bearer-protected
        <code>/mcp</code> endpoint.
      </p>

      <nav class="links" aria-label="Project links">
        <a
          class="link link--primary"
          href="https://github.com/bitrix24/templates-mcp"
          target="_blank"
          rel="noopener noreferrer"
        >
          README on GitHub
          <span class="sr-only">(opens in new tab)</span>
        </a>
        <a class="link" href="/api/health" aria-label="Check server health at /api/health">/api/health</a>
      </nav>
    </main>

    <footer class="footer">MIT &middot; Pre-release &middot; bitrix24/templates-mcp</footer>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  color: #f3f9ff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: #0382ff linear-gradient(162deg, #34e9c0 0.21%, #0382ff 58.71%) fixed;
}

.hero {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
}

.logo {
  width: min(56vw, 280px);
  height: auto;
  margin-bottom: 28px;
  color: #ffffff;
}

.kicker {
  margin: 0 0 18px;
  font-size: 13px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-weight: 600;
  opacity: 0.78;
}

.lede {
  margin: 0 0 32px;
  font-size: 17px;
  line-height: 1.6;
  opacity: 0.92;
}
.lede code {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 14px;
  background: rgba(0, 0, 0, 0.22);
  padding: 2px 8px;
  border-radius: 6px;
}

.links {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: center;
}

.link {
  display: inline-block;
  padding: 12px 22px;
  border-radius: 10px;
  font-size: 14.5px;
  font-weight: 500;
  text-decoration: none;
  border: 1px solid rgba(255, 255, 255, 0.32);
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
  transition: background 0.15s ease, transform 0.15s ease;
}
.link:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}
.link--primary {
  background: #ffffff;
  color: #0382ff;
  border-color: transparent;
}
.link--primary:hover {
  background: #f0f7ff;
}

.footer {
  padding: 22px 24px 28px;
  text-align: center;
  font-size: 13px;
  opacity: 0.7;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
