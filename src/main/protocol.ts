import { net, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { log } from './logger.js'
import { safeJoin } from './plugins/manifest.js'
import type { PluginRegistry } from './plugins/registry.js'
import { distRoot } from './window.js'

/**
 * 自定义协议 `deskpet://`。
 *
 * 为什么必须有它：渲染进程用原生 ESM（无打包器），而 file:// 下浏览器按 CORS 规则拒绝
 * 加载 ES module。给渲染层一个标准且安全的源，同时顺便把插件资源也纳入白名单管理：
 *
 *   deskpet://renderer/<file>             → dist/renderer
 *   deskpet://pack/<pluginId>/<relpath>   → 插件目录（safeJoin 防目录穿越）
 */
export const SCHEME = 'deskpet'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** 必须在 app ready 之前调用 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

function resolveRequest(registry: PluginRegistry, url: URL): string | null {
  const host = url.hostname
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!rel) return null
  if (host === 'renderer') {
    // 渲染层若从 src/shared 引入了**运行期常量**（如 DEFAULT_INTERACTION），tsc 会保留这条
    // import，浏览器把相对路径解析成 deskpet://renderer/shared/xxx.js —— 这里映射到 dist/shared。
    // 只放行 shared/ 子树，dist/main 之类不进渲染层。
    if (rel.startsWith('shared/')) {
      const shared = safeJoin(path.join(distRoot, 'shared'), rel.slice('shared/'.length))
      return shared && fs.existsSync(shared) ? shared : null
    }
    const full = safeJoin(path.join(distRoot, 'renderer'), rel)
    return full && fs.existsSync(full) ? full : null
  }
  if (host === 'pack') {
    const [pluginId, ...rest] = rel.split('/')
    const record = registry.get(pluginId)
    if (!record) return null
    const full = safeJoin(record.dir, rest.join('/'))
    return full && fs.existsSync(full) ? full : null
  }
  return null
}

export function installProtocolHandler(registry: PluginRegistry): void {
  protocol.handle(SCHEME, async (request) => {
    let file: string | null = null
    try {
      file = resolveRequest(registry, new URL(request.url))
    } catch (err) {
      log.warn(`协议 URL 解析失败 ${request.url}`, err)
    }
    if (!file) {
      log.warn(`404 ${request.url}`)
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    const type = MIME[path.extname(file).toLowerCase()]
    if (type) headers.set('content-type', type)
    // 渲染层的源是 deskpet://renderer，插件图片在 deskpet://pack —— 跨源读像素做命中判定
    // 需要 CORS 放行，否则 canvas 会被污染、getImageData 抛 SecurityError。
    headers.set('access-control-allow-origin', '*')
    headers.set('cache-control', 'no-cache')
    return new Response(res.body, { status: res.status, headers })
  })
  log.info('deskpet:// 协议已注册')
}
