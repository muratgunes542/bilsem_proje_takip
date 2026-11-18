import { createClient, type Client } from '@libsql/client'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
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
import { ReportService } from '../server/services/report-service'

describe('Decoupled Class Advisorship and Project Advisorship Comprehensive Test Suite', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService
  let studentService: StudentService
  let reportService: ReportService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const otherAdmin: AuthenticatedUser = { id: 'admin-2', role: 'ADMIN', isActive: true }
  const teacherA: AuthenticatedUser = { id: 'teacher-a', role: 'TEACHER', isActive: true }
  const teacherB: AuthenticatedUser = { id: 'teacher-b', role: 'TEACHER', isActive: true }
  const teacherC: AuthenticatedUser = { id: 'teacher-c', role: 'TEACHER', isActive: true }
  const teacherProjectAdvisor: AuthenticatedUser = { id: 'teacher-p', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `project-advisors-decoupled-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Yönetici 1', email: 'admin1@test.com', role: 'ADMIN', isActive: true },
      { id: otherAdmin.id, name: 'Yönetici 2', email: 'admin2@test.com', role: 'ADMIN', isActive: true },
      { id: teacherA.id, name: 'Öğretmen A (Sınıf Danışmanı 1)', email: 'teachera@test.com', role: 'TEACHER', isActive: true },
      { id: teacherB.id, name: 'Öğretmen B (Sınıf Danışmanı 2)', email: 'teacherb@test.com', role: 'TEACHER', isActive: true },
      { id: teacherC.id, name: 'Öğretmen C (Sınıf Danışmanı 3)', email: 'teacherc@test.com', role: 'TEACHER', isActive: true },
      { id: teacherProjectAdvisor.id, name: 'Öğretmen P (Proje Danışmanı)', email: 'teacherp@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 'student-1', bilsemNo: '1001', firstName: 'Ahmet', lastName: 'Yılmaz' },
      { id: 'student-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
      { id: 'student-3', bilsemNo: '1003', firstName: 'Mehmet', lastName: 'Demir' },
      { id: 'student-4', bilsemNo: '1004', firstName: 'Zeynep', lastName: 'Çelik' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 'student-1', academicYearId: 'year-2024', schoolName: '5. Sınıf A', className: '5-A', gradeLevel: 5, advisorUserId: null, advisorName: null, isActive: true },
      { id: 'enroll-2', studentId: 'student-2', academicYearId: 'year-2024', schoolName: '6. Sınıf B', className: '6-B', gradeLevel: 6, advisorUserId: null, advisorName: null, isActive: true },
      { id: 'enroll-3', studentId: 'student-3', academicYearId: 'year-2024', schoolName: '7. Sınıf C', className: '7-C', gradeLevel: 7, advisorUserId: null, advisorName: null, isActive: true },
      { id: 'enroll-4', studentId: 'student-4', academicYearId: 'year-2024', schoolName: '8. Sınıf D', className: '8-D', gradeLevel: 8, advisorUserId: null, advisorName: null, isActive: true },
    ])

    projectService = new ProjectService(db)
    studentService = new StudentService(db)
    reportService = new ReportService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. BÜTÜNLEŞİK TEST: 3 farklı sınıftan öğrenci, sınıf danışmanları ve proje danışmanlığı tam bağımsızlığı', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Bütünleşik Üç Sınıflı Proje',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Farklı Sınıflar Takımı',
      enrollmentIds: ['enroll-1', 'enroll-2', 'enroll-3'],
      advisorUserIds: [teacherProjectAdvisor.id],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherProjectAdvisor.id)

    const history1 = await studentService.getProjectHistory(admin, 'student-1')
    expect(history1[0]?.advisors).toEqual([{ userId: teacherProjectAdvisor.id, name: 'Öğretmen P (Proje Danışmanı)' }])

    const projectAdvisorResult = await reportService.listStudents(admin, {
      academicYearId: 'year-2024',
      advisorUserId: teacherProjectAdvisor.id,
    })
    expect(projectAdvisorResult.students.map((s: any) => s.studentId)).toEqual(
      expect.arrayContaining(['student-1', 'student-2', 'student-3']),
    )
  })

  it('2. TEACHER proje oluşturduğunda kendisi varsayılan danışman olur', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Teacher Created Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherA.id)
  })

  it('3. ADMIN öğretmen seçerse yalnızca seçilen öğretmenler atanır', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Admin Selected Teachers Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherB.id, teacherC.id],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.map((a: any) => a.userId)).toEqual([teacherB.id, teacherC.id])
  })

  it('4. ADMIN kendisini ve başka bir öğretmeni seçerse ikisi de atanır', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Admin Self and Teacher Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [admin.id, teacherB.id],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(admin.id)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherB.id)
  })

  it('5. ADMIN danışman seçmezse işlem hata vermez; kendisi birincil danışman olur', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Admin No Advisor Selected Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(admin.id)
    expect(detail.advisors[0]?.isPrimary).toBe(true)
  })

  it('6. Başka bir ADMIN hesabı, yalnızca kendi hesabı istisnasına dayanılarak danışman olarak atanamaz', async () => {
    await expect(
      projectService.createProject(admin, {
        title: 'Other Admin Advisor Assignment',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        participationType: 'INDIVIDUAL',
        enrollmentIds: ['enroll-1'],
        advisorUserIds: [otherAdmin.id],
      }),
    ).rejects.toThrow('Seçilen danışman aktif bir öğretmen olmalıdır.')
  })

  it('7. TEACHER, öğrenci projesinde ek öğretmenleri danışman olarak seçebilir', async () => {
    const created = await projectService.createProject(teacherA, {
        title: 'Teacher Student Advisor Selection',
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        participationType: 'INDIVIDUAL',
        enrollmentIds: ['enroll-1'],
        advisorUserIds: [teacherB.id],
      })
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.find((advisor: { userId: string }) => advisor.userId === teacherA.id)?.isPrimary).toBe(true)
    expect(detail.advisors.find((advisor: { userId: string }) => advisor.userId === teacherB.id)?.isPrimary).toBe(false)
  })

  it('8. Sınıf danışmanları hiçbir senaryoda proje danışmanı olarak eklenmez', async () => {
    const created = await projectService.createProject(teacherProjectAdvisor, {
      title: 'No Class Advisor Auto Assignment',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherProjectAdvisor.id)
  })

  it('9. ADMIN kendi danışman kaydını sonradan düzenlerken yetkilendirme hatası oluşmaz', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Admin Self Update Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [admin.id] })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(admin.id)
  })

  it('10. Proje listesi, detay ve öğrenci geçmişi danışman tutarlılığı kontrolleri', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'List and Detail Consistency Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const list = await projectService.listProjects(admin, { academicYearId: 'year-2024' })
    const listItem = list.find((p) => p.id === created.projectId)
    expect(listItem?.advisors).toEqual(['Öğretmen A (Sınıf Danışmanı 1)'])

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherA.id)

    const history = await studentService.getProjectHistory(admin, 'student-1')
    const historyItem = history.find((h) => h.projectId === created.projectId)
    expect(historyItem?.advisors).toEqual([{ userId: teacherA.id, name: 'Öğretmen A (Sınıf Danışmanı 1)' }])
  })

  it('11. Proje danışmanı filtresinin (advisorUserId) doğru çalıştığının doğrulanması', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Advisor Filter Test Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherB.id],
    })

    const filteredList = await projectService.listProjects(admin, { advisorUserId: teacherB.id })
    expect(filteredList.map((p) => p.id)).toContain(created.projectId)

    const emptyList = await projectService.listProjects(admin, { advisorUserId: teacherC.id })
    expect(emptyList.map((p) => p.id)).not.toContain(created.projectId)
  })

  it('12. Danışman çıkarıldığında ilgili kayıt soft-delete olmalı ve deletedAt, deletedBy alanları doğrulanmalı', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Soft Delete Fields Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id, teacherB.id],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherB.id] })

    const dbRows = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacherB.id)))

    expect(dbRows).toHaveLength(1)
    expect(dbRows[0]?.deletedAt).not.toBeNull()
    expect(dbRows[0]?.deletedBy).toBe(admin.id)
  })

  it('13. Yeniden etkinleştirilen danışmanın isPrimary: false olması ve diğer danışmanın primary durumunun korunması, deletedAt/deletedBy sıfırlanarak aynı kaydın kullanılması', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Reactivation Fields Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id, teacherB.id],
    })

    const rowsBefore = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacherB.id)))
    const createdAtBefore = rowsBefore[0]?.createdAt

    await projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherB.id] })
    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherB.id] })

    const rowsAfter = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacherB.id)))

    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0]?.createdAt).toEqual(createdAtBefore)
    expect(rowsAfter[0]?.deletedAt).toBeNull()
    expect(rowsAfter[0]?.deletedBy).toBeNull()
    expect(rowsAfter[0]?.isPrimary).toBe(false)

    const teacherARow = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacherA.id), isNull(schema.projectAdvisors.deletedAt)))

    expect(teacherARow).toHaveLength(1)
    expect(teacherARow[0]?.isPrimary).toBe(true)
  })

  it('14. Primary danışman çıkarıldığında kalan danışmanın primary olması; eski danışman yeniden eklendiğinde primary durumunun bozulmaması', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Primary Devri ve Korunumu Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id, teacherB.id],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherA.id] })
    let detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherB.id)
    expect(detail.advisors[0]?.isPrimary).toBe(true)

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherA.id] })
    detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.find((a: any) => a.userId === teacherB.id)?.isPrimary).toBe(true)
    expect(detail.advisors.find((a: any) => a.userId === teacherA.id)?.isPrimary).toBe(false)
  })

  it('15. Birden fazla primary içeren bozuk kayıtların otomatik düzeltilmesi (Reconciliation)', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Corrupted Multi-Primary Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id, teacherB.id],
    })

    await db.update(schema.projectAdvisors).set({ isPrimary: true }).where(eq(schema.projectAdvisors.projectId, created.projectId))

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherC.id] })

    const activeAdvisors = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), isNull(schema.projectAdvisors.deletedAt)))

    const primaryCount = activeAdvisors.filter((a: any) => a.isPrimary).length
    expect(primaryCount).toBe(1)
  })

  it('16. Legacy kimliklerin hem ekleme hem çıkarma isteklerinde reddedilmesi', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Legacy Rejection Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id],
    })

    await expect(
      projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: ['legacy:Dış Hoca'] }),
    ).rejects.toThrow(ProjectRuleError)

    await expect(
      projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: ['legacy:Dış Hoca'] }),
    ).rejects.toThrow(ProjectRuleError)
  })

  it('17. Başarısız işlemde hem proje danışman kayıtlarının hem audit kayıtlarının değişmemesi (Transaction Rollback)', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Strict Rollback Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id],
    })

    const advisorsBefore = await db.select().from(schema.projectAdvisors).where(eq(schema.projectAdvisors.projectId, created.projectId))
    const auditCountBefore = (await db.select().from(schema.auditLogs)).length

    await expect(
      projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: ['non-existent-user-id'] }),
    ).rejects.toThrow()

    const advisorsAfter = await db.select().from(schema.projectAdvisors).where(eq(schema.projectAdvisors.projectId, created.projectId))
    const auditCountAfter = (await db.select().from(schema.auditLogs)).length

    expect(advisorsAfter).toEqual(advisorsBefore)
    expect(auditCountAfter).toBe(auditCountBefore)
  })

  it('18. addTeamMember işlemi sınıf danışmanını proje danışmanına aktarmaz ve mevcut proje danışmanlarını korur', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Add Team Member Preservation Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team 1',
      enrollmentIds: ['enroll-1', 'enroll-4'],
      advisorUserIds: [teacherProjectAdvisor.id],
    })

    await projectService.addTeamMember(admin, created.projectId, 'enroll-2')
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherProjectAdvisor.id)
    expect(detail.advisors.map((a: any) => a.userId)).not.toContain(teacherB.id)
  })

  it('19. convertToTeam işlemi sınıf danışmanını proje danışmanına aktarmaz ve mevcut proje danışmanlarını korur', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Convert To Team Preservation Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherProjectAdvisor.id],
    })

    await projectService.convertToTeam(admin, created.projectId, {
      teamName: 'Preservation Team',
      additionalEnrollmentIds: ['enroll-3'],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherProjectAdvisor.id)
    expect(detail.advisors.map((a: any) => a.userId)).not.toContain(teacherC.id)
  })

  it('20. Audit kaydında beforeJson ve afterJson gerçek danışman listelerini içerir', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Audit Detail Content Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherB.id] })

    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, created.projectId), eq(schema.auditLogs.action, 'PROJECT_ADVISORS_UPDATED')))

    expect(logs).toHaveLength(1)
    const before = JSON.parse(logs[0]!.beforeJson!)
    const after = JSON.parse(logs[0]!.afterJson!)

    expect(before.advisors).toEqual([{ userId: teacherA.id, name: 'Öğretmen A (Sınıf Danışmanı 1)', isPrimary: true }])
    expect(after.advisors).toHaveLength(2)
  })

  it('21. Projeyi oluşturan ADMIN farklı bir ADMIN iken ikinci ADMIN danışman ekleyebilmeli', async () => {
    const created = await projectService.createProject(otherAdmin, {
      title: 'Other Admin Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherA.id] })
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherA.id)
  })

  it('22. Eski projenin sahibi pasif veya silinmiş bir kullanıcıysa ADMIN geçerli danışman ekleyebilmeli', async () => {
    const legacyProjId = 'legacy-inactive-creator'
    await db.insert(schema.users).values({ id: 'inactive-user', name: 'Inactive User', email: 'inactive@test.com', role: 'TEACHER', isActive: false, deletedAt: new Date() })
    await db.insert(schema.projects).values({
      id: legacyProjId,
      title: 'Inactive Creator Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: 'inactive-user',
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyProjId, enrollmentId: 'enroll-1' })

    await projectService.updateProjectAdvisors(admin, legacyProjId, { addUserIds: [teacherA.id] })
    const detail = await projectService.getProjectDetail(admin, legacyProjId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherA.id)
  })

  it('23. Danışman eklenirken tek primary garantisi korunmalı', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Single Primary Guarantee Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherB.id, teacherC.id] })
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    const primaries = detail.advisors.filter((a: any) => a.isPrimary)
    expect(primaries).toHaveLength(1)
  })

  it('24. Eski danışman uyumluluğu: project_advisors kaydı olmayan projede student_enrollments.advisorUserId fallback olarak gösterilir; soft-delete edilmiş kayıtlar tekrar gösterilmez ve aynı danışman birden fazla öğrencide olsa bile tek kez gösterilir', async () => {
    const legacyProjId = 'legacy-proj-fallback'
    await db.update(schema.studentEnrollments).set({ advisorUserId: teacherA.id }).where(inArray(schema.studentEnrollments.id, ['enroll-1', 'enroll-4']))
    await db.insert(schema.projects).values({
      id: legacyProjId,
      title: 'Legacy Fallback Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: admin.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values([
      { projectId: legacyProjId, enrollmentId: 'enroll-1' },
      { projectId: legacyProjId, enrollmentId: 'enroll-4' },
    ])

    const detail = await projectService.getProjectDetail(admin, legacyProjId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherA.id)
    expect((detail.advisors[0] as any).source).toBe('ENROLLMENT')

    const legacyProj2Id = 'legacy-proj-deleted'
    await db.update(schema.studentEnrollments).set({ advisorUserId: teacherB.id }).where(eq(schema.studentEnrollments.id, 'enroll-2'))
    await db.insert(schema.projects).values({
      id: legacyProj2Id,
      title: 'Legacy Deleted Exclusion Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: admin.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyProj2Id, enrollmentId: 'enroll-2' })
    await db.insert(schema.projectAdvisors).values({
      projectId: legacyProj2Id,
      userId: teacherB.id,
      isPrimary: false,
      deletedAt: new Date(),
      deletedBy: admin.id,
    })

    const detail2 = await projectService.getProjectDetail(admin, legacyProj2Id)
    expect(detail2.advisors).toHaveLength(0)

    const filtered = await projectService.listProjects(admin, { advisorUserId: teacherA.id })
    expect(filtered.map((p: any) => p.id)).toContain(legacyProjId)
  })

  it('25. Sınıf danışmanının otomatik proje danışmanlığı kuralı: Projede aktif explicit danışman bulunuyorsa, öğrencinin sınıf danışmanı otomatik proje danışmanı olarak eklenmez (decoupled kural)', async () => {
    await db.update(schema.studentEnrollments).set({ advisorUserId: teacherB.id }).where(eq(schema.studentEnrollments.id, 'enroll-2'))
    const created = await projectService.createProject(admin, {
      title: 'Decoupled Class Advisor Test Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-2'], // student-2 enrollment advisor: teacherB
      advisorUserIds: [teacherA.id], // explicit advisor: teacherA
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    const advisorUserIds = detail.advisors.map((a: any) => a.userId)
    expect(advisorUserIds).toContain(teacherA.id)
    expect(advisorUserIds).not.toContain(teacherB.id)
  })

  it('26. getProjectHistory doğrudan testleri: Enrolling legacy advisor, soft-delete exclusion, deduplication, ve STUDENT dışı projelerin filtrelenmesi', async () => {
    const legacyStudentProjId = 'legacy-student-hist'
    await db.update(schema.studentEnrollments).set({ advisorUserId: teacherA.id }).where(eq(schema.studentEnrollments.id, 'enroll-1'))
    await db.insert(schema.projects).values({
      id: legacyStudentProjId,
      title: 'Legacy Student History Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'STUDENT',
      createdBy: admin.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyStudentProjId, enrollmentId: 'enroll-1' })

    await projectService.createProject(teacherA, {
      title: 'Teacher Project with Student',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const history = await studentService.getProjectHistory(admin, 'student-1')
    expect(history.some((h) => h.projectId === legacyStudentProjId)).toBe(true)
    const histItem = history.find((h) => h.projectId === legacyStudentProjId)
    expect(histItem?.advisors).toEqual([{ userId: teacherA.id, name: 'Öğretmen A (Sınıf Danışmanı 1)' }])
    expect(history.some((h) => h.title === 'Teacher Project with Student')).toBe(false)
  })

  it('27. Pasif öğrenci kaydının (isActive: false) legacy fallback danışman üretmemesi', async () => {
    const legacyInactiveProj = 'legacy-inactive-enroll'
    await db.update(schema.studentEnrollments).set({ isActive: false, advisorUserId: teacherA.id }).where(eq(schema.studentEnrollments.id, 'enroll-1'))
    await db.insert(schema.projects).values({
      id: legacyInactiveProj,
      title: 'Legacy Inactive Enrollment Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: admin.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyInactiveProj, enrollmentId: 'enroll-1' })

    const detail = await projectService.getProjectDetail(admin, legacyInactiveProj)
    expect(detail.advisors).toHaveLength(0)
  })

  it('28. Son aktif danışman projeden çıkarılamaz (Minimum danışman kuralı)', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Min Advisor Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacherA.id],
    })

    await expect(
      projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherA.id] }),
    ).rejects.toThrow(ProjectRuleError)
  })

  it('29. updateProjectAdvisors() yazma aşaması işlem geri alması (Write-Phase Transaction Rollback)', async () => {
    const legacyProjId = 'legacy-rollback-proj'
    await db.insert(schema.projects).values({
      id: legacyProjId,
      title: 'Legacy Rollback Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: admin.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyProjId, enrollmentId: 'enroll-1' })
    await db.update(schema.studentEnrollments).set({ advisorUserId: teacherA.id }).where(eq(schema.studentEnrollments.id, 'enroll-1'))

    const advisorsBefore = await db.select().from(schema.projectAdvisors).where(eq(schema.projectAdvisors.projectId, legacyProjId))
    expect(advisorsBefore).toHaveLength(0)
    const auditsBefore = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, legacyProjId))

    await expect(
      projectService.updateProjectAdvisors(admin, legacyProjId, { removeUserIds: [teacherA.id], addUserIds: [] }),
    ).rejects.toThrow(ProjectRuleError)

    const advisorsAfter = await db.select().from(schema.projectAdvisors).where(eq(schema.projectAdvisors.projectId, legacyProjId))
    const auditsAfter = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, legacyProjId))

    expect(advisorsAfter).toEqual(advisorsBefore)
    expect(auditsAfter).toEqual(auditsBefore)
    expect(advisorsAfter).toHaveLength(0)
  })

  it('30. TEACHER projesinde son aktif danışmanın çıkarılması engellenmeli (Minimum danışman kuralı)', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Teacher Type Min Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })

    const detailBefore = await projectService.getProjectDetail(admin, created.projectId)
    expect(detailBefore.advisors).toHaveLength(1)
    const teacherAId = detailBefore.advisors[0]?.userId

    await expect(
      projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherAId!] }),
    ).rejects.toThrow(ProjectRuleError)

    const advisorRows = await db.select().from(schema.projectAdvisors).where(eq(schema.projectAdvisors.projectId, created.projectId))
    expect(advisorRows).toHaveLength(1)
    expect(advisorRows[0]?.deletedAt).toBeNull()
    expect(advisorRows[0]?.deletedBy).toBeNull()
    expect(advisorRows[0]?.isPrimary).toBe(true)
  })

  it('31. Öğrenci projesini oluşturan öğretmen kendi projesine danışman ekleyebilir', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Owner Teacher Adding Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] })

    const detail = await projectService.getProjectDetail(teacherA, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherA.id)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherB.id)
  })

  it('32. Proje sahibi olmayan öğretmen danışman ekleyemez ve ek danışman başka danışman ekleyemez', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Non-Owner Teacher Cannot Add Advisor',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await expect(
      projectService.updateProjectAdvisors(teacherB, created.projectId, { addUserIds: [teacherC.id] }),
    ).rejects.toThrow('Yalnızca projenin sahibi olan öğretmen danışman ekleyebilir.')

    await projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] })

    await expect(
      projectService.updateProjectAdvisors(teacherB, created.projectId, { addUserIds: [teacherC.id] }),
    ).rejects.toThrow('Yalnızca projenin sahibi olan öğretmen danışman ekleyebilir.')
  })

  it('33. Proje sahibi öğretmen danışman çıkaramaz', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Owner Teacher Cannot Remove Advisor',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] })

    await expect(
      projectService.updateProjectAdvisors(teacherA, created.projectId, { removeUserIds: [teacherB.id] }),
    ).rejects.toThrow('Danışman çıkarma yetkisi yalnızca yöneticilere aittir.')
  })

  it('33a. TEACHER olmayan ADMIN dışı kullanıcı, proje sahibi olsa bile danışman ekleyemez', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Unexpected Role Cannot Add Advisor',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })
    const unexpectedRoleActor = { ...teacherA }
    Object.defineProperty(unexpectedRoleActor, 'role', { value: 'STUDENT' })

    await expect(
      projectService.updateProjectAdvisors(unexpectedRoleActor, created.projectId, { addUserIds: [teacherB.id] }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('34. Ek danışman projeyi görüntüleyebilir fakat düzenleyemez', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Advisor View vs Modify Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] })

    const detail = await projectService.getProjectDetail(teacherB, created.projectId)
    expect(detail.project.id).toBe(created.projectId)

    await expect(
      projectService.updateProject(teacherB, created.projectId, { title: 'Unauthorized Edit Title' }),
    ).rejects.toThrow(AuthorizationError)
  })

  it('34a. TEACHER ve INSTITUTION proje türlerinde danışman yönetimi ADMIN ile sınırlı kalır', async () => {
    const teacherProject = await projectService.createProject(teacherA, {
      title: 'Teacher Type Advisor Authorization',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'TEACHER',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })
    const institutionProject = await projectService.createProject(admin, {
      title: 'Institution Type Advisor Authorization',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      projectType: 'INSTITUTION',
      participationType: 'INDIVIDUAL',
      enrollmentIds: [],
    })

    await expect(
      projectService.updateProjectAdvisors(teacherA, teacherProject.projectId, { addUserIds: [teacherB.id] }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      projectService.updateProjectAdvisors(teacherA, institutionProject.projectId, { addUserIds: [teacherB.id] }),
    ).rejects.toMatchObject({ statusCode: 403 })

    for (const projectId of [teacherProject.projectId, institutionProject.projectId]) {
      await projectService.updateProjectAdvisors(admin, projectId, { addUserIds: [teacherB.id] })
      await projectService.updateProjectAdvisors(admin, projectId, { removeUserIds: [teacherB.id] })
      const detail = await projectService.getProjectDetail(admin, projectId)
      expect(detail.advisors.map((advisor: { userId: string }) => advisor.userId)).not.toContain(teacherB.id)
    }
  })

  it('35. ADMIN danışman ekleyebilir ve silebilir', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Admin Full Advisor Control Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProjectAdvisors(admin, created.projectId, { addUserIds: [teacherB.id] })
    let detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)

    await projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherB.id] })
    detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacherA.id)
  })

  it('36. Mükerrer danışman ekleme reddedilir ve önceden silinen danışman tekrar eklendiğinde reactivate edilir', async () => {
    const created = await projectService.createProject(teacherA, {
      title: 'Duplicate and Reactivation Advisor Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    await projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] })

    await expect(
      projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] }),
    ).rejects.toThrow('Seçilen öğretmen zaten projenin aktif danışmanıdır.')

    await projectService.updateProjectAdvisors(admin, created.projectId, { removeUserIds: [teacherB.id] })

    await projectService.updateProjectAdvisors(teacherA, created.projectId, { addUserIds: [teacherB.id] })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors.map((a: any) => a.userId)).toContain(teacherB.id)
  })
})
