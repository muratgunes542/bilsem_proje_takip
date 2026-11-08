import { createClient, type Client } from '@libsql/client'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService, ProjectRuleError } from '../server/services/project-service'
import { StudentService } from '../server/services/student-service'

describe('Project Advisors Assignment and Fallback Tests (8 Scenarios)', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }
  const teacher1: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }
  const teacher2: AuthenticatedUser = { id: 'teacher-2', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `project-advisors-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin User', email: 'admin@test.com', role: 'ADMIN', isActive: true },
      { id: teacher1.id, name: 'Teacher One', email: 'teacher1@test.com', role: 'TEACHER', isActive: true },
      { id: teacher2.id, name: 'Teacher Two', email: 'teacher2@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 's-1', bilsemNo: '1001', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 's-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 's-1', academicYearId: 'year-2024', advisorUserId: teacher1.id, advisorName: 'Teacher One', isActive: true },
      { id: 'enroll-2', studentId: 's-2', academicYearId: 'year-2024', advisorUserId: teacher1.id, advisorName: 'Teacher One', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  it('1. Öğretmen proje oluşturduğunda öğrenci danışmanlarının otomatik atanması ve projectAdvisors tablosuna kaydedilmesi', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Teacher Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const dbRows = await db
      .select()
      .from(schema.projectAdvisors)
      .where(eq(schema.projectAdvisors.projectId, created.projectId))

    expect(dbRows).toHaveLength(1)
    expect(dbRows[0]?.userId).toBe(teacher1.id)
    expect(dbRows[0]?.isPrimary).toBe(true)

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher1.id)
  })

  it('2. Yönetici çoklu danışman seçtiğinde tüm danışmanların kaydedilmesi', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Multi Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacher1.id, teacher2.id],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.map(a => a.userId)).toContain(teacher1.id)
    expect(detail.advisors.map(a => a.userId)).toContain(teacher2.id)
  })

  it('3. Yönetici danışman seçmediğinde otomatik danışman belirlenmesi', async () => {
    const created = await projectService.createProject(admin, {
      title: 'Auto Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher1.id)
  })

  it('4. Öğretmenin yetkisiz danışman göndermesinin engellenmesi (advisorUserIds gönderemez)', async () => {
    await expect(projectService.createProject(teacher1, {
      title: 'Forbidden Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacher2.id],
    })).rejects.toThrow(ProjectRuleError)

    await expect(projectService.createProject(teacher1, {
      title: 'Teacher Empty Array Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [],
    })).rejects.toThrow(ProjectRuleError)

    await expect(projectService.createProject(teacher1, {
      title: 'Teacher Own ID Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacher1.id],
    })).rejects.toThrow(ProjectRuleError)
  })

  it('5. Pasif veya TEACHER rolünde olmayan kullanıcının danışman olarak atanamaması', async () => {
    await expect(projectService.createProject(admin, {
      title: 'Invalid Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [admin.id], // Admin cannot be project advisor
    })).rejects.toThrow(ProjectRuleError)
  })

  it('6 & 7. Eski projelerde danışman bilgilerinin öğrenci kayıtlarından gösterilmesi ve tekrarlı danışmanların tekilleştirilmesi', async () => {
    const legacyProjId = 'legacy-proj-1'
    await db.insert(schema.projects).values({
      id: legacyProjId,
      title: 'Legacy Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: teacher1.id,
      participationType: 'TEAM',
    })
    // Both students have teacher1 as advisor -> should be deduplicated to 1 advisor
    await db.insert(schema.projectStudents).values([
      { projectId: legacyProjId, enrollmentId: 'enroll-1' },
      { projectId: legacyProjId, enrollmentId: 'enroll-2' },
    ])

    const list = await projectService.listProjects(admin, { academicYearId: 'year-2024' })
    const legacy = list.find(p => p.id === legacyProjId)
    expect(legacy?.advisors).toEqual(['Teacher One'])

    const detail = await projectService.getProjectDetail(admin, legacyProjId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher1.id)
  })

  it('8. Mevcut proje dönüştürme ve yetkilendirme testlerinin çalışmaya devam etmesi', async () => {
    const created = await projectService.createProject(teacher1, {
      title: 'Conversion Test Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const teamRes = await projectService.convertToTeam(teacher1, created.projectId, {
      teamName: 'Conversion Team',
      additionalEnrollmentIds: ['enroll-2'],
    })
    expect(teamRes.projectId).toBe(created.projectId)

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.project.participationType).toBe('TEAM')
  })

  it('9. StudentService.getProjectHistory handles both project_advisors and legacy student enrollment advisors without duplicates', async () => {
    const studentService = new StudentService(db)

    // 1. Project with explicit project_advisors
    const createdWithAdvisor = await projectService.createProject(admin, {
      title: 'Explicit Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacher2.id],
    })

    // 2. Legacy project without project_advisors
    const legacyProjId = 'legacy-student-proj'
    await db.insert(schema.projects).values({
      id: legacyProjId,
      title: 'Legacy Student Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: teacher1.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyProjId, enrollmentId: 'enroll-1' })

    const history = await studentService.getProjectHistory(admin, 's-1')
    expect(history).toHaveLength(2)

    const explicitItem = history.find((h) => h.projectId === createdWithAdvisor.projectId)
    expect(explicitItem?.advisors).toEqual([{ userId: teacher2.id, name: 'Teacher Two' }])

    const legacyItem = history.find((h) => h.projectId === legacyProjId)
    expect(legacyItem?.advisors).toEqual([{ userId: teacher1.id, name: 'Teacher One' }])
  })

  it('10. Handles empty array, omitted field, and duplicate advisor User IDs correctly', async () => {
    // Duplicate IDs in advisorUserIds should be deduplicated
    const dupCreated = await projectService.createProject(admin, {
      title: 'Duplicate Advisor Input Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [teacher1.id, teacher1.id],
    })
    const dupDetail = await projectService.getProjectDetail(admin, dupCreated.projectId)
    expect(dupDetail.advisors).toHaveLength(1)
    expect(dupDetail.advisors[0]?.userId).toBe(teacher1.id)

    // Empty array advisorUserIds: [] explicitly means no project_advisors records
    const emptyCreated = await projectService.createProject(admin, {
      title: 'Empty Advisor Input Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
      advisorUserIds: [],
    })
    const emptyDetail = await projectService.getProjectDetail(admin, emptyCreated.projectId)
    // Dynamic fallback will still return student's enrollment advisor on getProjectDetail
    expect(emptyDetail.advisors).toHaveLength(1)
    expect(emptyDetail.advisors[0]?.userId).toBe(teacher1.id)
  })

  it('11. Text-only advisorName fallback in StudentService.getProjectHistory and ProjectService.getProjectDetail for legacy enrollments without user account', async () => {
    const studentService = new StudentService(db)
    await db.insert(schema.students).values({ id: 's-legacy', bilsemNo: '9999', firstName: 'Mehmet', lastName: 'Demir' })
    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-legacy-text',
      studentId: 's-legacy',
      academicYearId: 'year-2024',
      advisorUserId: null,
      advisorName: 'Dış Danışman Hoca',
      isActive: true,
    })
    const legacyProjId = 'text-legacy-proj'
    await db.insert(schema.projects).values({
      id: legacyProjId,
      title: 'Text Legacy Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: admin.id,
      participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: legacyProjId, enrollmentId: 'enroll-legacy-text' })

    const history = await studentService.getProjectHistory(admin, 's-legacy')
    expect(history).toHaveLength(1)
    expect(history[0]?.advisors).toEqual([{ userId: 'legacy:Dış Danışman Hoca', name: 'Dış Danışman Hoca' }])

    const textLegacyDetail = await projectService.getProjectDetail(admin, legacyProjId)
    expect(textLegacyDetail.advisors).toEqual([
      { userId: 'legacy:Dış Danışman Hoca', name: 'Dış Danışman Hoca', email: '', isPrimary: true },
    ])
  })

  it('12. Öğrencinin sonraki akademik yılda danışmanı değiştiğinde eski projenin danışmanı sabit kalır', async () => {
    // 1. Student s-1 creates a project in 2024 with teacher1 as advisor
    const created = await projectService.createProject(teacher1, {
      title: '2024 Year Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    // Verify stored advisor in projectAdvisors table is teacher1
    const advisorRowsInDb = await db
      .select()
      .from(schema.projectAdvisors)
      .where(eq(schema.projectAdvisors.projectId, created.projectId))
    expect(advisorRowsInDb).toHaveLength(1)
    expect(advisorRowsInDb[0]?.userId).toBe(teacher1.id)

    // 2. Add new academic year 2025 and change student s-1's advisor to teacher2 in 2025 enrollment
    await db.insert(schema.academicYears).values({
      id: 'year-2025',
      name: '2025-2026',
      startsOn: new Date('2025-09-01'),
      endsOn: new Date('2026-06-30'),
      isCurrent: true,
    })
    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-2025',
      studentId: 's-1',
      academicYearId: 'year-2025',
      advisorUserId: teacher2.id,
      advisorName: 'Teacher Two',
      isActive: true,
    })

    // 3. Get 2024 project details -> advisor must STILL be teacher1
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher1.id)
  })

  it('13. Danışmanı olmayan öğrencide oluşturan öğretmenin atanması', async () => {
    await db.insert(schema.students).values({ id: 's-no-advisor', bilsemNo: '9001', firstName: 'No', lastName: 'Advisor' })
    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-no-advisor',
      studentId: 's-no-advisor',
      academicYearId: 'year-2024',
      advisorUserId: null,
      advisorName: null,
      isActive: true,
    })

    const created = await projectService.createProject(teacher1, {
      title: 'No Advisor Student Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-no-advisor'],
    })

    const detail = await projectService.getProjectDetail(teacher1, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher1.id)
  })

  it('14. Farklı danışmanlara sahip takım öğrencilerinin danışmanlarının birleştirilmesi ve tekilleştirilmesi', async () => {
    await db.insert(schema.students).values({ id: 's-3', bilsemNo: '1003', firstName: 'Can', lastName: 'Demir' })
    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-3',
      studentId: 's-3',
      academicYearId: 'year-2024',
      advisorUserId: teacher2.id,
      advisorName: 'Teacher Two',
      isActive: true,
    })

    const created = await projectService.createProject(admin, {
      title: 'Different Advisors Team Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team X',
      enrollmentIds: ['enroll-1', 'enroll-3'],
    })

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(2)
    expect(detail.advisors.map(a => a.userId)).toContain(teacher1.id)
    expect(detail.advisors.map(a => a.userId)).toContain(teacher2.id)

    // Test deduplication when adding enroll-2 (which also has teacher1)
    await db.insert(schema.students).values({ id: 's-dup', bilsemNo: '1005', firstName: 'Dup', lastName: 'Student' })
    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-dup',
      studentId: 's-dup',
      academicYearId: 'year-2024',
      advisorUserId: teacher1.id,
      advisorName: 'Teacher One',
      isActive: true,
    })
    await projectService.addTeamMember(admin, created.projectId, 'enroll-dup')

    const detailAfterAdd = await projectService.getProjectDetail(admin, created.projectId)
    // teacher1 should appear only once despite multiple students having teacher1
    const teacher1Count = detailAfterAdd.advisors.filter(a => a.userId === teacher1.id).length
    expect(teacher1Count).toBe(1)
  })

  it('15. Takım üyesi çıkarıldığında danışmanlık geçmişinin silinmemesi', async () => {
    await db.insert(schema.students).values([
      { id: 's-3', bilsemNo: '1003', firstName: 'Can', lastName: 'Demir' },
      { id: 's-4', bilsemNo: '1004', firstName: 'Deniz', lastName: 'Arı' },
    ])
    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-3', studentId: 's-3', academicYearId: 'year-2024', advisorUserId: teacher2.id, advisorName: 'Teacher Two', isActive: true },
      { id: 'enroll-4', studentId: 's-4', academicYearId: 'year-2024', advisorUserId: teacher2.id, advisorName: 'Teacher Two', isActive: true },
    ])

    const teamProj = await projectService.createProject(admin, {
      title: 'Team Remove Member Test',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team W',
      enrollmentIds: ['enroll-1', 'enroll-2', 'enroll-3'],
    })

    await projectService.removeTeamMember(admin, teamProj.projectId, 'enroll-3')

    const detail = await projectService.getProjectDetail(admin, teamProj.projectId)
    expect(detail.advisors.map(a => a.userId)).toContain(teacher2.id)
  })

  it('16. Pasif veya silinmiş danışmanın geçmiş kaydının korunması', async () => {
    await db.insert(schema.students).values({ id: 's-t2', bilsemNo: '7777', firstName: 'T2', lastName: 'Student' })
    await db.insert(schema.studentEnrollments).values({
      id: 'enroll-t2',
      studentId: 's-t2',
      academicYearId: 'year-2024',
      advisorUserId: teacher2.id,
      advisorName: 'Teacher Two',
      isActive: true,
    })

    const created = await projectService.createProject(admin, {
      title: 'Deactivated Advisor Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-t2'],
      advisorUserIds: [teacher2.id],
    })

    await db.update(schema.users).set({ isActive: false, deletedAt: new Date() }).where(eq(schema.users.id, teacher2.id))

    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher2.id)
    expect(detail.advisors[0]?.name).toBe('Teacher Two')
  })
  it('17. Soft-delete sonrası danışmanın yeniden etkinleştirilmesi (isPrimary korunumu, tekilleştirme ve soft-delete alanlarının sıfırlanması)', async () => {
    // 1. Bir projeye danışman olarak atanmış ve isPrimary = true olan bir öğretmen oluştur.
    const created = await projectService.createProject(teacher1, {
      title: 'Soft-Delete Reactivation Test Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-1'],
    })

    const initialRows = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(
        eq(schema.projectAdvisors.projectId, created.projectId),
        eq(schema.projectAdvisors.userId, teacher1.id),
      ))

    expect(initialRows).toHaveLength(1)
    expect(initialRows[0]?.isPrimary).toBe(true)
    expect(initialRows[0]?.deletedAt).toBeNull()
    expect(initialRows[0]?.deletedBy).toBeNull()

    // 2. Bu danışmanın projectAdvisors kaydını soft-delete durumuna getir.
    const pastDeletedAt = new Date(Date.now() - 60000)
    await db
      .update(schema.projectAdvisors)
      .set({
        deletedAt: pastDeletedAt,
        deletedBy: admin.id,
        updatedAt: pastDeletedAt,
      })
      .where(and(
        eq(schema.projectAdvisors.projectId, created.projectId),
        eq(schema.projectAdvisors.userId, teacher1.id),
      ))

    const softDeletedRows = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(
        eq(schema.projectAdvisors.projectId, created.projectId),
        eq(schema.projectAdvisors.userId, teacher1.id),
      ))
    expect(softDeletedRows).toHaveLength(1)
    expect(softDeletedRows[0]?.deletedAt).toEqual(pastDeletedAt)
    expect(softDeletedRows[0]?.deletedBy).toBe(admin.id)
    expect(softDeletedRows[0]?.isPrimary).toBe(true)

    // 3. Aynı öğretmen projeye yeniden danışman olarak gerektiğinde syncProjectAdvisors() mekanizmasını çalıştır.
    await projectService.syncProjectAdvisors(created.projectId)

    // 4. Çakışma güncellemesi sonucunda mevcut kayıt yeniden etkinleşmeli:
    //    - deletedAt = null
    //    - deletedBy = null
    //    - updatedAt güncellenmiş olmalı.
    //    - isPrimary değeri korunmalı.
    // 5. Aynı proje ve öğretmen için ikinci bir kayıt oluşmamalı.
    const reactivatedRows = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(
        eq(schema.projectAdvisors.projectId, created.projectId),
        eq(schema.projectAdvisors.userId, teacher1.id),
      ))

    expect(reactivatedRows).toHaveLength(1)
    expect(reactivatedRows[0]?.deletedAt).toBeNull()
    expect(reactivatedRows[0]?.deletedBy).toBeNull()
    expect(reactivatedRows[0]?.updatedAt.getTime()).toBeGreaterThan(pastDeletedAt.getTime())
    expect(reactivatedRows[0]?.isPrimary).toBe(true)

    const allProjectAdvisors = await db
      .select()
      .from(schema.projectAdvisors)
      .where(eq(schema.projectAdvisors.projectId, created.projectId))
    expect(allProjectAdvisors).toHaveLength(1)
  })

  it('18. Yönetici tarafından açıkça seçilen danışmanların üç ekranda (detay, liste, öğrenci geçmişi) ve liste filtresinde tutarlılığı', async () => {
    // Öğretmen 3'ü oluştur
    const teacher3: AuthenticatedUser = { id: 'teacher-3', role: 'TEACHER', isActive: true }
    await db.insert(schema.users).values({
      id: teacher3.id,
      name: 'Teacher Three',
      email: 'teacher3@test.com',
      role: 'TEACHER',
      isActive: true,
    })

    // Öğrenci A ve Öğrenci B'yi oluştur
    await db.insert(schema.students).values([
      { id: 's-a', bilsemNo: '3001', firstName: 'Öğrenci', lastName: 'A' },
      { id: 's-b', bilsemNo: '3002', firstName: 'Öğrenci', lastName: 'B' },
    ])

    // Öğrenci A'nın kayıtlı akademik yıl danışmanı: Öğretmen 1
    // Öğrenci B'nin kayıtlı akademik yıl danışmanı: Öğretmen 2
    await db.insert(schema.studentEnrollments).values([
      {
        id: 'enroll-a',
        studentId: 's-a',
        academicYearId: 'year-2024',
        advisorUserId: teacher1.id,
        advisorName: 'Teacher One',
        isActive: true,
      },
      {
        id: 'enroll-b',
        studentId: 's-b',
        academicYearId: 'year-2024',
        advisorUserId: teacher2.id,
        advisorName: 'Teacher Two',
        isActive: true,
      },
    ])

    // Yönetici tarafından proje için açıkça seçilen danışman: Öğretmen 3
    // Yönetici proje oluştururken advisorUserIds: [Öğretmen 3] göndersin
    const created = await projectService.createProject(admin, {
      title: 'Explicit Advisor Multi-Screen Consistency Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team Consistent',
      enrollmentIds: ['enroll-a', 'enroll-b'],
      advisorUserIds: [teacher3.id],
    })

    // 1. Proje detayında yalnızca Öğretmen 3 görünmeli
    const detail = await projectService.getProjectDetail(admin, created.projectId)
    expect(detail.advisors).toHaveLength(1)
    expect(detail.advisors[0]?.userId).toBe(teacher3.id)
    expect(detail.advisors[0]?.name).toBe('Teacher Three')

    // 2. Proje listesinde yalnızca Öğretmen 3 görünmeli
    const projectList = await projectService.listProjects(admin, { academicYearId: 'year-2024' })
    const projectInList = projectList.find((p) => p.id === created.projectId)
    expect(projectInList).toBeDefined()
    expect(projectInList?.advisors).toEqual(['Teacher Three'])

    // 3. Öğrenci A'nın proje geçmişinde yalnızca Öğretmen 3 görünmeli
    const studentService = new StudentService(db)
    const historyA = await studentService.getProjectHistory(admin, 's-a')
    const itemA = historyA.find((p) => p.projectId === created.projectId)
    expect(itemA).toBeDefined()
    expect(itemA?.advisors).toEqual([{ userId: teacher3.id, name: 'Teacher Three' }])

    // 4. Öğrenci B'nin proje geçmişinde yalnızca Öğretmen 3 görünmeli
    const historyB = await studentService.getProjectHistory(admin, 's-b')
    const itemB = historyB.find((p) => p.projectId === created.projectId)
    expect(itemB).toBeDefined()
    expect(itemB?.advisors).toEqual([{ userId: teacher3.id, name: 'Teacher Three' }])

    // 5. Öğretmen 1 ve Öğretmen 2 otomatik olarak bu projeye eklenmemeli
    const dbAdvisors = await db
      .select()
      .from(schema.projectAdvisors)
      .where(eq(schema.projectAdvisors.projectId, created.projectId))
    expect(dbAdvisors).toHaveLength(1)
    expect(dbAdvisors[0]?.userId).toBe(teacher3.id)
    expect(dbAdvisors.map((a) => a.userId)).not.toContain(teacher1.id)
    expect(dbAdvisors.map((a) => a.userId)).not.toContain(teacher2.id)

    // 6. Proje listesinde danışman filtresi Öğretmen 3 için projeyi bulmalı; Öğretmen 1 ve Öğretmen 2 için bulmamalı
    const listFilteredByTeacher3 = await projectService.listProjects(admin, {
      academicYearId: 'year-2024',
      advisorUserId: teacher3.id,
    })
    expect(listFilteredByTeacher3.map((p) => p.id)).toContain(created.projectId)

    const listFilteredByTeacher1 = await projectService.listProjects(admin, {
      academicYearId: 'year-2024',
      advisorUserId: teacher1.id,
    })
    expect(listFilteredByTeacher1.map((p) => p.id)).not.toContain(created.projectId)

    const listFilteredByTeacher2 = await projectService.listProjects(admin, {
      academicYearId: 'year-2024',
      advisorUserId: teacher2.id,
    })
    expect(listFilteredByTeacher2.map((p) => p.id)).not.toContain(created.projectId)
  })
  it('19. Takım üyesi ekleme sırasında açıkça seçilmiş danışmanın korunması ve yalnızca yeni üyenin danışmanının eklenmesi', async () => {
    const teacher3: AuthenticatedUser = { id: 't-19-3', role: 'TEACHER', isActive: true }
    const teacher4: AuthenticatedUser = { id: 't-19-4', role: 'TEACHER', isActive: true }
    await db.insert(schema.users).values([
      { id: teacher3.id, name: 'Teacher Nineteen Three', email: 't19_3@test.com', role: 'TEACHER', isActive: true },
      { id: teacher4.id, name: 'Teacher Nineteen Four', email: 't19_4@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.students).values([
      { id: 's-19-a', bilsemNo: '4001', firstName: 'Öğrenci', lastName: '19A' },
      { id: 's-19-b', bilsemNo: '4002', firstName: 'Öğrenci', lastName: '19B' },
      { id: 's-19-c', bilsemNo: '4003', firstName: 'Öğrenci', lastName: '19C' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-19-a', studentId: 's-19-a', academicYearId: 'year-2024', advisorUserId: teacher1.id, advisorName: 'Teacher One', isActive: true },
      { id: 'enroll-19-b', studentId: 's-19-b', academicYearId: 'year-2024', advisorUserId: teacher2.id, advisorName: 'Teacher Two', isActive: true },
      { id: 'enroll-19-c', studentId: 's-19-c', academicYearId: 'year-2024', advisorUserId: teacher4.id, advisorName: 'Teacher Nineteen Four', isActive: true },
    ])

    // Yönetici Öğretmen 3'ü açık danışman olarak seçerek proje oluşturur (Öğrenci A ve B)
    const created = await projectService.createProject(admin, {
      title: 'Explicit Advisor Team Member Add Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team 19',
      enrollmentIds: ['enroll-19-a', 'enroll-19-b'],
      advisorUserIds: [teacher3.id],
    })

    const initialDetail = await projectService.getProjectDetail(admin, created.projectId)
    expect(initialDetail.advisors).toHaveLength(1)
    expect(initialDetail.advisors[0]?.userId).toBe(teacher3.id)

    // Yeni bir öğrenci (Öğrenci C, danışmanı Öğretmen 4) takıma eklenir
    await projectService.addTeamMember(admin, created.projectId, 'enroll-19-c')

    // Sonuçta Öğretmen 3 korunmalı, yalnızca yeni öğrencinin danışmanı eklenmeli; Öğretmen 1 ve 2 geriye dönük olarak eklenmemeli
    const detailAfterAdd = await projectService.getProjectDetail(admin, created.projectId)
    expect(detailAfterAdd.advisors).toHaveLength(2)
    const advisorUserIds = detailAfterAdd.advisors.map((a) => a.userId)
    expect(advisorUserIds).toContain(teacher3.id)
    expect(advisorUserIds).toContain(teacher4.id)
    expect(advisorUserIds).not.toContain(teacher1.id)
    expect(advisorUserIds).not.toContain(teacher2.id)

    // Veritabanı tablosunda da sadece Öğretmen 3 ve Öğretmen 4 olmalı
    const dbRows = await db
      .select()
      .from(schema.projectAdvisors)
      .where(eq(schema.projectAdvisors.projectId, created.projectId))
    expect(dbRows).toHaveLength(2)
    const dbUserIds = dbRows.map((r) => r.userId)
    expect(dbUserIds).toContain(teacher3.id)
    expect(dbUserIds).toContain(teacher4.id)
    expect(dbUserIds).not.toContain(teacher1.id)
    expect(dbUserIds).not.toContain(teacher2.id)
  })

  it('20. Yeni eklenen öğrencinin danışmanı yoksa aktif proje sahibinin yedek danışman olarak eklenmesi', async () => {
    const teacherOwner: AuthenticatedUser = { id: 't-20-owner', role: 'TEACHER', isActive: true }
    const teacher3: AuthenticatedUser = { id: 't-20-3', role: 'TEACHER', isActive: true }
    await db.insert(schema.users).values([
      { id: teacherOwner.id, name: 'Teacher Twenty Owner', email: 't20_owner@test.com', role: 'TEACHER', isActive: true },
      { id: teacher3.id, name: 'Teacher Twenty Three', email: 't20_3@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.students).values([
      { id: 's-20-a', bilsemNo: '5001', firstName: 'Öğrenci', lastName: '20A' },
      { id: 's-20-b', bilsemNo: '5002', firstName: 'Öğrenci', lastName: '20B' },
      { id: 's-20-d', bilsemNo: '5003', firstName: 'Öğrenci', lastName: '20D' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-20-a', studentId: 's-20-a', academicYearId: 'year-2024', advisorUserId: teacher1.id, advisorName: 'Teacher One', isActive: true },
      { id: 'enroll-20-b', studentId: 's-20-b', academicYearId: 'year-2024', advisorUserId: teacher2.id, advisorName: 'Teacher Two', isActive: true },
      // Danışmanı olmayan öğrenci
      { id: 'enroll-20-d', studentId: 's-20-d', academicYearId: 'year-2024', advisorUserId: null, advisorName: null, isActive: true },
    ])

    // Proje oluşturulur (proje sahibi aktif öğretmen teacherOwner, açık danışman teacher3)
    const projectId = randomUUID()
    await db.insert(schema.projects).values({
      id: projectId,
      title: 'Fallback Owner Advisor Test Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      createdBy: teacherOwner.id,
      participationType: 'TEAM',
      teamName: 'Team 20',
    })
    await db.insert(schema.projectStudents).values([
      { projectId, enrollmentId: 'enroll-20-a' },
      { projectId, enrollmentId: 'enroll-20-b' },
    ])
    await db.insert(schema.projectAdvisors).values({
      projectId,
      userId: teacher3.id,
      isPrimary: true,
    })

    // Danışmanı olmayan öğrenci takıma eklenir
    await projectService.addTeamMember(admin, projectId, 'enroll-20-d')

    // Sonuçta Öğretmen 3 korunmalı, proje sahibi teacherOwner yedek danışman olarak eklenmeli; Öğretmen 1 ve 2 eklenmemeli
    const detail = await projectService.getProjectDetail(admin, projectId)
    expect(detail.advisors).toHaveLength(2)
    const advisorUserIds = detail.advisors.map((a) => a.userId)
    expect(advisorUserIds).toContain(teacher3.id)
    expect(advisorUserIds).toContain(teacherOwner.id)
    expect(advisorUserIds).not.toContain(teacher1.id)
    expect(advisorUserIds).not.toContain(teacher2.id)
  })

  it('21. Takım dönüşümü (convertToTeam) sırasında mevcut danışmanların korunması ve yalnızca yeni katılan öğrencilerin danışmanlarının eklenmesi', async () => {
    const teacher3: AuthenticatedUser = { id: 't-21-3', role: 'TEACHER', isActive: true }
    const teacher4: AuthenticatedUser = { id: 't-21-4', role: 'TEACHER', isActive: true }
    await db.insert(schema.users).values([
      { id: teacher3.id, name: 'Teacher TwentyOne Three', email: 't21_3@test.com', role: 'TEACHER', isActive: true },
      { id: teacher4.id, name: 'Teacher TwentyOne Four', email: 't21_4@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.students).values([
      { id: 's-21-a', bilsemNo: '6001', firstName: 'Öğrenci', lastName: '21A' },
      { id: 's-21-c', bilsemNo: '6002', firstName: 'Öğrenci', lastName: '21C' },
    ])

    await db.insert(schema.studentEnrollments).values([
      // Öğrenci A'nın kayıtlı akademik yıl danışmanı Öğretmen 1
      { id: 'enroll-21-a', studentId: 's-21-a', academicYearId: 'year-2024', advisorUserId: teacher1.id, advisorName: 'Teacher One', isActive: true },
      // Öğrenci C'nin kayıtlı akademik yıl danışmanı Öğretmen 4
      { id: 'enroll-21-c', studentId: 's-21-c', academicYearId: 'year-2024', advisorUserId: teacher4.id, advisorName: 'Teacher TwentyOne Four', isActive: true },
    ])

    // Yönetici bireysel proje oluşturur ve açık danışman olarak Öğretmen 3'ü seçer
    const created = await projectService.createProject(admin, {
      title: 'Convert To Team Advisor Isolation Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'INDIVIDUAL',
      enrollmentIds: ['enroll-21-a'],
      advisorUserIds: [teacher3.id],
    })

    const initialDetail = await projectService.getProjectDetail(admin, created.projectId)
    expect(initialDetail.advisors).toHaveLength(1)
    expect(initialDetail.advisors[0]?.userId).toBe(teacher3.id)

    // Takım projesine dönüştür (Öğrenci C eklenir)
    await projectService.convertToTeam(admin, created.projectId, {
      teamName: 'Converted Team 21',
      additionalEnrollmentIds: ['enroll-21-c'],
    })

    // Sonuç: Öğretmen 3 korunmalı, yalnızca Öğrenci C'nin danışmanı Öğretmen 4 eklenmeli; Öğrenci A'nın danışmanı Öğretmen 1 eklenmemeli
    const detailAfterConvert = await projectService.getProjectDetail(admin, created.projectId)
    expect(detailAfterConvert.advisors).toHaveLength(2)
    const advisorUserIds = detailAfterConvert.advisors.map((a) => a.userId)
    expect(advisorUserIds).toContain(teacher3.id)
    expect(advisorUserIds).toContain(teacher4.id)
    expect(advisorUserIds).not.toContain(teacher1.id)

    const list = await projectService.listProjects(admin, { academicYearId: 'year-2024' })
    const inList = list.find((p) => p.id === created.projectId)
    expect(inList?.advisors).toEqual(expect.arrayContaining(['Teacher TwentyOne Three', 'Teacher TwentyOne Four']))
    expect(inList?.advisors).not.toContain('Teacher One')
  })

  it('22. Danışman daha önce soft-delete edilmişse takım üyesi ekleme sırasında yeniden etkinleştirilmeli ve isPrimary korunmalı', async () => {
    const teacher4: AuthenticatedUser = { id: 't-22-4', role: 'TEACHER', isActive: true }
    await db.insert(schema.users).values({
      id: teacher4.id,
      name: 'Teacher TwentyTwo Four',
      email: 't22_4@test.com',
      role: 'TEACHER',
      isActive: true,
    })

    await db.insert(schema.students).values([
      { id: 's-22-a', bilsemNo: '7001', firstName: 'Öğrenci', lastName: '22A' },
      { id: 's-22-b', bilsemNo: '7002', firstName: 'Öğrenci', lastName: '22B' },
      { id: 's-22-c', bilsemNo: '7003', firstName: 'Öğrenci', lastName: '22C' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-22-a', studentId: 's-22-a', academicYearId: 'year-2024', advisorUserId: teacher1.id, advisorName: 'Teacher One', isActive: true },
      { id: 'enroll-22-b', studentId: 's-22-b', academicYearId: 'year-2024', advisorUserId: teacher2.id, advisorName: 'Teacher Two', isActive: true },
      { id: 'enroll-22-c', studentId: 's-22-c', academicYearId: 'year-2024', advisorUserId: teacher4.id, advisorName: 'Teacher TwentyTwo Four', isActive: true },
    ])

    // Takım projesi oluştur (danışmanlar: teacher1 ve teacher4; teacher1 isPrimary: true, teacher4 isPrimary: false)
    const created = await projectService.createProject(admin, {
      title: 'Soft Delete Reactivation On Add Member Project',
      academicYearId: 'year-2024',
      categoryId: 'category-etwinning',
      statusId: 'status-draft',
      participationType: 'TEAM',
      teamName: 'Team 22',
      enrollmentIds: ['enroll-22-a', 'enroll-22-b'],
      advisorUserIds: [teacher1.id, teacher4.id],
    })

    // teacher4 kaydını kontrol et: isPrimary = false olmalı
    const initialT4 = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacher4.id)))
    expect(initialT4).toHaveLength(1)
    expect(initialT4[0]?.isPrimary).toBe(false)
    expect(initialT4[0]?.deletedAt).toBeNull()

    // teacher4 kaydını soft-delete durumuna getir
    const softDeleteTime = new Date(Date.now() - 30000)
    await db
      .update(schema.projectAdvisors)
      .set({ deletedAt: softDeleteTime, deletedBy: admin.id, updatedAt: softDeleteTime })
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacher4.id)))

    // Öğrenci C (danışmanı teacher4) takıma eklenir
    await projectService.addTeamMember(admin, created.projectId, 'enroll-22-c')

    // teacher4 kaydı yeniden etkinleşmeli, isPrimary = false korunmalı ve ikinci kayıt oluşmamalı
    const reactivatedT4 = await db
      .select()
      .from(schema.projectAdvisors)
      .where(and(eq(schema.projectAdvisors.projectId, created.projectId), eq(schema.projectAdvisors.userId, teacher4.id)))
    expect(reactivatedT4).toHaveLength(1)
    expect(reactivatedT4[0]?.deletedAt).toBeNull()
    expect(reactivatedT4[0]?.deletedBy).toBeNull()
    expect(reactivatedT4[0]?.isPrimary).toBe(false)
    expect(reactivatedT4[0]?.updatedAt.getTime()).toBeGreaterThan(softDeleteTime.getTime())
  })
})
