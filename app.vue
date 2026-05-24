<script setup lang="ts">
import { GitHubIcon } from '@bitrix24/b24icons-vue/social'
import { HeartIcon } from '@bitrix24/b24icons-vue/solid'
import { EncloseTextInCodeTagIcon } from '@bitrix24/b24icons-vue/editor'

// Kept as a JS string (not inline slot text) so the line breaks survive
// Vue's template-whitespace collapse and land verbatim in the clipboard /
// Cursor / Windsurf deeplink that ProsePrompt builds from the slot.
const firstToolPrompt = `You're connected to my Bitrix24 portal via this MCP. Pull the risk picture for my team right now. No questions, no permissions — call the tools and ship the report.

1. **Overdue or imminent tasks** — every task with deadline within the next 48 hours OR already overdue, status not "Completed (5)". Use \`b24_task_list\` with \`{ filter: { "<=deadline": "<ISO 48h from now>", "!status": 5 } }\`. Resolve each \`responsibleId\` to a name once via \`b24_user_find\`. Columns: title, deadline, days_overdue (negative if upcoming), responsible.

2. **Stalled active tasks** — every task still open (status not Completed (5)) with no activity in the last 14 days. Use \`b24_task_list\` with \`{ filter: { "!status": 5, "<activityDate": "<ISO 14 days ago>" }, order: { activityDate: "asc" } }\` so the stalest come first. Page size is fixed at 50 — call once. Reuse the name cache from step 1; resolve any new \`responsibleId\` via \`b24_user_find\`. Columns: title, status, responsible, days_idle.

3. **Headline** — total count for each list and the single oldest item in each, with the responsible person's name.

Output: one markdown report. Three headline sentences on top, then two tables. No commentary, no caveats, no "let me know if you'd like more detail". The reader is a manager who'll forward this to me with red ink on whatever's missing — so just the data.`

useHead({
  htmlAttrs: { lang: 'en' },
  title: 'Bitrix24 MCP server template',
  meta: [
    { charset: 'UTF-8' },
    { name: 'viewport', content: 'width=device-width,initial-scale=1,minimum-scale=1' },
    {
      name: 'description',
      content:
        'A starter template for building Model Context Protocol servers on Bitrix24. Ships example tools for tasks and users — plus the auth, throttling, and test scaffolding to fork and extend with your own.',
    },
    { name: 'theme-color', content: '#0382ff' },
  ],
})
</script>

<template>
  <B24App>
    <!-- edge-dark: b24ui dark-surface token — keeps b24ui components in their dark variant -->
    <div class="edge-dark bx-brand-splash min-h-screen flex flex-col font-sans">
      <main class="flex-1 flex flex-col items-center justify-center py-12 px-6 text-center max-w-[940px] w-full mx-auto">
        <svg viewBox="0 0 174 33" xmlns="http://www.w3.org/2000/svg" fill="currentColor" class="w-[min(56vw,280px)] h-auto mb-7 text-white" role="img" aria-label="Bitrix24">
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

        <h1 class="m-0 mb-1.5 text-[13px] tracking-[0.22em] uppercase font-semibold opacity-[0.92]">MCP server template</h1>
        <p class="m-0 mb-[22px] text-[13px] opacity-[0.92]">An official starter by the Bitrix24 team</p>

        <p class="m-0 mb-8 text-[17px] leading-[1.6] opacity-[0.96]">
          A starter template for building <a class="text-inherit no-underline border-b border-white/50 transition-[border-color] duration-150 hover:border-white/[0.95] focus-visible:border-white/[0.95]" href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">Model Context Protocol</a>
          servers on Bitrix24. Ships example tools for tasks and users — plus the
          auth, throttling, and test scaffolding to fork and extend with your own.
        </p>

        <nav class="flex gap-[14px] flex-wrap justify-center" aria-label="Project links">
          <B24Button
            :icon="GitHubIcon"
            :b24ui="{ baseLine: '[--ui-btn-icon-size:20px] gap-1.5' }"
            color="air-secondary-no-accent"
            size="md"
            to="https://github.com/bitrix24/templates-mcp"
            target="_blank"
            rel="noopener noreferrer"
          >
            README on GitHub
            <span class="sr-only">(opens in new tab)</span>
          </B24Button>
          <B24Button
            :icon="HeartIcon"
            color="air-secondary-no-accent"
            size="md"
            to="/api/health"
            target="_blank"
            rel="noopener noreferrer"
          >
            /api/health
            <span class="sr-only">(opens in new tab)</span>
          </B24Button>
        </nav>

        <div class="w-full mt-10 text-left">
          <p class="m-0 mb-2.5 text-[13px] opacity-[0.92] text-center">Try it on your portal — paste this into Claude, Cursor, Windsurf, or your IDE:</p>
          <ProsePrompt
            description="Show me what needs attention across my portal — right now"
            :actions="['copy', 'cursor', 'windsurf']"
            :icon="EncloseTextInCodeTagIcon"
          >{{ firstToolPrompt }}</ProsePrompt>
          <p class="mt-2.5 mb-0 text-xs opacity-[0.82] text-center">
            Using VS Code? See the
            <a
              class="text-inherit no-underline border-b border-white/40 transition-[border-color] duration-150 hover:border-white/90 focus-visible:border-white/90"
              href="https://docs.continue.dev/customize/deep-dives/mcp"
              target="_blank"
              rel="noopener noreferrer"
            >Continue.dev MCP setup</a>.
          </p>
        </div>
      </main>

      <footer class="pt-[22px] pb-7 px-6 text-center text-[13px] opacity-[0.92]">
        <a
          class="footer-link"
          href="https://github.com/bitrix24/templates-mcp/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
        >MIT</a>
        <span class="mx-2" aria-hidden="true">&middot;</span>
        <a
          class="footer-link"
          href="https://github.com/bitrix24/templates-mcp/releases"
          target="_blank"
          rel="noopener noreferrer"
        >v0.1.0-alpha.1</a>
        <span class="mx-2" aria-hidden="true">&middot;</span>
        <a
          class="footer-link"
          href="https://github.com/bitrix24/templates-mcp"
          target="_blank"
          rel="noopener noreferrer"
        >bitrix24/templates-mcp</a>
      </footer>
    </div>
  </B24App>
</template>
