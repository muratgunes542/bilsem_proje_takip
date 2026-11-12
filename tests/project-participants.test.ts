import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser, AuthorizationError } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService, ProjectRuleError } from '../server/services/project-service'

describe('Project Participant Management (Add, Remove Team Members)', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'teacher-2', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `project-participants-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin User', email: 'admin@test.com', role: 'ADMIN' },
      { id: teacher1.id, name: 'Teacher One', email: 'teacher1@test.com', role: 'TEACHER' },
      { id: teacher2.id, name: 'Teacher Two', email: 'teacher2@test.com', role: 'TEACHER' },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 's-1', bilsemNo: '1001', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 's-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
      { id: 's-3', bilsemNo: '1003', firstName: 'Mehmet', lastName: 'Demir' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 's-1', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-2', studentId: 's-2', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-3', studentId: 's-3', academicYearId: 'year-2024', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('allows teacher to add a new team member to their team project', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Alpha',
      enrollmentIds: ['enroll-1', 'enroll-2'],
    })

    await expect(projectService.addTeamMember(teacher1, created.projectId, 'enroll-3')).resolves.not.toThrow()

    const members = await projectService.getProjectMembers(teacher1, created.projectId)
    expect(members).toHaveLength(3)
  })

  it('allows admin to add or remove members from any project', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Alpha',
      enrollmentIds: ['enroll-1', 'enroll-2', 'enroll-3'],
    })

    await expect(projectService.removeTeamMember(admin, created.projectId, 'enroll-3')).resolves.not.toThrow()
    const members = await projectService.getProjectMembers(admin, created.projectId)
    expect(members).toHaveLength(2)
  })

  it('prevents adding the same student twice to a project', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Alpha',
      enrollmentIds: ['enroll-1', 'enroll-2'],
    })

    await expect(projectService.addTeamMember(teacher1, created.projectId, 'enroll-1')).rejects.toThrow(ProjectRuleError)
  })

  it('allows teacher to remove a team member while respecting minimum team member rule (min 2) and ensuring student record is untouched', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Alpha',
      enrollmentIds: ['enroll-1', 'enroll-2', 'enroll-3'],
    })

    await expect(projectService.removeTeamMember(teacher1, created.projectId, 'enroll-3')).resolves.not.toThrow()

    const members = await projectService.getProjectMembers(teacher1, created.projectId)
    expect(members).toHaveLength(2)
    expect(members.map((m) => m.enrollmentId)).toContain('enroll-1')
    expect(members.map((m) => m.enrollmentId)).toContain('enroll-2')

    // Verify student 3 record and enrollment are untouched
    const [enroll3] = await db.select().from(schema.studentEnrollments).where(eq(schema.studentEnrollments.id, 'enroll-3'))
    expect(enroll3).toBeDefined()
    const [student3] = await db.select().from(schema.students).where(eq(schema.students.id, 's-3'))
    expect(student3).toBeDefined()

    // Trying to remove another when only 2 remain should fail (min 2)
    await expect(projectService.removeTeamMember(teacher1, created.projectId, 'enroll-2')).rejects.toThrow(ProjectRuleError)
  })

  it('cleans up projectDuplicateClaims when removing a student from a team project, preserving student profile', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Alpha',
      enrollmentIds: ['enroll-1', 'enroll-2', 'enroll-3'],
    })

    await projectService.removeTeamMember(teacher1, created.projectId, 'enroll-3')

    const claimsAfter = await db.select().from(schema.projectDuplicateClaims).where(and(
      eq(schema.projectDuplicateClaims.projectId, created.projectId),
      eq(schema.projectDuplicateClaims.studentId, 's-3'),
    ))
    expect(claimsAfter).toHaveLength(0)

    const [enroll3] = await db.select().from(schema.studentEnrollments).where(eq(schema.studentEnrollments.id, 'enroll-3'))
    expect(enroll3).toBeDefined()
  })

  it('prevents another teacher from adding or removing members from a project they do not own', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Alpha',
      enrollmentIds: ['enroll-1', 'enroll-2'],
    })

    await expect(projectService.addTeamMember(teacher2, created.projectId, 'enroll-3')).rejects.toThrow(AuthorizationError)
    await expect(projectService.removeTeamMember(teacher2, created.projectId, 'enroll-2')).rejects.toThrow(AuthorizationError)
  })
})
