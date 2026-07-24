import type { KuroCommunityRole } from '../../shared/contracts'

export function kuroRoleKey(
  role: Pick<KuroCommunityRole, 'serverId' | 'roleId'>
): string {
  return JSON.stringify([role.serverId, role.roleId])
}
