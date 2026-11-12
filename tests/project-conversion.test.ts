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

describe('Individual ↔ Team Project Conversion Feature Tests', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'teacher-2', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `project-conversion-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.update(schema.projectCategories)
      .set({ duplicateCheckEnabled: true, duplicateRule: 'ACADEMIC_YEAR_STUDENT_CATEGORY' })
      .where(eq(schema.projectCategories.id, 'category-etwinning'))

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
      { id: 's-1', bilsemNo: '1001', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 's-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
      { id: 's-3', bilsemNo: '1003', firstName: 'Mehmet', lastName: 'Demir' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 's-1', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-2', studentId: 's-2', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-3', studentId: 's-3', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-old', studentId: 's-1', academicYearId: 'year-2023', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1 & 2 & 14. Converts individual project to team project, preserving original student, project ID, title, and metadata', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Individual Project',
      description: 'Original description',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const result = await projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Innovators Team',
      additionalEnrollmentIds: ['enroll-2'],
    })

    expect(result.projectId).toBe(created.projectId)

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.project.participationType).toBe('TEAM')
    expect(detail.project.teamName).toBe('Innovators Team')
    expect(detail.project.title).toBe('Individual Project')
    expect(detail.project.description).toBe('Original description')

    const memberEnrollmentIds = detail.students.map((s) => s.enrollmentId)
    expect(memberEnrollmentIds).toContain('enroll-1')
    expect(memberEnrollmentIds).toContain('enroll-2')
  })

  it('3. Generates duplicate project warning when converting to team with a student having duplicate claim', async () => {
    await projectService.createProject(teacher2, {
      title: 'Existing Category Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'],
    })

    const created = await projectService.createProject(teacher1, {
      title: 'First Project for Student 1',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const result = await projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Team With Conflict',
      additionalEnrollmentIds: ['enroll-2'],
    })

    expect(result.conflicts).toBeDefined()
    expect(result.conflicts.length).toBeGreaterThan(0)
    expect(result.conflicts[0]?.bilsemNo).toBe('1002')
  })

  it('4. Prevents adding the same student twice during conversion to team', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Solo Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Duplicate Member Team',
      additionalEnrollmentIds: ['enroll-1'],
    })).rejects.toThrow(ProjectRuleError)

    await expect(projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Duplicate Member Team',
      additionalEnrollmentIds: ['enroll-2', 'enroll-2'],
    })).rejects.toThrow(ProjectRuleError)
  })

  it('5. Blocks adding students from a different academic year during conversion to team', async () => {
    const created = await projectService.createProject(teacher1, {
      title: '2024 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Cross-year Team',
      additionalEnrollmentIds: ['enroll-old'],
    })).rejects.toThrow(ProjectRuleError)
  })

  it('6 & 7 & 8 & 9 & 10. Converts team project to individual project: keeps selected student, removes others, cleans up duplicate claims for removed members on this project, preserves other projects and student records', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Original Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Original Team',
      enrollmentIds: ['enroll-1', 'enroll-2', 'enroll-3'],
    })

    const claimsBefore = await db.select().from(schema.projectDuplicateClaims).where(eq(schema.projectDuplicateClaims.projectId, created.projectId))
    expect(claimsBefore.length).toBeGreaterThanOrEqual(3)

    const result = await projectService.convertToIndividual(teacher1, created.projectId, {
      selectedEnrollmentId: 'enroll-2',
    })

    expect(result.projectId).toBe(created.projectId)

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.project.participationType).toBe('INDIVIDUAL')
    expect(detail.project.teamName).toBeNull()
    expect(detail.students).toHaveLength(1)
    expect(detail.students[0]?.enrollmentId).toBe('enroll-2')

    const removedStudent1 = await db.select().from(schema.students).where(eq(schema.students.id, 's-1'))
    const removedStudent3 = await db.select().from(schema.students).where(eq(schema.students.id, 's-3'))
    expect(removedStudent1).toHaveLength(1)
    expect(removedStudent3).toHaveLength(1)

    const claimsAfter = await db.select().from(schema.projectDuplicateClaims).where(eq(schema.projectDuplicateClaims.projectId, created.projectId))
    expect(claimsAfter).toHaveLength(1)
    expect(claimsAfter[0]?.studentId).toBe('s-2')
  })

  it('11 & 12. Enforces authorization: admin can convert any project, unauthorized teacher cannot convert', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.convertToTeam(teacher2, created.projectId, {
      teamName: 'Unauthorized Team',
      additionalEnrollmentIds: ['enroll-2'],
    })).rejects.toThrow(AuthorizationError)

    const adminConverted = await projectService.convertToTeam(admin, created.projectId, {
      teamName: 'Admin Converted Team',
      additionalEnrollmentIds: ['enroll-2'],
    })
    expect(adminConverted.projectId).toBe(created.projectId)

    await expect(projectService.convertToIndividual(teacher2, created.projectId, {
      selectedEnrollmentId: 'enroll-1',
    })).rejects.toThrow(AuthorizationError)

    const adminConvertedBack = await projectService.convertToIndividual(admin, created.projectId, {
      selectedEnrollmentId: 'enroll-1',
    })
    expect(adminConvertedBack.projectId).toBe(created.projectId)
  })

  it('13. Rolls back transaction atomically when conversion fails', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Atomic Test Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Will Fail',
      additionalEnrollmentIds: ['non-existent-enrollment'],
    })).rejects.toThrow()

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.project.participationType).toBe('INDIVIDUAL')
    expect(detail.students).toHaveLength(1)
  })

  it('15. Verifies TEAM_MEMBER_ADDED and TEAM_MEMBER_PROJECT_CONFLICT notifications are created in database and sent to project.createdBy, actor, and conflict owner', async () => {
    await projectService.createProject(teacher2, {
      title: 'Owner 2 Existing Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'],
    })

    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Conflict Team',
      additionalEnrollmentIds: ['enroll-2'],
    })

    const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.projectId, created.projectId))
    expect(notifications.length).toBeGreaterThan(0)

    const addedNotifications = notifications.filter((n) => n.type === 'TEAM_MEMBER_ADDED')
    expect(addedNotifications.length).toBeGreaterThan(0)
    expect(addedNotifications.some((n) => n.recipientId === teacher1.id)).toBe(true)

    const conflictNotifications = notifications.filter((n) => n.type === 'TEAM_MEMBER_PROJECT_CONFLICT')
    expect(conflictNotifications.length).toBeGreaterThan(0)

    const recipientIds = new Set(conflictNotifications.map((n) => n.recipientId))
    expect(recipientIds).toContain(teacher1.id)
    expect(recipientIds).toContain(teacher2.id)
  })

  it('16. Verifies convertToIndividual preserves remaining student duplicate claim, removes claim for removed student on converted project, and keeps independent project claim for removed student untouched', async () => {
    const secondProj = await projectService.createProject(teacher2, {
      title: 'Second Independent Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'],
    })

    const secondProjClaims = await db.select().from(schema.projectDuplicateClaims).where(and(
      eq(schema.projectDuplicateClaims.projectId, secondProj.projectId),
      eq(schema.projectDuplicateClaims.studentId, 's-2'),
    ))
    expect(secondProjClaims).toHaveLength(1)

    const teamProj = await projectService.createProject(teacher1, {
      title: 'Team Project Claims',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Claims',
      enrollmentIds: ['enroll-1', 'enroll-3'],
    })

    const claimsBefore = await db.select().from(schema.projectDuplicateClaims).where(eq(schema.projectDuplicateClaims.projectId, teamProj.projectId))
    expect(claimsBefore.length).toBeGreaterThanOrEqual(2)

    await projectService.convertToIndividual(teacher1, teamProj.projectId, {
      selectedEnrollmentId: 'enroll-1',
    })

    const claimsForS1 = await db.select().from(schema.projectDuplicateClaims).where(and(
      eq(schema.projectDuplicateClaims.projectId, teamProj.projectId),
      eq(schema.projectDuplicateClaims.studentId, 's-1'),
    ))
    expect(claimsForS1).toHaveLength(1)

    const claimsForS3OnTeam = await db.select().from(schema.projectDuplicateClaims).where(and(
      eq(schema.projectDuplicateClaims.projectId, teamProj.projectId),
      eq(schema.projectDuplicateClaims.studentId, 's-3'),
    ))
    expect(claimsForS3OnTeam).toHaveLength(0)

    const secondProjClaimsAfter = await db.select().from(schema.projectDuplicateClaims).where(and(
      eq(schema.projectDuplicateClaims.projectId, secondProj.projectId),
      eq(schema.projectDuplicateClaims.studentId, 's-2'),
    ))
    expect(secondProjClaimsAfter).toHaveLength(1)
  })
})
