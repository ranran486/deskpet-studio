import type { Permission, PetAction } from '../shared/types.js'

/**
 * 每个动作需要的权限。
 *
 * 声明式触发器、代码插件沙箱、IPC 入口共用同一张表，所以"零代码插件"和"代码插件"
 * 受到的约束完全一致。独立成本模块还有一个好处：权限模型可以脱离 Electron 被单测
 * （见 tools/selftest.mjs）。
 */
export const ACTION_PERMISSION: Record<PetAction['type'], Permission | null> = {
  'pet.speak': 'pet:speak',
  'pet.react': 'pet:react',
  'pet.setState': 'pet:state',
  'pet.skin': 'pet:skin',
  'pet.move': 'pet:move',
  'bubble.hide': 'bubble',
  notify: 'notify',
  'storage.set': 'storage',
  'storage.inc': 'storage',
  log: null,
  run: null,
  'chat.ask': 'chat',
}

export interface PermissionViolation {
  action: PetAction['type']
  required: Permission
}

/** 静态检查：这批动作里哪些会被权限表拒绝 */
export function checkActions(actions: PetAction[], permissions: readonly Permission[]): PermissionViolation[] {
  const granted = new Set(permissions)
  const violations: PermissionViolation[] = []
  for (const action of actions) {
    const required = ACTION_PERMISSION[action.type]
    if (required && !granted.has(required)) violations.push({ action: action.type, required })
  }
  return violations
}

/** 插件清单里声明了权限、但触发器实际没用到的能力（用于提示"权限开大了"） */
export function unusedPermissions(actions: PetAction[], permissions: readonly Permission[]): Permission[] {
  const used = new Set(actions.map((a) => ACTION_PERMISSION[a.type]).filter(Boolean) as Permission[])
  return permissions.filter((p) => !used.has(p))
}
