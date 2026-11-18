import { createServer } from 'node:http'
import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchNodeApi } from '../server/api/router'
import { AuthorizationError, type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService, ProjectRuleError } from '../server/services/project-service'
import { ReportService } from '../server/services/report-service'

describe('Stage 3-7: Dynamic Categories & Category Management Test Suite', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-cat-mgr', role: 'ADMIN', isActive: true }
  const teacher: AuthenticatedUser = { id: 'teacher-cat-mgr', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `cat-mgr-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin Manager', email: 'admin-catmgr@test.com', role: 'ADMIN', isActive: true },
      { id: teacher.id, name: 'Teacher User', email: 'teacher-catmgr@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.academicYears).values({
      id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true,
    })

    await db.insert(schema.students).values({
      id: 'student-c1', bilsemNo: '8001', firstName: 'Mehmet', lastName: 'Ak'
    })

    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-c1', studentId: 'student-c1', academicYearId: 'year-2024', isActive: true,
    })

    projectService = new ProjectService(db)

    server = createServer((req, res) => { void dispatchNodeApi(req, res, undefined, db) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP test sunucusu açılamadı.')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await client.close()
  })

  async function api(path: string, method = 'GET', body?: unknown, userId?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(userId ? { 'x-test-user-id': userId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { response, body: await response.json().catch(() => null) as any }
  }

  it('1. ADMIN can list categories via GET /api/admin/categories', async () => {
    const res = await api('/api/admin/categories', 'GET', undefined, admin.id)
    expect(res.response.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.length).toBeGreaterThanOrEqual(8)
  })

  it('2. TEACHER cannot access or manage categories via /api/admin/categories (403 Forbidden)', async () => {
    const resGet = await api('/api/admin/categories', 'GET', undefined, teacher.id)
    expect(resGet.response.status).toBe(403)

    const resPost = await api('/api/admin/categories', 'POST', { code: 'NEW_CODE', name: 'New Cat' }, teacher.id)
    expect(resPost.response.status).toBe(403)

    const resPatch = await api('/api/admin/categories/category-etwinning', 'PATCH', { name: 'Unauthorized' }, teacher.id)
    expect(resPatch.response.status).toBe(403)
  })

  it('3. ADMIN can create a new category (TEKNOFEST) and it appears in listProjectOptions', async () => {
    const resPost = await api('/api/admin/categories', 'POST', {
      code: 'TEKNOFEST_TEST',
      name: 'TEKNOFEST Havacılık ve Uzay',
      duplicateCheckEnabled: true,
    }, admin.id)

    expect(resPost.response.status).toBe(201)
    expect(resPost.body.data.code).toBe('TEKNOFEST_TEST')

    const options = await projectService.listProjectOptions(teacher)
    const found = options.categories.find((c) => c.code === 'TEKNOFEST_TEST')
    expect(found).toBeDefined()
    expect(found?.name).toBe('TEKNOFEST Havacılık ve Uzay')
    expect(found?.duplicateCheckEnabled).toBe(true)
  })

  it('4. ADMIN can update category display name and toggle active status', async () => {
    const created = await projectService.createCategory(admin, {
      code: 'ROBOTICS_TEST',
      name: 'Robotik Yarışması',
    })

    const updated = await projectService.updateCategory(admin, created.id, {
      name: 'Ulusal Robotik Yarışmaları',
      isActive: false,
    })
    expect(updated.name).toBe('Ulusal Robotik Yarışmaları')
    expect(updated.isActive).toBe(false)

    // Passive category must NOT appear in creation options
    const options = await projectService.listProjectOptions(teacher)
    expect(options.categories.some((c) => c.id === created.id)).toBe(false)

    // Reactivate category
    await projectService.updateCategory(admin, created.id, { isActive: true })
    const optionsAfter = await projectService.listProjectOptions(teacher)
    expect(optionsAfter.categories.some((c) => c.id === created.id)).toBe(true)
  })

  it('5. Passive category remains visible on historical projects and detail views', async () => {
    const cat = await projectService.createCategory(admin, {
      code: 'HISTORICAL_CAT',
      name: 'Eski Kategori',
    })

    const project = await projectService.createProject(teacher, {
      title: 'Historical Project',
      academicYearId: 'year-2024',
      categoryId: cat.id,
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-c1'],
    })

    // Deactivate the category
    await projectService.updateCategory(admin, cat.id, { isActive: false })

    // Project detail still renders the category name correctly
    const detail = await projectService.getProjectDetail(teacher, project.projectId)
    expect(detail.project.categoryId).toBe(cat.id)

    // Project list query still returns the historical project
    const list = await projectService.listProjects(teacher, { categoryId: cat.id })
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Historical Project')

    const report = await new ReportService(db).getOverview(admin, {})
    expect(report.categoryDistribution.some((category) => category.categoryId === cat.id)).toBe(true)

    const deleteAttempt = await api(`/api/admin/categories/${cat.id}`, 'DELETE', undefined, admin.id)
    expect(deleteAttempt.response.status).toBe(404)
    expect((await projectService.listCategories(admin)).some((category) => category.id === cat.id)).toBe(true)
  })

  it('6. Attempting to create a category with a duplicate code or name throws ProjectRuleError', async () => {
    const first = await projectService.createCategory(admin, {
      code: 'UNIQUE_CODE_1',
      name: 'Unique Name 1',
    })

    await expect(
      projectService.createCategory(admin, { code: 'UNIQUE_CODE_1', name: 'Different Name' }),
    ).rejects.toThrow(ProjectRuleError)

    await expect(
      projectService.createCategory(admin, { code: 'DIFFERENT_CODE', name: ' unique name 1 ' }),
    ).rejects.toThrow(ProjectRuleError)

    await expect(
      projectService.createCategory(admin, { code: 'unique_code_1', name: 'Another Name' }),
    ).rejects.toThrow(ProjectRuleError)

    await projectService.createCategory(admin, { code: 'UNIQUE_CODE_2', name: 'Second Category' })
    await expect(
      projectService.updateCategory(admin, first.id, { name: ' second category ' }),
    ).rejects.toThrow(ProjectRuleError)
  })

  it('rejects new projects that use an inactive category while keeping historical projects readable', async () => {
    const category = await projectService.createCategory(admin, {
      code: 'INACTIVE_PROJECT_CAT',
      name: 'Inactive Project Category',
    })
    await projectService.updateCategory(admin, category.id, { isActive: false })

    await expect(projectService.createProject(teacher, {
      title: 'Inactive Category Project',
      academicYearId: 'year-2024',
      categoryId: category.id,
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-c1'],
    })).rejects.toThrow(ProjectRuleError)
  })

  it('7. Can create parent and subcategories, and handle hierarchy rules (self-parent, circular ref, passive parent, deactivating parent with subcats)', async () => {
    const parent = await projectService.createCategory(admin, {
      code: 'PARENT_CAT',
      name: 'Parent Category',
    })

    const child = await projectService.createCategory(admin, {
      code: 'CHILD_CAT',
      name: 'Child Category',
      parentId: parent.id,
    })

    // 1. Direct self-parent assignment
    await expect(
      projectService.updateCategory(admin, parent.id, { parentId: parent.id }),
    ).rejects.toThrow(ProjectRuleError)

    // 2. Indirect circular hierarchy (Parent -> Child -> Try making parent a child of child)
    await expect(
      projectService.updateCategory(admin, parent.id, { parentId: child.id }),
    ).rejects.toThrow(ProjectRuleError)

    // 3. Deactivating parent with active subcategories
    await expect(
      projectService.updateCategory(admin, parent.id, { isActive: false }),
    ).rejects.toThrow(ProjectRuleError)

    // 4. Deactivating subcategory then parent
    await projectService.updateCategory(admin, child.id, { isActive: false })
    const parentDeactivated = await projectService.updateCategory(admin, parent.id, { isActive: false })
    expect(parentDeactivated.isActive).toBe(false)

    // 5. Reactivating subcategory under passive parent (should fail because parent is passive)
    await expect(
      projectService.updateCategory(admin, child.id, { isActive: true }),
    ).rejects.toThrow(ProjectRuleError)

    // Reactivate parent first, then child
    await projectService.updateCategory(admin, parent.id, { isActive: true })
    const childReactivated = await projectService.updateCategory(admin, child.id, { isActive: true })
    expect(childReactivated.isActive).toBe(true)
  })

  it('8. Changing parent and hierarchy maintenance across project creation and update', async () => {
    const parent1 = await projectService.createCategory(admin, { code: 'P1', name: 'Parent 1' })
    const parent2 = await projectService.createCategory(admin, { code: 'P2', name: 'Parent 2' })
    const sub = await projectService.createCategory(admin, { code: 'SUB', name: 'Subcategory', parentId: parent1.id })

    // Change parent of sub
    const updatedSub = await projectService.updateCategory(admin, sub.id, { parentId: parent2.id })
    expect(updatedSub.parentId).toBe(parent2.id)

    // Create project with subcategory
    const proj = await projectService.createProject(teacher, {
      title: 'Hierarchy Project',
      academicYearId: 'year-2024',
      categoryId: sub.id,
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-c1'],
    })
    expect(proj.projectId).toBeDefined()

    // Update project category to another active category
    await projectService.updateProject(teacher, proj.projectId, { categoryId: parent1.id })
    const detail = await projectService.getProjectDetail(teacher, proj.projectId)
    expect(detail.project.categoryId).toBe(parent1.id)
  })
})
