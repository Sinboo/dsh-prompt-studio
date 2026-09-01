import { access, lstat, mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function dshRootFromEnvironment() {
  return resolve(process.env.DSH_ROOT ?? join(pluginRoot, '..', 'dsh'))
}

async function requirePath(path, description) {
  try {
    await access(path)
  } catch {
    throw new Error(`${description} was not found at ${path}`)
  }
}

async function ensureSymlink(path, target, ownedLinks) {
  try {
    const info = await lstat(path)
    if (!info.isSymbolicLink()) throw new Error(`${path} exists and is not a symbolic link`)
    const current = resolve(dirname(path), await readlink(path))
    if (current !== resolve(target)) throw new Error(`${path} points to ${current}, expected ${target}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(dirname(path), { recursive: true })
    await symlink(relative(dirname(path), target), path, 'dir')
    ownedLinks.push(path)
  }
}

async function prepareLinks(dshRoot) {
  const ownedLinks = []
  // `packages/client/runtime` was removed upstream (0.1.2 client refactor);
  // `ui-chat` carries the same react/@types links the runtime used to provide.
  const clientModules = join(dshRoot, 'packages/client/ui-chat/node_modules')
  let removeNodeModules = false
  try {
    await lstat(join(pluginRoot, 'node_modules'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    removeNodeModules = true
  }
  await ensureSymlink(join(pluginRoot, '.dsh'), dshRoot, ownedLinks)
  // The shared client preset resolves a plugin's `dsh.client` declarations by
  // scanning `packages/*/*/package.json` under the DSH checkout, and its glob
  // does not descend symlinked directories. Materialize a real shim manifest
  // naming this plugin, then remove the whole shim directory afterwards.
  const shimDir = join(dshRoot, 'packages/support/dsh-prompt-studio')
  await mkdir(shimDir, { recursive: true })
  await writeFile(
    join(shimDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-prompt-studio', private: true }, null, 2)}\n`,
  )
  await ensureSymlink(join(pluginRoot, 'node_modules/react'), join(clientModules, 'react'), ownedLinks)
  await ensureSymlink(join(pluginRoot, 'node_modules/@deepseek-ai/schemastery'), join(dshRoot, 'vendor/schemastery'), ownedLinks)
  await ensureSymlink(join(pluginRoot, 'node_modules/@deepseek-ai/cosmokit'), join(dshRoot, 'vendor/cosmokit'), ownedLinks)
  await ensureSymlink(join(pluginRoot, 'node_modules/@types'), join(clientModules, '@types'), ownedLinks)
  await ensureSymlink(join(pluginRoot, 'node_modules/vitest'), join(dshRoot, 'node_modules/vitest'), ownedLinks)
  await ensureSymlink(
    join(pluginRoot, 'node_modules/@testing-library'),
    join(dshRoot, 'node_modules/@testing-library'),
    ownedLinks,
  )
  // Tests import workspace packages by name. Vitest externalizes them to
  // Node, which resolves through this plugin's node_modules; link the set the
  // suites need to their built artifacts inside the DSH checkout.
  const workspacePackages = [
    'dsh-llm',
    'dsh-settings',
    'dsh-session',
    'dsh-system-prompt',
    'dsh-brand',
    'dsh-util-values',
    'dsh-attachment',
    'dsh-invariants',
    'dsh-typert-protocol',
    'dsh-typert-registry',
    'dsh-client-store',
    'dsh-client-ui-slots',
    'dsh-client-ui-renderer',
    'dsh-client-ui-conversation',
    'dsh-client-ui-settings',
  ]
  for (const name of workspacePackages) {
    const target = await resolveWorkspacePackage(dshRoot, name)
    await ensureSymlink(join(pluginRoot, 'node_modules/@deepseek-ai', name), target, ownedLinks)
  }
  return { ownedLinks, removeNodeModules, shimDir }
}

/** Locate one `@deepseek-ai/<name>` workspace package directory under the DSH checkout. */
async function resolveWorkspacePackage(dshRoot, name) {
  const { readdir, readFile: readTextFile } = await import('node:fs/promises')
  const wanted = `@deepseek-ai/${name}`
  for (const group of await readdir(join(dshRoot, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of await readdir(join(group.parentPath ?? join(dshRoot, 'packages', group.name), group.name))) {
      const manifestPath = join(dshRoot, 'packages', group.name, pkg, 'package.json')
      const manifest = await readTextFile(manifestPath, 'utf8').then(JSON.parse, () => null)
      if (manifest?.name === wanted) return join(dshRoot, 'packages', group.name, pkg)
    }
  }
  throw new Error(`${wanted} was not found under ${join(dshRoot, 'packages')}`)
}

async function removeOwnedLinks(ownedLinks, removeNodeModules, shimDir) {
  if (shimDir !== undefined) await rm(shimDir, { recursive: true, force: true })
  for (const path of ownedLinks.reverse()) await rm(path, { force: true })
  if (removeNodeModules) await rm(join(pluginRoot, 'node_modules'), { recursive: true, force: true })
}

export async function withDshEnvironment(task) {
  const dshRoot = dshRootFromEnvironment()
  await requirePath(join(dshRoot, 'packages/client/tsdown.client.ts'), 'DSH client bundle preset')
  await requirePath(join(dshRoot, 'node_modules/.bin/tsdown'), 'DSH tsdown executable')
  await requirePath(join(dshRoot, 'node_modules/.bin/tsc'), 'DSH TypeScript executable')
  const { ownedLinks, removeNodeModules, shimDir } = await prepareLinks(dshRoot)
  try {
    return await task({ dshRoot, pluginRoot })
  } finally {
    await removeOwnedLinks(ownedLinks, removeNodeModules, shimDir)
  }
}

export function run(command, args, cwd = pluginRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`))
    })
  })
}
