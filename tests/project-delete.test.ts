import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser, AuthorizationError, ResourceNotFoundError } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService } from '../server/services/project-service'

describe('Project Deletion Feature (V1)', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'teacher-2', role: 'TEACHER', isActive: true }
  const advisorTeacher: AuthenticatedUser = { id: 'advisor-1', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `project-delete-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin User', email: 'admin@test.com', role: 'ADMIN' },
      { id: teacher1.id, name: 'Teacher One', email: 'teacher1@test.com', role: 'TEACHER' },
      { id: teacher2.id, name: 'Teacher Two', email: 'teacher2@test.com', role: 'TEACHER' },
      { id: advisorTeacher.id, name: 'Advisor Teacher', email: 'advisor@test.com', role: 'TEACHER' },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 'student-1', bilsemNo: '1001', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 'student-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 'student-1', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-2', studentId: 'student-2', academicYearId: 'year-2024', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. Allows project creator (teacher) to delete their own project', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.deleteProject(teacher1, created.projectId)).resolves.not.toThrow()

    // Verify project is deleted
    await expect(projectService.getProjectDetail(teacher1, created.projectId)).rejects.toThrow(ResourceNotFoundError)
  })

  it('2. Prevents another teacher from deleting a project they did not create', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.deleteProject(teacher2, created.projectId)).rejects.toThrow(AuthorizationError)
  })

  it('3. Allows admin to delete any project', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.deleteProject(admin, created.projectId)).resolves.not.toThrow()
  })

  it('4. Prevents an advisor teacher who is not the creator from deleting the project', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    // Add advisor
    await db.insert(schema.projectAdvisors).values({
      projectId: created.projectId,
      userId: advisorTeacher.id,
      isPrimary: false,
    })

    await expect(projectService.deleteProject(advisorTeacher, created.projectId)).rejects.toThrow(AuthorizationError)
  })

  it('5 & 6. Team project deletion cleans up participant relations (projectStudents) and records PROJECT_DELETE audit log without deleting student profiles', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Innovators',
      enrollmentIds: ['enroll-1', 'enroll-2'],
    })

    await projectService.deleteProject(teacher1, created.projectId)

    // Verify projectStudents cleaned up
    const students = await db.select().from(schema.projectStudents).where(eq(schema.projectStudents.projectId, created.projectId))
    expect(students).toHaveLength(0)

    // Verify student profiles & enrollments are untouched
    const [enroll1] = await db.select().from(schema.studentEnrollments).where(eq(schema.studentEnrollments.id, 'enroll-1'))
    expect(enroll1).toBeDefined()

    // Verify PROJECT_DELETE audit log recorded
    const [audit] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'PROJECT_DELETE'))
    expect(audit).toBeDefined()
    expect(audit?.entityId).toBe(created.projectId)
  })

  it('8. Throws ResourceNotFoundError for non-existent project deletion', async () => {
    await expect(projectService.deleteProject(admin, 'non-existent-id')).rejects.toThrow(ResourceNotFoundError)
  })
})
