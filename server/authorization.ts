import type { UserRole } from './db/schema'

export type AuthenticatedUser = {
  id: string
  role: UserRole
  isActive: boolean
}

export type ProjectOwnership = {
  createdBy: string
  deletedAt: Date | null
}

export function canManageAllRecords(user: AuthenticatedUser): boolean {
  return user.isActive && user.role === 'ADMIN'
}

export function canCreateProject(user: AuthenticatedUser): boolean {
  return user.isActive && (user.role === 'ADMIN' || user.role === 'TEACHER')
}

export function canViewStudents(user: AuthenticatedUser): boolean {
  return user.isActive && (user.role === 'ADMIN' || user.role === 'TEACHER')
}

export function canViewProject(user: AuthenticatedUser, project: ProjectOwnership): boolean {
  if (!user.isActive) return false
  if (project.deletedAt !== null) return user.role === 'ADMIN'
  return user.role === 'ADMIN' || user.role === 'TEACHER'
}

export function canModifyProject(user: AuthenticatedUser, project: ProjectOwnership): boolean {
  if (!user.isActive || project.deletedAt !== null) return false
  return user.role === 'ADMIN' || project.createdBy === user.id
}

export function canRestoreProject(user: AuthenticatedUser): boolean {
  return canManageAllRecords(user)
}

export function canArchiveProject(user: AuthenticatedUser, project: ProjectOwnership): boolean {
  return canModifyProject(user, project)
}

export function canReadNotification(user: AuthenticatedUser, recipientId: string): boolean {
  return user.isActive && user.id === recipientId
}

export function canModifyAuditLog(): false {
  return false
}

export class AuthorizationError extends Error {
  readonly statusCode: 401 | 403

  constructor(message = 'Bu işlem için yetkiniz yok.', statusCode: 401 | 403 = 403) {
    super(message)
    this.name = 'AuthorizationError'
    this.statusCode = statusCode
  }
}

export class ResourceNotFoundError extends Error {
  readonly statusCode = 404
}

export function assertCanModifyProject(user: AuthenticatedUser, project: ProjectOwnership): void {
  if (!canModifyProject(user, project)) throw new AuthorizationError()
}
