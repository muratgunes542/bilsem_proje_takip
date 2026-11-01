import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError, type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { NotificationService } from '../server/services/notification-service'
import { ProjectService } from '../server/services/project-service'

describe('Server-side Authorization and Security Enforcement', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService
  let notificationService: NotificationService

  const admin: AuthenticatedUser = { id: 'user-admin', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'user-teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'user-teacher-2', role: 'TEACHER', isActive: true }
  const inactiveTeacher: AuthenticatedUser = { id: 'user-teacher-inactive', role: 'TEACHER', isActive: false }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `auth-service-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin', email: 'admin@test.com', role: 'ADMIN' },
      { id: teacher1.id, name: 'Teacher 1', email: 't1@test.com', role: 'TEACHER' },
      { id: teacher2.id, name: 'Teacher 2', email: 't2@test.com', role: 'TEACHER' },
      { id: inactiveTeacher.id, name: 'Inactive Teacher', email: 'inact@test.com', role: 'TEACHER', isActive: false },
    ])

    await db.insert(schema.academicYears).values({
      id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true,
    })

    await db.insert(schema.students).values([
      { id: 's-1', bilsemNo: '101', firstName: 'A', lastName: 'B' },
      { id: 's-2', bilsemNo: '102', firstName: 'C', lastName: 'D' },
      { id: 's-3', bilsemNo: '103', firstName: 'E', lastName: 'F' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'e-1', studentId: 's-1', academicYearId: 'year-2024', isActive: true },
      { id: 'e-2', studentId: 's-2', academicYearId: 'year-2024', isActive: true },
      { id: 'e-3', studentId: 's-3', academicYearId: 'year-2024', isActive: true },
    ])

    projectService = new ProjectService(db)
    notificationService = new NotificationService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('unauthenticated or inactive user cannot access project list', async () => {
    await expect(projectService.listProjects(inactiveTeacher)).rejects.toThrow(AuthorizationError)

    const fakeUser = { id: 'fake', role: 'STUDENT' as unknown as schema.UserRole, isActive: true }
    await expect(projectService.listProjects(fakeUser)).rejects.toThrow(AuthorizationError)
  })

  it('teacher cannot edit another teacher project', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })

    await expect(projectService.updateProject(teacher2, project.projectId, { title: 'Hacked Title' }))
      .rejects.toThrow(AuthorizationError)
  })

  it('being a project advisor does not grant edit permissions to non-creator teacher', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Project with Advisor',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })

    await db.insert(schema.projectAdvisors).values({
      projectId: project.projectId,
      userId: teacher2.id,
      isPrimary: true,
    })

    await expect(projectService.updateProject(teacher2, project.projectId, { title: 'Advisor Edit' }))
      .rejects.toThrow(AuthorizationError)

    await expect(projectService.addTeamMember(teacher2, project.projectId, 'e-2'))
      .rejects.toThrow(AuthorizationError)
  })

  it('teacher can only archive their own project', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })

    await expect(projectService.archiveProject(teacher2, project.projectId))
      .rejects.toThrow(AuthorizationError)

    await expect(projectService.archiveProject(teacher1, project.projectId))
      .resolves.not.toThrow()
  })

  it('admin can manage (update, archive, restore) all projects', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })

    await expect(projectService.updateProject(admin, project.projectId, { title: 'Admin Updated' }))
      .resolves.not.toThrow()

    await expect(projectService.archiveProject(admin, project.projectId))
      .resolves.not.toThrow()

    await expect(projectService.restoreProject(admin, project.projectId))
      .resolves.not.toThrow()
  })

  it('teacher cannot read another user notifications', async () => {
    const notifId = randomUUID()
    await db.insert(schema.notifications).values({
      id: notifId,
      recipientId: teacher1.id,
      type: 'PROJECT_STATUS_UPDATED',
      title: 'Secret Notification',
      message: 'For Teacher 1 only',
    })

    await expect(notificationService.markAsRead(teacher2, notifId))
      .rejects.toThrow(AuthorizationError)

    await expect(notificationService.markAsRead(teacher1, notifId))
      .resolves.not.toThrow()
  })

  it('archived projects cannot be changed by normal teacher operations', async () => {
    const project = await projectService.createProject(teacher1, {
      title: 'Project To Be Archived',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })

    await projectService.archiveProject(teacher1, project.projectId)

    await expect(projectService.updateProject(teacher1, project.projectId, { title: 'Archived Edit' }))
      .rejects.toThrow()

    await expect(projectService.restoreProject(teacher1, project.projectId))
      .rejects.toThrow(AuthorizationError)
  })
})
