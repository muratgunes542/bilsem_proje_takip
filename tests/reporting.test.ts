import { eq } from 'drizzle-orm'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from '../server/api/router'
import { ProjectService } from '../server/services/project-service'
import * as schema from '../server/db/schema'

describe('Reporting and analytics use isolated synthetic records', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let teamProjectId: string
  let archivedProjectId: string

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `reporting-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    await db.insert(schema.users).values([
      { id: 'TEST-admin', name: 'TEST Yönetici', email: 'report-admin@example.test', role: 'ADMIN' },
      { id: 'TEST-teacher-a', name: 'TEST Oluşturan', email: 'report-teacher-a@example.test', role: 'TEACHER' },
      { id: 'TEST-teacher-b', name: 'TEST Danışman B', email: 'report-teacher-b@example.test', role: 'TEACHER' },
      { id: 'TEST-teacher-c', name: 'TEST Danışman C', email: 'report-teacher-c@example.test', role: 'TEACHER' },
    ])
    await db.insert(schema.academicYears).values([
      { id: 'TEST-year-2025', name: 'TEST 2025-2026', startsOn: new Date('2025-09-01'), endsOn: new Date('2026-06-30'), isCurrent: true },
      { id: 'TEST-year-2024', name: 'TEST 2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: false },
    ])
    await db.insert(schema.students).values([
      { id: 'TEST-student-a', bilsemNo: 'TEST001', firstName: 'TEST Ada', lastName: 'Yılmaz' },
      { id: 'TEST-student-b', bilsemNo: 'TEST002', firstName: 'TEST Bora', lastName: 'Kaya' },
      { id: 'TEST-student-c', bilsemNo: 'TEST003', firstName: 'TEST Can', lastName: 'Demir' },
      { id: 'TEST-student-d', bilsemNo: 'TEST004', firstName: 'TEST Deniz', lastName: 'Arı' },
    ])
    await db.insert(schema.studentEnrollments).values([
      { id: 'TEST-enroll-a-25', studentId: 'TEST-student-a', academicYearId: 'TEST-year-2025', talentArea: 'TEST Müzik', advisorUserId: 'TEST-teacher-b', isActive: true },
      { id: 'TEST-enroll-b-25', studentId: 'TEST-student-b', academicYearId: 'TEST-year-2025', talentArea: 'TEST Resim', advisorUserId: 'TEST-teacher-c', isActive: true },
      { id: 'TEST-enroll-d-25', studentId: 'TEST-student-d', academicYearId: 'TEST-year-2025', talentArea: 'TEST Müzik', isActive: true },
      { id: 'TEST-enroll-a-24', studentId: 'TEST-student-a', academicYearId: 'TEST-year-2024', talentArea: 'TEST Müzik', advisorUserId: 'TEST-teacher-b', isActive: true },
      { id: 'TEST-enroll-c-24', studentId: 'TEST-student-c', academicYearId: 'TEST-year-2024', talentArea: 'TEST Genel', isActive: true },
    ])
    const projectService = new ProjectService(db)
    const team = await projectService.createProject({ id: 'TEST-teacher-a', role: 'TEACHER', isActive: true }, { title: 'TEST Takım Projesi', academicYearId: 'TEST-year-2025', categoryId: 'category-etwinning', statusId: 'status-active', participationType: 'TEAM', teamName: 'TEST Takımı', enrollmentIds: ['TEST-enroll-a-25', 'TEST-enroll-b-25'] })
    teamProjectId = team.projectId
    await db.insert(schema.projectAdvisors).values([
      { projectId: teamProjectId, userId: 'TEST-teacher-b', isPrimary: true },
      { projectId: teamProjectId, userId: 'TEST-teacher-c', isPrimary: false },
    ]).onConflictDoNothing()
    await projectService.createProject({ id: 'TEST-teacher-a', role: 'TEACHER', isActive: true }, { title: 'TEST Bireysel Proje', academicYearId: 'TEST-year-2025', categoryId: 'category-tubitak-2204-a', statusId: 'status-draft', participationType: 'INDIVIDUAL', enrollmentIds: ['TEST-enroll-a-25'] })
    const past = await projectService.createProject({ id: 'TEST-teacher-a', role: 'TEACHER', isActive: true }, { title: 'TEST Geçmiş Yıl Projesi', academicYearId: 'TEST-year-2024', categoryId: 'category-etwinning', statusId: 'status-completed', participationType: 'TEAM', teamName: 'TEST Eski Takım', enrollmentIds: ['TEST-enroll-a-24', 'TEST-enroll-c-24'] })
    await db.insert(schema.projectAdvisors).values({ projectId: past.projectId, userId: 'TEST-teacher-b', isPrimary: true }).onConflictDoNothing()
    const archived = await projectService.createProject({ id: 'TEST-teacher-a', role: 'TEACHER', isActive: true }, { title: 'TEST Arşiv Projesi', academicYearId: 'TEST-year-2025', categoryId: 'category-special-project', statusId: 'status-draft', participationType: 'INDIVIDUAL', enrollmentIds: ['TEST-enroll-b-25'] })
    archivedProjectId = archived.projectId
    await db.update(schema.projects).set({ deletedAt: new Date() }).where(eq(schema.projects.id, archivedProjectId))
  })

  afterEach(async () => { await client.close() })

  it('counts individual/team projects once and gives every team member their participation', async () => {
    const overview = await handleApiRequest({ method: 'GET', url: '/api/reports/overview?academicYearId=TEST-year-2025', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(overview.statusCode).toBe(200)
    expect(overview.payload.data).toMatchObject({ activeStudentCount: 3, projectCount: 2, participatingStudentCount: 2, nonParticipatingStudentCount: 1, projectCreatorCount: 1 })
    expect((overview.payload.data as { participationDistribution: Array<{ participationType: string; total: number }> }).participationDistribution).toEqual(expect.arrayContaining([{ participationType: 'TEAM', total: 1 }, { participationType: 'INDIVIDUAL', total: 1 }]))
    const students = await handleApiRequest({ method: 'GET', url: '/api/reports/students?academicYearId=TEST-year-2025&pageSize=20', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(students.payload.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'TEST-student-a', projectCount: 2, individualProjectCount: 1, teamProjectCount: 1 }),
      expect.objectContaining({ studentId: 'TEST-student-b', projectCount: 1, teamProjectCount: 1 }),
      expect.objectContaining({ studentId: 'TEST-student-d', projectCount: 0 }),
    ]))
    const emptyOnly = await handleApiRequest({ method: 'GET', url: '/api/reports/students?academicYearId=TEST-year-2025&withoutProjects=true', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(emptyOnly.payload.data).toMatchObject([{ studentId: 'TEST-student-d', projectCount: 0 }])
    expect(emptyOnly.payload.pagination?.total).toBe(1)
  })

  it('keeps creator and advisor contributions separate, counts multi-advisor student uniques, and exposes drill-through projects', async () => {
    const teachers = await handleApiRequest({ method: 'GET', url: '/api/reports/teachers?academicYearId=TEST-year-2025', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    const teacherRows = teachers.payload.data as Array<{ id: string; createdProjectCount: number; advisedProjectCount: number; advisedStudentCount: number }>
    expect(teacherRows.find((teacher) => teacher.id === 'TEST-teacher-a')).toMatchObject({ createdProjectCount: 2, advisedProjectCount: 0 })
    expect(teacherRows.find((teacher) => teacher.id === 'TEST-teacher-b')).toMatchObject({ createdProjectCount: 0, advisedProjectCount: 2, advisedStudentCount: 2 })
    expect(teacherRows.find((teacher) => teacher.id === 'TEST-teacher-c')).toMatchObject({ advisedProjectCount: 1, advisedStudentCount: 2 })
    const advisedProjects = await handleApiRequest({ method: 'GET', url: '/api/reports/teachers/TEST-teacher-b/projects?type=advised&academicYearId=TEST-year-2025', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(advisedProjects.payload.data).toHaveLength(2)
  })

  it('uses each academic year denominator and excludes archived projects unless an administrator opts in', async () => {
    const allYears = await handleApiRequest({ method: 'GET', url: '/api/reports/overview', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    const overview = allYears.payload.data as { activeStudentCount: number; projectCount: number; participatingStudentCount: number; nonParticipatingStudentCount: number; yearComparisons: Array<{ academicYearId: string; activeStudentCount: number; projectCount: number; participatingStudentCount: number; participationRate: number }> }
    expect(overview).toMatchObject({ activeStudentCount: 4, projectCount: 3, participatingStudentCount: 3, nonParticipatingStudentCount: 1 })
    expect(overview.yearComparisons.find((year) => year.academicYearId === 'TEST-year-2025')).toMatchObject({ activeStudentCount: 3, projectCount: 2, participatingStudentCount: 2, participationRate: 66.7 })
    expect(overview.yearComparisons.find((year) => year.academicYearId === 'TEST-year-2024')).toMatchObject({ activeStudentCount: 2, projectCount: 1, participatingStudentCount: 2, participationRate: 100 })
    const archiveIgnoredByTeacher = await handleApiRequest({ method: 'GET', url: '/api/reports/projects?includeArchived=true', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(archiveIgnoredByTeacher.payload.pagination?.total).toBe(3)
    const archiveVisibleAdmin = await handleApiRequest({ method: 'GET', url: '/api/reports/projects?includeArchived=true', headers: { 'x-test-user-id': 'TEST-admin' } }, db)
    expect(archiveVisibleAdmin.payload.pagination?.total).toBe(4)
    const archiveHiddenDefault = await handleApiRequest({ method: 'GET', url: '/api/reports/projects', headers: { 'x-test-user-id': 'TEST-admin' } }, db)
    expect(archiveHiddenDefault.payload.pagination?.total).toBe(3)
    const teamOnly = await handleApiRequest({ method: 'GET', url: '/api/reports/projects?participationType=TEAM&academicYearId=TEST-year-2025', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(teamOnly.payload.data).toMatchObject([{ id: teamProjectId, studentCount: 2 }])
    expect((teamOnly.payload.data as Array<{ advisors: string[] }>)[0]?.advisors).toEqual(expect.arrayContaining(['TEST Danışman B', 'TEST Danışman C']))
  })

  it('rejects anonymous access and leaves user administration unavailable to teachers', async () => {
    const anonymous = await handleApiRequest({ method: 'GET', url: '/api/reports/overview', headers: {} }, db)
    expect(anonymous.statusCode).toBe(401)
    const userAdmin = await handleApiRequest({ method: 'GET', url: '/api/admin/users', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(userAdmin.statusCode).toBe(403)
    const studentFilters = await handleApiRequest({ method: 'GET', url: '/api/reports/students?academicYearId=TEST-year-2025&search=TEST001&talentArea=TEST%20M%C3%BCzik', headers: { 'x-test-user-id': 'TEST-teacher-a' } }, db)
    expect(studentFilters.payload.data).toMatchObject([{ studentId: 'TEST-student-a' }])
  })
})
