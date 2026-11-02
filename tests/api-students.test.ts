import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from '../server/api/router'
import * as schema from '../server/db/schema'

describe('API Student Management', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `api-students-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: 'admin-1', name: 'Admin One', email: 'admin@test.com', role: 'ADMIN', isActive: true },
      { id: 'teacher-1', name: 'Teacher One', email: 't1@test.com', role: 'TEACHER', isActive: true },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
      { id: 'year-2023', name: '2023-2024', startsOn: new Date('2023-09-01'), endsOn: new Date('2024-06-30'), isCurrent: false },
    ])

    await db.insert(schema.students).values([
      { id: 'student-1', bilsemNo: 'B-101', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 'student-2', bilsemNo: 'B-102', firstName: 'Ayşe', lastName: 'Demir' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 'student-1', academicYearId: 'year-2024', talentArea: 'Müzik', advisorName: 'Ahmet Hoca', isActive: true },
      { id: 'enroll-2', studentId: 'student-2', academicYearId: 'year-2024', talentArea: 'Genel Zihinsel', advisorName: 'Fatma Hoca', isActive: true },
      { id: 'enroll-1-old', studentId: 'student-1', academicYearId: 'year-2023', talentArea: 'Müzik', advisorName: 'Ahmet Hoca', isActive: true },
    ])
  })

  afterEach(async () => {
    await client.close()
  })

  it('lists active students for active academic year with pagination and filters', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students?page=1&pageSize=10&talentArea=Müzik',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.success).toBe(true)
    const list = res.payload.data as Array<{ bilsemNo: string; firstName: string }>
    expect(list).toHaveLength(1)
    expect(list[0]!.bilsemNo).toBe('B-101')
    expect(list[0]!.firstName).toBe('Ali')
  })

  it('searches students by name or BİLSEM number', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students?search=B-102',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    const list = res.payload.data as Array<{ studentId: string }>
    expect(list).toHaveLength(1)
    expect(list[0]!.studentId).toBe('student-2')
  })

  it('searches the combined first and last name', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students?search=Ali%20Y%C4%B1lmaz',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.data).toMatchObject([{ studentId: 'student-1', firstName: 'Ali', lastName: 'Yılmaz' }])
  })

  it('filters server-side by academic year, talent area and advisor name', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students?academicYearId=year-2023&talentArea=M%C3%BCzik&advisorName=Ahmet',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.data).toMatchObject([{ enrollmentId: 'enroll-1-old', studentId: 'student-1' }])
  })

  it('can include all years explicitly while the default remains the current year', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students?allAcademicYears=true&pageSize=10',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.data).toHaveLength(3)
  })

  it('returns student profile including multi-year enrollments', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students/student-1',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    const profile = res.payload.data as { student: { id: string }; enrollments: Array<{ academicYearName: string; isCurrentAcademicYear: boolean }> }
    expect(profile.student.id).toBe('student-1')
    expect(profile.enrollments).toHaveLength(2) // 2024-2025 and 2023-2024
    expect(profile.enrollments[0]).toMatchObject({ academicYearName: '2024-2025', isCurrentAcademicYear: true })
    expect(profile.enrollments[1]?.isCurrentAcademicYear).toBe(false)
  })

  it('returns student project history', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students/student-1/history',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    expect(res.payload.data).toEqual([])
  })

  it('shows a single shared team project in each participating student history', async () => {
    await db.insert(schema.projects).values({
      id: 'team-project-test', title: 'TEST ortak proje', academicYearId: 'year-2024',
      categoryId: 'category-etwinning', statusId: 'status-draft', createdBy: 'teacher-1',
      participationType: 'TEAM', teamName: 'TEST Takımı',
    })
    await db.insert(schema.projectStudents).values([
      { projectId: 'team-project-test', enrollmentId: 'enroll-1' },
      { projectId: 'team-project-test', enrollmentId: 'enroll-2' },
    ])
    await db.insert(schema.projectAdvisors).values({ projectId: 'team-project-test', userId: 'teacher-1', isPrimary: true })

    const firstStudent = await handleApiRequest({ method: 'GET', url: 'http://localhost/api/students/student-1/history', headers: { 'x-test-user-id': 'teacher-1' } }, db)
    const secondStudent = await handleApiRequest({ method: 'GET', url: 'http://localhost/api/students/student-2/history', headers: { 'x-test-user-id': 'teacher-1' } }, db)
    const firstHistory = firstStudent.payload.data as Array<{ projectId: string; participationType: string; teamName: string | null; advisors: Array<{ name: string }> }>
    const secondHistory = secondStudent.payload.data as typeof firstHistory
    const storedProjects = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, 'team-project-test'))

    expect(firstHistory).toHaveLength(1)
    expect(secondHistory).toHaveLength(1)
    expect(firstHistory[0]).toMatchObject({ projectId: 'team-project-test', participationType: 'TEAM', teamName: 'TEST Takımı', advisors: [{ name: 'Teacher One' }] })
    expect(secondHistory[0]?.projectId).toBe('team-project-test')
    expect(storedProjects).toHaveLength(1)
  })

  it('allows admins to create a student and academic year record with an audit entry', async () => {
    const response = await handleApiRequest({ method: 'POST', url: '/api/admin/students', headers: { 'x-test-user-id': 'admin-1' }, body: { bilsemNo: '00027', firstName: 'TEST Ada', lastName: 'TEST Yılmaz', academicYearId: 'year-2024', talentArea: 'TEST Müzik', advisorUserId: 'teacher-1' } }, db)
    expect(response.statusCode).toBe(201)
    const studentId = (response.payload.data as { studentId: string }).studentId
    expect(await db.select().from(schema.students).where(eq(schema.students.id, studentId))).toMatchObject([{ bilsemNo: '00027', firstName: 'TEST Ada' }])
    expect(await db.select().from(schema.studentEnrollments).where(eq(schema.studentEnrollments.studentId, studentId))).toMatchObject([{ academicYearId: 'year-2024', talentArea: 'TEST Müzik', advisorUserId: 'teacher-1' }])
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, studentId))).toMatchObject([{ action: 'STUDENT_CREATED' }])
  })

  it('rejects teacher student administration and duplicate BİLSEM numbers', async () => {
    const body = { bilsemNo: '00027', firstName: 'TEST', lastName: 'Öğrenci', academicYearId: 'year-2024', talentArea: 'TEST Alan' }
    await db.insert(schema.students).values({ id: 'TEST-number-conflict', bilsemNo: '00028', firstName: 'TEST Var', lastName: 'TEST Öğrenci' })
    const forbidden = await handleApiRequest({ method: 'POST', url: '/api/admin/students', headers: { 'x-test-user-id': 'teacher-1' }, body }, db)
    expect(forbidden.statusCode).toBe(403)
    const duplicate = await handleApiRequest({ method: 'POST', url: '/api/admin/students', headers: { 'x-test-user-id': 'admin-1' }, body: { ...body, bilsemNo: '00028' } }, db)
    expect(duplicate.statusCode).toBe(422)
  })

  it('updates student identity and adds another year without changing prior enrollment or project links', async () => {
    await db.insert(schema.academicYears).values({ id: 'year-2022', name: '2022-2023', startsOn: new Date('2022-09-01'), endsOn: new Date('2023-06-30'), isCurrent: false })
    await db.insert(schema.projects).values({ id: 'TEST-preserved-project', title: 'TEST eski proje', academicYearId: 'year-2023', categoryId: 'category-etwinning', statusId: 'status-draft', createdBy: 'teacher-1', participationType: 'INDIVIDUAL' })
    await db.insert(schema.projectStudents).values({ projectId: 'TEST-preserved-project', enrollmentId: 'enroll-1-old' })
    const update = await handleApiRequest({ method: 'PATCH', url: '/api/admin/students/student-1', headers: { 'x-test-user-id': 'admin-1' }, body: { bilsemNo: '00031', firstName: 'TEST Ali', lastName: 'TEST Yılmaz' } }, db)
    expect(update.statusCode).toBe(200)
    const added = await handleApiRequest({ method: 'POST', url: '/api/admin/students/student-1/enrollments', headers: { 'x-test-user-id': 'admin-1' }, body: { academicYearId: 'year-2022', talentArea: 'TEST Alan', advisorUserId: 'teacher-1' } }, db)
    expect(added.statusCode).toBe(201)
    const oldYearUpdate = await handleApiRequest({ method: 'PATCH', url: '/api/admin/students/student-1/enrollments/enroll-1-old', headers: { 'x-test-user-id': 'admin-1' }, body: { talentArea: 'TEST Geçmiş alan', advisorUserId: 'teacher-1' } }, db)
    expect(oldYearUpdate.statusCode).toBe(200)
    expect(await db.select().from(schema.studentEnrollments).where(eq(schema.studentEnrollments.id, 'enroll-1-old'))).toMatchObject([{ academicYearId: 'year-2023', talentArea: 'TEST Geçmiş alan' }])
    expect(await db.select().from(schema.projectStudents).where(eq(schema.projectStudents.projectId, 'TEST-preserved-project'))).toHaveLength(1)
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityType, 'STUDENT'))).toHaveLength(1)
  })
})
