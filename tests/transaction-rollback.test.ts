import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService } from '../server/services/project-service'

describe('Transaction and Rollback Auditing', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'user-admin', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'user-teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'user-teacher-2', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `tx-rollback-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin User', email: 'admin@test.com', role: 'ADMIN' },
      { id: teacher1.id, name: 'Teacher One', email: 'teacher1@test.com', role: 'TEACHER' },
      { id: teacher2.id, name: 'Teacher Two', email: 'teacher2@test.com', role: 'TEACHER' },
    ])

    await db.insert(schema.academicYears).values({
      id: 'year-2024',
      name: '2024-2025',
      startsOn: new Date('2024-09-01'),
      endsOn: new Date('2025-06-30'),
      isCurrent: true,
    })

    await db.insert(schema.students).values([
      { id: 'student-1', bilsemNo: '1001', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 'student-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Demir' },
      { id: 'student-3', bilsemNo: '1003', firstName: 'Mehmet', lastName: 'Kaya' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 'student-1', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-2', studentId: 'student-2', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-3', studentId: 'student-3', academicYearId: 'year-2024', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('rolls back project creation completely when a transaction error occurs', async () => {
    const projectsBefore = await db.select().from(schema.projects)
    const studentsBefore = await db.select().from(schema.projectStudents)

    await expect(projectService.createProject(teacher1, {
      title: 'Failed Project',
      academicYearId: 'year-2024',
      categoryId: 'category-tubitak-2204-a',
      statusId: 'non-existent-status',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })).rejects.toThrow()

    const projectsAfter = await db.select().from(schema.projects)
    const studentsAfter = await db.select().from(schema.projectStudents)
    const auditLogsAfter = await db.select().from(schema.auditLogs)

    expect(projectsAfter.length).toBe(projectsBefore.length)
    expect(studentsAfter.length).toBe(studentsBefore.length)
    expect(auditLogsAfter.length).toBe(0)
  })

  it('rolls back team member attachment when transaction fails', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Alpha Team',
      enrollmentIds: ['enroll-1', 'enroll-2'],
    })

    const initialMembers = await db.select().from(schema.projectStudents).where(eq(schema.projectStudents.projectId, project.projectId))
    expect(initialMembers.length).toBe(2)

    await expect(projectService.addTeamMember(teacher1, project.projectId, 'invalid-enrollment-id')).rejects.toThrow()

    const membersAfterFail = await db.select().from(schema.projectStudents).where(eq(schema.projectStudents.projectId, project.projectId))
    expect(membersAfterFail.length).toBe(2)
  })

  it('rolls back duplicate warning and project creation if duplicate claim/notification insertion fails', async () => {
    await projectService.createProject(teacher1, {
      title: 'First TUBITAK Project',
      academicYearId: 'year-2024',
      categoryId: 'category-tubitak-2204-a',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const projectsCount1 = (await db.select().from(schema.projects)).length

    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.projects).values({
        id: 'project-tx-fail',
        title: 'Second TUBITAK Project',
        academicYearId: 'year-2024',
        categoryId: 'category-tubitak-2204-a',
        statusId: 'status-draft',
        createdBy: teacher2.id,
        participationType: 'INDIVIDUAL',
      })
      await tx.insert(schema.projectStudents).values({
        projectId: 'project-tx-fail',
        enrollmentId: 'enroll-1',
      })

      throw new Error('Simulated Database Write Failure')
    })).rejects.toThrow('Simulated Database Write Failure')

    const projectsCount2 = (await db.select().from(schema.projects)).length
    expect(projectsCount2).toBe(projectsCount1)
  })

  it('rolls back audit log write failure and prevents state inconsistency', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Audit Rollback Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(db.transaction(async (tx) => {
      await tx.update(schema.projects).set({ title: 'Updated Title' }).where(eq(schema.projects.id, project.projectId))
      await tx.insert(schema.auditLogs).values({
        id: 'duplicate-audit-id',
        actorUserId: teacher1.id,
        action: 'PROJECT_UPDATED',
        entityType: 'PROJECT',
        entityId: project.projectId,
      })
      await tx.insert(schema.auditLogs).values({
        id: 'duplicate-audit-id',
        actorUserId: teacher1.id,
        action: 'PROJECT_UPDATED',
        entityType: 'PROJECT',
        entityId: project.projectId,
      })
    })).rejects.toThrow()

    const p = await db.select().from(schema.projects).where(eq(schema.projects.id, project.projectId))
    expect(p[0]?.title).toBe('Audit Rollback Test')
  })

  it('rolls back project archive operation on failure', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Archive Rollback Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(db.transaction(async (tx) => {
      await tx.update(schema.projects).set({ deletedAt: new Date(), deletedBy: teacher1.id })
        .where(eq(schema.projects.id, project.projectId))
      throw new Error('Archive Transaction Failed')
    })).rejects.toThrow('Archive Transaction Failed')

    const projectAfter = await db.select().from(schema.projects).where(eq(schema.projects.id, project.projectId))
    expect(projectAfter[0]?.deletedAt).toBeNull()
  })

  it('rolls back project restore operation on failure', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Restore Rollback Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.archiveProject(teacher1, project.projectId)
    const archivedProject = await db.select().from(schema.projects).where(eq(schema.projects.id, project.projectId))
    expect(archivedProject[0]?.deletedAt).not.toBeNull()

    await expect(db.transaction(async (tx) => {
      await tx.update(schema.projects).set({ deletedAt: null, deletedBy: null })
        .where(eq(schema.projects.id, project.projectId))
      throw new Error('Restore Transaction Failed')
    })).rejects.toThrow('Restore Transaction Failed')

    const projectAfterFail = await db.select().from(schema.projects).where(eq(schema.projects.id, project.projectId))
    expect(projectAfterFail[0]?.deletedAt).not.toBeNull()
  })
})
