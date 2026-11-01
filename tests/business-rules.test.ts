import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { NotificationService } from '../server/services/notification-service'
import { ProjectRuleError, ProjectService } from '../server/services/project-service'

describe('Domain Business Rules Verification', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService
  let notificationService: NotificationService

  const teacher1: AuthenticatedUser = { id: 't-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 't-2', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `business-rules-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: teacher1.id, name: 'Teacher 1', email: 't1@test.com', role: 'TEACHER' },
      { id: teacher2.id, name: 'Teacher 2', email: 't2@test.com', role: 'TEACHER' },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
      { id: 'year-2023', name: '2023-2024', startsOn: new Date('2023-09-01'), endsOn: new Date('2024-06-30'), isCurrent: false },
    ])

    await db.insert(schema.students).values([
      { id: 's-1', bilsemNo: 'B-101', firstName: 'Ahmet', lastName: 'Yılmaz' },
      { id: 's-2', bilsemNo: 'B-102', firstName: 'Ayşe', lastName: 'Kaya' },
      { id: 's-3', bilsemNo: 'B-103', firstName: 'Mehmet', lastName: 'Demir' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'e-1', studentId: 's-1', academicYearId: 'year-2024', isActive: true },
      { id: 'e-2', studentId: 's-2', academicYearId: 'year-2024', isActive: true },
      { id: 'e-3', studentId: 's-3', academicYearId: 'year-2024', isActive: false },
      { id: 'e-2023-1', studentId: 's-1', academicYearId: 'year-2023', isActive: true },
    ])

    projectService = new ProjectService(db)
    notificationService = new NotificationService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('enforces unique BİLSEM number on students table', async () => {
    await expect(db.insert(schema.students).values({
      id: 's-dup',
      bilsemNo: 'B-101',
      firstName: 'Dup',
      lastName: 'Student',
    })).rejects.toThrow()
  })

  it('requires exactly one student for INDIVIDUAL projects', async () => {
    await expect(projectService.createProject(teacher1, {
      title: 'Individual Project 0 Students',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })).rejects.toThrow(ProjectRuleError)

    await expect(projectService.createProject(teacher1, {
      title: 'Individual Project 2 Students',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1', 'e-2'],
    })).rejects.toThrow(ProjectRuleError)

    await expect(projectService.createProject(teacher1, {
      title: 'Valid Individual Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })).resolves.toBeDefined()
  })

  it('requires at least two students for TEAM projects', async () => {
    await expect(projectService.createProject(teacher1, {
      title: 'Team Project 1 Student',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Solo Team',
      enrollmentIds: ['e-1'],
    })).rejects.toThrow(ProjectRuleError)

    const project = await projectService.createProject(teacher1, {
      title: 'Valid Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Duo Team',
      enrollmentIds: ['e-1', 'e-2'],
    })
    expect(project.projectId).toBeDefined()
  })

  it('requires team members to be active students in the project academic year', async () => {
    await expect(projectService.createProject(teacher1, {
      title: 'Inactive Student Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team',
      enrollmentIds: ['e-1', 'e-3'],
    })).rejects.toThrow(ProjectRuleError)

    await expect(projectService.createProject(teacher1, {
      title: 'Wrong Year Student Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team',
      enrollmentIds: ['e-1', 'e-2023-1'],
    })).rejects.toThrow(ProjectRuleError)
  })

  it('prevents adding the same team member twice', async () => {
    await expect(projectService.createProject(teacher1, {
      title: 'Duplicate Student Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team',
      enrollmentIds: ['e-1', 'e-1'],
    })).rejects.toThrow(ProjectRuleError)

    const project = await projectService.createProject(teacher1, {
      title: 'Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team',
      enrollmentIds: ['e-1', 'e-2'],
    })

    await expect(projectService.addTeamMember(teacher1, project.projectId, 'e-1'))
      .rejects.toThrow(ProjectRuleError)
  })

  it('duplicate TÜBİTAK warning does NOT block project creation, and checks same year + student + category', async () => {
    const p1 = await projectService.createProject(teacher1, {
      title: 'First TÜBİTAK 2204-A Project',
      academicYearId: 'year-2024',
      categoryId: 'category-tubitak-2204-a',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })
    expect(p1.conflicts).toHaveLength(0)

    const p2 = await projectService.createProject(teacher2, {
      title: 'Second TÜBİTAK 2204-A Project for Same Student',
      academicYearId: 'year-2024',
      categoryId: 'category-tubitak-2204-a',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['e-1'],
    })

    expect(p2.projectId).toBeDefined()
    expect(p2.conflicts).toHaveLength(1)
    expect(p2.conflicts[0]?.bilsemNo).toBe('B-101')
    expect(p2.conflicts[0]?.ownerId).toBe(teacher1.id)

    const notifsT1 = await notificationService.listForUser(teacher1)
    const notifsT2 = await notificationService.listForUser(teacher2)

    expect(notifsT1.notifications.some((n) => n.type === 'DUPLICATE_PROJECT_WARNING')).toBe(true)
    expect(notifsT2.notifications.some((n) => n.type === 'DUPLICATE_PROJECT_WARNING')).toBe(true)
  })

  it('validates category-based duplicate check flexibility', async () => {
    const categories = await db.select({
      code: schema.projectCategories.code,
      enabled: schema.projectCategories.duplicateCheckEnabled,
      rule: schema.projectCategories.duplicateRule,
    }).from(schema.projectCategories)

    const tubitakA = categories.find((c) => c.code === 'TUBITAK_2204_A')
    expect(tubitakA?.enabled).toBe(true)
    expect(tubitakA?.rule).toBe('ACADEMIC_YEAR_STUDENT_CATEGORY')

    const etwinning = categories.find((c) => c.code === 'ETWINNING')
    expect(etwinning?.enabled).toBe(false)
  })
})
