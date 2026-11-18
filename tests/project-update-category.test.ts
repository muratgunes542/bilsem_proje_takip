import { createClient, type Client } from '@libsql/client'
import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError, type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService, ProjectRuleError } from '../server/services/project-service'

describe('Stage 1 & 2: Project Update & Category Change Feature Tests', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-stage1', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'teacher-1-stage1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'teacher-2-stage1', role: 'TEACHER', isActive: true }
  const teacher3: AuthenticatedUser = { id: 'teacher-3-stage1', role: 'TEACHER', isActive: true }
  const teacher4: AuthenticatedUser = { id: 'teacher-4-stage1', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `project-update-cat-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin User', email: 'admin-cat@test.com', role: 'ADMIN', isActive: true },
      { id: teacher1.id, name: 'Teacher One', email: 'teacher1-cat@test.com', role: 'TEACHER', isActive: true },
      { id: teacher2.id, name: 'Teacher Two', email: 'teacher2-cat@test.com', role: 'TEACHER', isActive: true },
      { id: teacher3.id, name: 'Teacher Three', email: 'teacher3-cat@test.com', role: 'TEACHER', isActive: true },
      { id: teacher4.id, name: 'Teacher Four', email: 'teacher4-cat@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.academicYears).values({
      id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true,
    })

    await db.insert(schema.students).values([
      { id: 'student-cat-1', bilsemNo: '9001', firstName: 'Elif', lastName: 'Yılmaz' },
      { id: 'student-cat-2', bilsemNo: '9002', firstName: 'Kaan', lastName: 'Demir' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-cat-1', studentId: 'student-cat-1', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-cat-2', studentId: 'student-cat-2', academicYearId: 'year-2024', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. ADMIN can update any project fields including title, description, status, and categoryId', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Original Title',
      description: 'Original Description',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })

    await projectService.updateProject(admin, created.projectId, {
      title: 'Admin Updated Title',
      description: 'Admin Updated Description',
      categoryId: 'category-tubitak-2204-a',
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.project.title).toBe('Admin Updated Title')
    expect(detail.project.description).toBe('Admin Updated Description')
    expect(detail.project.categoryId).toBe('category-tubitak-2204-a')
  })

  it('2. TEACHER can update their own created project title, description, and categoryId', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })

    await projectService.updateProject(teacher1, created.projectId, {
      title: 'Teacher 1 Updated Title',
      categoryId: 'category-special-project',
    })

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.project.title).toBe('Teacher 1 Updated Title')
    expect(detail.project.categoryId).toBe('category-special-project')
  })

  it('3. TEACHER cannot update another teacher created project (AuthorizationError)', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher 1 Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })

    await expect(
      projectService.updateProject(teacher2, created.projectId, { title: 'Unauthorized Edit' }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('4. Non-creator advisor teacher cannot update the project (AuthorizationError)', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Admin Created Project with Advisor',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
      advisorUserIds: [teacher1.id],
    })

    await expect(
      projectService.updateProject(teacher1, created.projectId, { title: 'Advisor Unauthorized Edit' }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('5. Category change updates projectDuplicateClaims and generates PROJECT_CATEGORY_CHANGED audit log', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Category Change Audit Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })

    await projectService.updateProject(teacher1, created.projectId, {
      categoryId: 'category-tubitak-2204-a',
    })

    const claims = await db.select().from(schema.projectDuplicateClaims)
      .where(eq(schema.projectDuplicateClaims.projectId, created.projectId))
    expect(claims).toHaveLength(1)
    expect(claims[0]?.categoryId).toBe('category-tubitak-2204-a')

    const logs = await db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, created.projectId), eq(schema.auditLogs.action, 'PROJECT_CATEGORY_CHANGED')))
    expect(logs).toHaveLength(1)
    const afterJson = JSON.parse(logs[0]!.afterJson!)
    expect(afterJson.oldCategoryId).toBe('category-etwinning')
    expect(afterJson.newCategoryId).toBe('category-tubitak-2204-a')
  })

  it('6. Changing category to a duplicate-enabled category triggers conflict check and warnings when duplicate exists', async () => {
    // Project 1: already in TÜBİTAK 2204-A with student-cat-1
    await projectService.createProject(teacher2, {
      title: 'Existing TUBITAK Project',
      academicYearId: 'year-2024',
      categoryId: 'category-tubitak-2204-a',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })

    // Project 2: originally in eTwinning with student-cat-1
    const p2 = await projectService.createProject(teacher1, {
      title: 'Second Project Changing Category',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })
    await projectService.updateProjectAdvisors(admin, p2.projectId, { addUserIds: [teacher3.id] })
    await db.insert(schema.projectAdvisors).values({
      projectId: p2.projectId,
      userId: teacher4.id,
      isPrimary: false,
      deletedAt: new Date(),
      deletedBy: admin.id,
    })

    // Change category of Project 2 to TÜBİTAK 2204-A (should trigger conflict warning for student-cat-1)
    const result = await projectService.updateProject(teacher1, p2.projectId, {
      categoryId: 'category-tubitak-2204-a',
    })

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.studentId).toBe('student-cat-1')

    const warnings = await db.select().from(schema.notifications)
      .where(and(
        eq(schema.notifications.type, 'DUPLICATE_PROJECT_WARNING'),
        eq(schema.notifications.projectId, p2.projectId),
      ))
    expect(warnings.length).toBeGreaterThan(0)
    expect(new Set(warnings.map((warning) => warning.recipientId))).toEqual(new Set([
      teacher1.id,
      teacher2.id,
      teacher3.id,
    ]))
    expect(warnings.some((warning) => warning.recipientId === teacher4.id)).toBe(false)

    const audit = await db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, p2.projectId), eq(schema.auditLogs.action, 'PROJECT_CATEGORY_CHANGED')))
    expect(JSON.parse(audit[0]!.afterJson!).conflicts).toHaveLength(1)
  })

  it('7. Updating project with invalid categoryId throws ProjectRuleError', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Invalid Category Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-cat-1'],
    })

    await expect(
      projectService.updateProject(teacher1, created.projectId, { categoryId: 'non-existent-category' }),
    ).rejects.toThrow(ProjectRuleError)
  })
})
