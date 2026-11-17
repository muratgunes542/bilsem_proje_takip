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
import { StudentService } from '../server/services/student-service'

describe('ProjectType (STUDENT, TEACHER, INSTITUTION) Architectural & Business Rules Tests', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService
  let studentService: StudentService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const teacherA: AuthenticatedUser = { id: 'teacher-a', role: 'TEACHER', isActive: true }
  const teacherB: AuthenticatedUser = { id: 'teacher-b', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `project-types-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Yönetici 1', email: 'admin1@test.com', role: 'ADMIN', isActive: true },
      { id: teacherA.id, name: 'Öğretmen A', email: 'teachera@test.com', role: 'TEACHER', isActive: true },
      { id: teacherB.id, name: 'Öğretmen B', email: 'teacherb@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 'student-1', bilsemNo: '1001', firstName: 'Ahmet', lastName: 'Yılmaz' },
      { id: 'student-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 'student-1', academicYearId: 'year-2024', advisorUserId: teacherA.id, advisorName: teacherA.id, isActive: true },
      { id: 'enroll-2', studentId: 'student-2', academicYearId: 'year-2024', advisorUserId: teacherB.id, advisorName: teacherB.id, isActive: true },
    ])

    projectService = new ProjectService(db)
    studentService = new StudentService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. TEACHER, öğrencisiz TEACHER projesi oluşturabilmeli ve oluşturan öğretmen birincil danışman olmalı', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Öğretmen Mesleki Gelişim Projesi',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })

    const detail = await projectService.getProjectDetail(teacherA, created.projectId)
    expect(detail.project.projectType).toBe('TEACHER')
    expect(detail.students).toHaveLength(0)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherA.id)
    expect(detail.advisors[0]?.isPrimary).toBe(true)
  })

  it('2. TEACHER, INSTITUTION projesi oluşturmaya çalıştığında 403 (AuthorizationError) almalı', async () => {
    await expect(
      projectService.createProject(teacherA, {
        title: 'Yetkisiz Kurum Projesi',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'INSTITUTION',
        participationType: 'INDIVIDUAL',
        enrollmentIds: [],
      }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('3. ADMIN, öğrencisiz INSTITUTION projesi oluşturabilmeli ve başlangıçta otomatik danışman atanmamalıdır', async () => {
    const created = await projectService.createProject(admin, {
      title: 'TÜBİTAK 4006 Bilim Fuarı Kurumsal Projesi',
      academicYearId: 'year-2024',
      categoryId: 'category-special-project',
      statusId: 'status-draft',
      projectType: 'INSTITUTION',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.project.projectType).toBe('INSTITUTION')
    expect(detail.students).toHaveLength(0)
    expect(detail.advisors).toHaveLength(0)

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherA.id] })
    const detailAfter = await projectService.getProjectDetail(admin, created.projectId)
    expect(detailAfter.advisors).toHaveLength(1)
    expect(detailAfter.advisors[0]?.userId).toBe(teacherA.id)
  })

  it('4. STUDENT projesi öğrencisiz oluşturulamamalı', async () => {
    await expect(
      projectService.createProject(teacherA, {
        title: 'Öğrencisiz STUDENT Projesi Denemesi',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'STUDENT',
        participationType: 'INDIVIDUAL',
        enrollmentIds: [],
      }),
    ).rejects.toThrow(ProjectRuleError)
  })

  it('5. Öğrenci eklenmiş TEACHER/INSTITUTION projelerinde bireysel/takım doğrulaması uygulanmalı', async () => {
    await expect(
      projectService.createProject(teacherA, {
        title: 'Çok Öğrencili Bireysel Öğretmen Projesi',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'TEACHER',
        participationType: 'INDIVIDUAL',
        enrollmentIds: ['enroll-1', 'enroll-2'],
      }),
    ).rejects.toThrow(ProjectRuleError)

    await expect(
      projectService.createProject(admin, {
        title: 'Tek Öğrencili Takım Kurum Projesi',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'INSTITUTION',
        participationType: 'TEAM',
        teamName: 'Takım X',
        enrollmentIds: ['enroll-1'],
      }),
    ).rejects.toThrow(ProjectRuleError)
  })

  it('6. INSTITUTION projesine sorumlu öğretmen atamasını yalnızca ADMIN yapabilmeli', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Kurum Projesi Danışman Testi',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'INSTITUTION',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })

    await expect(
      projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherA.id] }),
    ).rejects.toThrow(AuthorizationError)

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherA.id] })
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherA.id)
  })

  it('7. Danışman olmak tek başına proje düzenleme (modify) yetkisi vermemeli', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Danışman Düzenleme Yetkisi Testi',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'INSTITUTION',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
      advisorUserIds: [teacherA.id],
    })

    await expect(
      projectService.updateProject(teacherA, created.projectId, { title: 'Yetkisiz Başlık Değişimi' }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('8. Öğrenci geçmişinde (getProjectHistory) TEACHER ve INSTITUTION projeleri görünmemeli', async () => {
    const studentProject = await projectService.createProject(teacherA, {
      title: 'Gerçek Öğrenci Projesi',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'STUDENT',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const teacherProject = await projectService.createProject(teacherA, {
      title: 'Öğretmen Katılımlı Proje',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const instProject = await projectService.createProject(admin, {
      title: 'Kurum Katılımlı Proje',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'INSTITUTION',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const history = await studentService.getProjectHistory(admin, 'student-1')
    expect(history).toHaveLength(1)
    expect(history[0]?.projectId).toBe(studentProject.projectId)
    expect(history.map((h) => h.projectId)).not.toContain(teacherProject.projectId)
    expect(history.map((h) => h.projectId)).not.toContain(instProject.projectId)
  })

  it('9. Proje türü filtresi (projectType) listelemede doğru çalışmalı', async () => {
    await projectService.createProject(teacherA, {
      title: 'Filter Test Student Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'STUDENT',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const teacherProj = await projectService.createProject(teacherA, {
      title: 'Filter Test Teacher Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })

    const teacherProjectsList = await projectService.listProjects(admin, { projectType: 'TEACHER' })
    expect(teacherProjectsList.map((p) => p.id)).toContain(teacherProj.projectId)
    expect(teacherProjectsList.every((p) => p.projectType === 'TEACHER')).toBe(true)
  })

  it('10. Proje türü normal güncelleme metodu (updateProject) ile değiştirilememeli', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Immutable Type Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'STUDENT',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProject(teacherA, created.projectId, { title: 'Updated Title' })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.project.title).toBe('Updated Title')
    expect(detail.project.projectType).toBe('STUDENT')
  })

  it('11. PATCH isteğinde projectType gönderildiğinde istek reddedilmeli, title değişmemeli; projectType gönderilmeyen normal PATCH isteği başarılı olmalı', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Original Title',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'STUDENT',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const { handleApiRequest } = await import('../server/api/router.js')

    const patchRes = await handleApiRequest({
      method: 'PATCH',
      url: `/api/projects/${created.projectId}`,
      headers: { 'x-test-user-id': teacherA.id, 'content-type': 'application/json' },
      body: { projectType: 'TEACHER', title: 'Hacker Title' },
    }, db)
    expect(patchRes.statusCode).toBe(400)

    const detailAfterFail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detailAfterFail.project.title).toBe('Original Title')
    expect(detailAfterFail.project.projectType).toBe('STUDENT')

    const successRes = await handleApiRequest({
      method: 'PATCH',
      url: `/api/projects/${created.projectId}`,
      headers: { 'x-test-user-id': teacherA.id, 'content-type': 'application/json' },
      body: { title: 'New Valid Title' },
    }, db)
    expect(successRes.statusCode).toBe(200)

    const detailAfterSuccess = await projectService.getProjectDetail(admin, created.projectId)
    expect(detailAfterSuccess.project.title).toBe('New Valid Title')
    expect(detailAfterSuccess.project.projectType).toBe('STUDENT')
  }, 15000)
})
