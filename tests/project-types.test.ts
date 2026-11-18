import { createClient, type Client } from '@libsql/client'
import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from '../server/api/router'
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
      { id: 'teacher-c', name: 'Öğretmen C', email: 'teacherc@test.com', role: 'TEACHER', isActive: true },
      { id: 'inactive-teacher', name: 'Pasif Öğretmen', email: 'inactive@test.com', role: 'TEACHER', isActive: false },
      { id: 'deleted-teacher', name: 'Silinmiş Öğretmen', email: 'deleted@test.com', role: 'TEACHER', isActive: true, deletedAt: new Date() },
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

  it('TEACHER ek öğretmen seçebilir; creator primary, ek öğretmenler secondary olur ve yalnızca creator düzenler', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Ek Öğretmenli Proje',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
      advisorUserIds: [teacherB.id],
    })

    const detail = await projectService.getProjectDetail(teacherB, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.find((advisor: { userId: string; isPrimary: boolean }) => advisor.userId === teacherA.id)?.isPrimary).toBe(true)
    expect(detail.advisors.find((advisor: { userId: string; isPrimary: boolean }) => advisor.userId === teacherB.id)?.isPrimary).toBe(false)
    await expect(projectService.updateProject(teacherB, created.projectId, { title: 'Yetkisiz değişiklik' }))
      .rejects.toThrow(AuthorizationError)
    await expect(projectService.updateProject(teacherA, created.projectId, { title: 'Creator güncelledi' }))
      .resolves.toBeDefined()
  })

  it('API TEACHER projesinde ek danışman atar; ek danışman görüntüleyebilir ancak düzenleyemez', async () => {
    const createResponse = await handleApiRequest({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-test-user-id': teacherA.id },
      body: {
        title: 'API ile oluşturulan ek danışmanlı proje',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'TEACHER',
        participationType: 'INDIVIDUAL',
        enrollmentIds: [],
        advisorUserIds: [teacherB.id],
      },
    }, db)

    expect(createResponse.statusCode).toBe(201)
    const createdData = (createResponse.payload as { success: true; data: { projectId: string } }).data
    const viewResponse = await handleApiRequest({
      method: 'GET',
      url: `/api/projects/${createdData.projectId}`,
      headers: { 'x-test-user-id': teacherB.id },
    }, db)
    expect(viewResponse.statusCode).toBe(200)
    const detail = (viewResponse.payload as { success: true; data: { advisors: Array<{ userId: string; isPrimary: boolean }> } }).data
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.find((advisor) => advisor.userId === teacherA.id)?.isPrimary).toBe(true)
    expect(detail.advisors.find((advisor) => advisor.userId === teacherB.id)?.isPrimary).toBe(false)

    const editResponse = await handleApiRequest({
      method: 'PATCH',
      url: `/api/projects/${createdData.projectId}`,
      headers: { 'x-test-user-id': teacherB.id },
      body: { title: 'Ek danışman yetkisiz değişiklik' },
    }, db)
    expect(editResponse.statusCode).toBe(403)
  })

  it('TEACHER advisorUserIds içinde creator tekrarlanırsa tek primary kaydı oluşturur', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Tekrarlanan Creator Danışmanı',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
      advisorUserIds: [teacherA.id, teacherA.id, teacherB.id],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.filter((advisor: { userId: string; isPrimary: boolean }) => advisor.userId === teacherA.id)).toHaveLength(1)
    expect(detail.advisors.find((advisor: { userId: string; isPrimary: boolean }) => advisor.userId === teacherA.id)?.isPrimary).toBe(true)
  })

  it('TEACHER seçilen pasif veya TEACHER olmayan danışmanları reddeder ve proje kaydını geri alır', async () => {
    const invalidAdvisors: Array<{ title: string; userId: string }> = [
      { title: 'Pasif danışman', userId: 'inactive-teacher' },
      { title: 'TEACHER olmayan danışman', userId: admin.id },
      { title: 'Olmayan kullanıcı', userId: 'missing-user' },
    ]
    for (const { title, userId } of invalidAdvisors) {
      await expect(projectService.createProject(teacherA, {
        title,
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'TEACHER',
        participationType: 'INDIVIDUAL',
        enrollmentIds: [],
        advisorUserIds: [userId],
      })).rejects.toThrow(ProjectRuleError)
      const projects = await db.select().from(schema.projects).where(eq(schema.projects.title, title))
      expect(projects).toHaveLength(0)
    }
  })

  it('TEACHER STUDENT projesini API üzerinden birden fazla danışmanla oluşturur; yalnızca sahibi düzenleyebilir', async () => {
    const createResponse = await handleApiRequest({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-test-user-id': teacherA.id },
      body: {
        title: 'Danışmanlı Öğrenci Projesi',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        projectType: 'STUDENT',
        participationType: 'TEAM',
        teamName: 'Araştırma Takımı',
        enrollmentIds: ['enroll-1', 'enroll-2'],
        advisorUserIds: [teacherB.id, 'teacher-c'],
      },
    }, db)

    expect(createResponse.statusCode).toBe(201)
    const { projectId } = (createResponse.payload as { success: true; data: { projectId: string } }).data
    const detail = await projectService.getProjectDetail(teacherB, projectId)
    expect(detail.advisors).toHaveLength(3)
    expect(detail.advisors.find((advisor: { userId: string }) => advisor.userId === teacherA.id)?.isPrimary).toBe(true)
    expect(detail.advisors.find((advisor: { userId: string }) => advisor.userId === teacherB.id)?.isPrimary).toBe(false)
    expect(detail.advisors.find((advisor: { userId: string }) => advisor.userId === 'teacher-c')?.isPrimary).toBe(false)
    await expect(projectService.updateProject(teacherB, projectId, { title: 'Yetkisiz değişiklik' }))
      .rejects.toThrow(AuthorizationError)
    await expect(projectService.updateProjectAdvisors(teacherB, projectId, { addUserIds: ['teacher-c'] }))
      .rejects.toThrow(AuthorizationError)
    await expect(projectService.updateProject(teacherA, projectId, { title: 'Sahip güncelledi' }))
      .resolves.toBeDefined()
  })

  it('TEACHER STUDENT creation rejects inactive, non-teacher and missing advisor accounts transactionally', async () => {
    const invalidAdvisors = ['inactive-teacher', 'deleted-teacher', admin.id, 'missing-teacher']
    for (const [index, advisorUserId] of invalidAdvisors.entries()) {
      const title = `Geçersiz öğrenci danışmanı ${index}`
      const response = await handleApiRequest({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-test-user-id': teacherA.id },
        body: {
          title,
          academicYearId: 'year-2024',
          categoryId: 'category-etwinning',
          statusId: 'status-draft',
          projectType: 'STUDENT',
          participationType: 'INDIVIDUAL',
          enrollmentIds: ['enroll-1'],
          advisorUserIds: [advisorUserId],
        },
      }, db)
      expect(response.statusCode).toBe(422)
      expect(await db.select().from(schema.projects).where(eq(schema.projects.title, title))).toHaveLength(0)
    }
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
      categoryId: 'category-special-school',
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
