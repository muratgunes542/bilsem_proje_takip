import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService } from '../server/services/project-service'

describe('Project Listing and Query Performance', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'teacher-2', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `project-list-${randomUUID()}.db`)
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
      { id: 'year-2023', name: '2023-2024', startsOn: new Date('2023-09-01'), endsOn: new Date('2024-06-30'), isCurrent: false },
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

  it('hides archived projects from teachers regardless of includeArchived parameter', async () => {
    const p1 = await projectService.createProject(teacher1, {
      title: 'Active Project 1',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const p2 = await projectService.createProject(teacher1, {
      title: 'Project To Archive',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'],
    })

    await projectService.archiveProject(teacher1, p2.projectId)

    const teacherList = await projectService.listProjects(teacher1)
    expect(teacherList.map((p) => p.id)).toContain(p1.projectId)
    expect(teacherList.map((p) => p.id)).not.toContain(p2.projectId)

    const teacherListForced = await projectService.listProjects(teacher1, { includeArchived: true })
    expect(teacherListForced.map((p) => p.id)).not.toContain(p2.projectId)
  })

  it('allows admin to view archived projects when includeArchived is true', async () => {
    const p1 = await projectService.createProject(teacher1, {
      title: 'Active Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const p2 = await projectService.createProject(teacher1, {
      title: 'Archived Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'],
    })

    await projectService.archiveProject(teacher1, p2.projectId)

    const adminDefault = await projectService.listProjects(admin)
    expect(adminDefault.map((p) => p.id)).toContain(p1.projectId)
    expect(adminDefault.map((p) => p.id)).not.toContain(p2.projectId)

    const adminWithArchived = await projectService.listProjects(admin, { includeArchived: true })
    expect(adminWithArchived.map((p) => p.id)).toContain(p1.projectId)
    expect(adminWithArchived.map((p) => p.id)).toContain(p2.projectId)
  })

  it('filters projects by academicYearId, categoryId, statusId', async () => {
    const p1 = await projectService.createProject(teacher1, {
      title: 'TÜBİTAK Project',
      academicYearId: 'year-2024',
      categoryId: 'category-tubitak-2204-a',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.createProject(teacher2, {
      title: 'eTwinning Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-active',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'],
    })

    const tubitakFilter = await projectService.listProjects(teacher1, { categoryId: 'category-tubitak-2204-a' })
    expect(tubitakFilter).toHaveLength(1)
    expect(tubitakFilter[0]?.id).toBe(p1.projectId)

    const draftFilter = await projectService.listProjects(teacher1, { statusId: 'status-draft' })
    expect(draftFilter).toHaveLength(1)
    expect(draftFilter[0]?.id).toBe(p1.projectId)
  })

  it('filters projects by studentId and advisorUserId', async () => {
    const p1 = await projectService.createProject(teacher1, {
      title: 'Student 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await db.insert(schema.projectAdvisors).values({
      projectId: p1.projectId,
      userId: teacher2.id,
      isPrimary: true,
    })

    const student1Projects = await projectService.listProjects(teacher1, { studentId: 'student-1' })
    expect(student1Projects).toHaveLength(1)
    expect(student1Projects[0]?.id).toBe(p1.projectId)

    const advisorProjects = await projectService.listProjects(teacher1, { advisorUserId: teacher2.id })
    expect(advisorProjects).toHaveLength(1)
    expect(advisorProjects[0]?.id).toBe(p1.projectId)
    expect(advisorProjects[0]).toMatchObject({ students: ['Ali Yılmaz'], advisors: ['Teacher Two'] })

    const searchedProjects = await projectService.listProjects(teacher1, { search: 'Student 1' })
    expect(searchedProjects.map((project) => project.id)).toContain(p1.projectId)
    expect(searchedProjects).toHaveLength(1)
  })
})
