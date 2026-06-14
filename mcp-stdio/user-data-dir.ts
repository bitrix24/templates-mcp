import { mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const APP_DIR_NAME = 'bx24-template-mcp'

/**
 * Cross-platform user-data directory for the DXT bundle.
 *
 *   - macOS:   `~/Library/Application Support/bx24-template-mcp/`
 *   - Linux:   `${XDG_DATA_HOME:-~/.local/share}/bx24-template-mcp/`
 *   - Windows: `${APPDATA:-~/AppData/Roaming}\bx24-template-mcp\`
 *
 * Test override: `NUXT_BITRIX24_DXT_DATA_DIR` (preferred) or
 * `BITRIX24_DXT_DATA_DIR` short the OS lookup and point at a fixture path,
 * so unit tests don't touch the host's real data dir. The shim plumbs this
 * via `runtimeConfig.dxtDataDir`; callers should pass it in explicitly
 * rather than re-reading env here, keeping the function pure.
 *
 * The returned directory is created with mode 0o700 (POSIX) — Windows
 * inherits NTFS default ACLs since `mkdirSync` doesn't honour `mode`
 * there. Tokens themselves live in a 0o600 file inside.
 */
export function getUserDataDir(override?: string): string {
  if (override && override.trim()) {
    const dir = override.trim()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  const home = homedir()
  let base: string
  switch (platform()) {
    case 'darwin':
      base = join(home, 'Library', 'Application Support')
      break
    case 'win32':
      base = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
      break
    default:
      base = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share')
      break
  }
  const dir = join(base, APP_DIR_NAME)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
