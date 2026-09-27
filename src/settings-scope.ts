/**
 * Settings plumbing that works across the dsh 0.1.6 → 0.1.7-rc.2 boundary.
 *
 * dsh 0.1.7-rc.2 removed `ctx.settings.register` (the SettingsForms service now
 * only exposes `configure()`). Plugin configuration moved to a module-level
 * `Config` export: the loader resolves the schema and passes the parsed value
 * as the second argument of `apply(ctx, config)`, and edits flow through
 * `ctx.fiber.update(config)` / the `internal/update` waterfall, persisting
 * into the profile's `cordis.patch.yml`.
 *
 * This module adapts both worlds behind one `SettingsScope`-shaped object so
 * the rest of the plugin never learns which host it is running on:
 *
 * - On dsh >= 0.1.7 (no `ctx.settings.register`) it owns the value locally,
 *   seeds it from the `apply` config argument, and mirrors writes back with
 *   `ctx.fiber.update`.
 * - On dsh <= 0.1.6 it delegates to the live settings namespace exactly as
 *   before.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { studioConfigSchema } from './config.ts'
import type { StudioConfig } from './shared.ts'

/** Minimal shape of the live settings scope the plugin needs. */
export type StudioScope = {
  /** Read the current configuration value. */
  get(): StudioConfig
  /** Replace the configuration value (legacy API writes through the namespace). */
  replace(next: StudioConfig): Promise<void>
  /** Subscribe to value changes; the disposer removes the subscription. */
  watch(callback: (next: StudioConfig) => void): () => void
  /** Monotonic revision for optimistic concurrency on the HTTP route. */
  revision: number
}

interface LegacySettingsHost {
  register(
    namespace: string,
    schema: unknown,
    options: { applies: 'live' },
  ): SettingsScope<StudioConfig>
}

/** Whether this host still exposes the pre-0.1.7 live settings namespace API. */
export function hasLegacySettingsHost(ctx: Context): boolean {
  return typeof (ctx as unknown as { settings?: LegacySettingsHost }).settings?.register === 'function'
}

/** Build the plugin's settings scope for this host generation. */
export async function createStudioScope(
  ctx: Context,
  liveConfig: StudioConfig | undefined,
): Promise<StudioScope> {
  if (hasLegacySettingsHost(ctx)) {
    const settings = (ctx as unknown as { settings: LegacySettingsHost }).settings
    const scope = settings.register('prompt-studio', studioConfigSchema, { applies: 'live' })
    return scope as unknown as StudioScope
  }

  // dsh >= 0.1.7-rc.2: the value comes from the plugin Config export.
  const initial = studioConfigSchema['~standard'].validate(liveConfig ?? {})
  const value = (initial && 'value' in initial ? initial.value : liveConfig ?? {}) as StudioConfig
  let current: StudioConfig = {
    components: (value.components ?? []).map(component => ({ ...component })),
  }
  const watchers = new Set<(next: StudioConfig) => void>()
  const scope: StudioScope = {
    revision: 0,
    get(): StudioConfig {
      return current
    },
    watch(callback: (next: StudioConfig) => void): () => void {
      watchers.add(callback)
      return () => { watchers.delete(callback) }
    },
    async replace(next: StudioConfig): Promise<void> {
      const components = (next.components ?? []).map(component => ({ ...component }))
      scope.revision += 1
      current = { components }
      for (const callback of [...watchers]) callback({ components })
      // Persist through the loader's config-update waterfall; rc.2 writes the
      // plugin entry's `config` back into the profile patch.
      const fiber = (ctx as unknown as { fiber?: { update?: (config: unknown) => void } }).fiber
      await fiber?.update?.({ components })
    },
  }
  return scope
}
