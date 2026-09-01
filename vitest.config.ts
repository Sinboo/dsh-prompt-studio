/**
 * Test resolution. The suites import workspace packages by bare name; the
 * tsconfig-paths facade maps them onto source directories, which Vitest
 * cannot import natively. Alias each name onto the package's built entry
 * (or vendor source) inside the linked DSH checkout instead.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dshRoot = realpathSync(fileURLToPath(new URL('.dsh', import.meta.url)))
const pkgEntry = (group: string, pkg: string): string =>
  `${dshRoot}/packages/${group}/${pkg}/lib/index.js`

export default {
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@deepseek-ai/cordis': `${dshRoot}/vendor/cordis/src/index.ts`,
      '@deepseek-ai/schemastery': `${dshRoot}/vendor/schemastery/src/index.ts`,
      '@deepseek-ai/dsh-llm': pkgEntry('llm', 'llm'),
      '@deepseek-ai/dsh-settings': pkgEntry('settings', 'settings'),
      '@deepseek-ai/dsh-session': pkgEntry('core', 'session'),
      '@deepseek-ai/dsh-system-prompt': pkgEntry('core', 'system-prompt'),
      '@deepseek-ai/dsh-brand': pkgEntry('util', 'brand'),
      '@deepseek-ai/dsh-util-values': pkgEntry('util', 'values'),
      '@deepseek-ai/dsh-attachment': pkgEntry('attachment', 'attachment'),
      '@deepseek-ai/dsh-invariants': pkgEntry('runtime-diagnostics', 'invariants'),
      '@deepseek-ai/dsh-typert-protocol': pkgEntry('typert', 'protocol'),
      '@deepseek-ai/dsh-typert-registry': pkgEntry('typert', 'registry'),
      '@deepseek-ai/dsh-client-store': pkgEntry('client', 'store'),
      '@deepseek-ai/dsh-client-ui-slots': pkgEntry('client', 'ui-slots'),
      '@deepseek-ai/dsh-client-ui-renderer/client': pkgEntry('client', 'ui-renderer').replace('lib/index.js', 'lib/client.js'),
      '@deepseek-ai/dsh-client-ui-renderer': pkgEntry('client', 'ui-renderer'),
      '@deepseek-ai/dsh-client-ui-conversation/client': pkgEntry('client', 'ui-conversation').replace('lib/index.js', 'lib/client.js'),
      '@deepseek-ai/dsh-client-ui-conversation': pkgEntry('client', 'ui-conversation'),
      '@deepseek-ai/dsh-client-ui-settings/client': pkgEntry('client', 'ui-settings').replace('lib/index.js', 'lib/client.js'),
      '@deepseek-ai/dsh-client-ui-settings': pkgEntry('client', 'ui-settings'),
    },
  },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
}
