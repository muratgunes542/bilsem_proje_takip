import { describe, expect, it } from 'vitest'
import {
  canCreateProject,
  canManageAllRecords,
  canModifyAuditLog,
  canModifyProject,
  canRestoreProject,
  type AuthenticatedUser,
} from '../server/authorization'

const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
const owner: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }
const otherTeacher: AuthenticatedUser = { id: 'teacher-2', role: 'TEACHER', isActive: true }

describe('project authorization', () => {
  it('allows admins to manage every active record', () => {
    expect(canManageAllRecords(admin)).toBe(true)
    expect(canModifyProject(admin, { createdBy: owner.id, deletedAt: null })).toBe(true)
    expect(canRestoreProject(admin)).toBe(true)
  })

  it('allows a teacher to modify only projects they created', () => {
    const project = { createdBy: owner.id, deletedAt: null }
    expect(canModifyProject(owner, project)).toBe(true)
    expect(canModifyProject(otherTeacher, project)).toBe(false)
  })

  it('blocks modification of soft-deleted projects', () => {
    const deletedProject = { createdBy: owner.id, deletedAt: new Date() }
    expect(canModifyProject(owner, deletedProject)).toBe(false)
    expect(canModifyProject(admin, deletedProject)).toBe(false)
  })

  it('blocks inactive users', () => {
    const inactiveOwner = { ...owner, isActive: false }
    expect(canCreateProject(inactiveOwner)).toBe(false)
    expect(canModifyProject(inactiveOwner, { createdBy: owner.id, deletedAt: null })).toBe(false)
  })

  it('never permits application users to modify audit logs', () => {
    expect(canModifyAuditLog()).toBe(false)
  })
})
