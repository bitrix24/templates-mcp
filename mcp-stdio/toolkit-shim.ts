/**
 * esbuild alias target for `@nuxtjs/mcp-toolkit/server` in the stdio bundle.
 *
 * Tool files import `defineMcpTool` from the toolkit. That symbol is a pure
 * passthrough (see the upstream source), but the toolkit's barrel transitively
 * pulls in Nitro cache helpers and Nuxt virtual modules that don't exist in a
 * standalone Node build. This shim re-implements the only symbol the tools
 * actually use, so the bundler never touches the barrel.
 */
export function defineMcpTool<T>(definition: T): T {
  return definition
}
