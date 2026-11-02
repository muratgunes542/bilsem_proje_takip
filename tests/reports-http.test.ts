import { createServer } from 'node:http'
import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchNodeApi } from '../server/api/router'
import * as schema from '../server/db/schema'

describe('Reporting routes over real HTTP and isolated SQLite', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `reports-http-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    await db.insert(schema.users).values([
      { id: 'REPORT-admin', name: 'TEST Rapor Yönetici', email: 'report-admin-http@example.test', role: 'ADMIN' },
      { id: 'REPORT-teacher', name: 'TEST Proje Öğretmeni', email: 'report-teacher-http@example.test', role: 'TEACHER' },
      { id: 'REPORT-advisor', name: 'TEST Danışman Öğretmen', email: 'report-advisor-http@example.test', role: 'TEACHER' },
    ])
    await db.insert(schema.academicYears).values({ id: 'REPORT-year', name: 'TEST Rapor Yılı', startsOn: new Date('2025-09-01'), endsOn: new Date('2026-06-30'), isCurrent: true })
    server = createServer((req, res) => { void dispatchNodeApi(req, res, undefined, db) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP rapor test sunucusu açılamadı.')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await client.close()
  })

  async function get(path: string, userId?: string) {
    const response = await fetch(`${baseUrl}${path}`, { headers: userId ? { 'x-test-user-id': userId } : {} })
    return { response, body: await response.json() as { success: boolean; data?: unknown; pagination?: { total: number }; error?: { code: string; message: string } } }
  }

  const endpoints = [
    '/api/reports/overview',
    '/api/reports/students?page=1&pageSize=20',
    '/api/reports/teachers?page=1&pageSize=20',
    '/api/reports/teachers/REPORT-advisor/projects?type=advised&page=1&pageSize=20',
    '/api/reports/projects?page=1&pageSize=20',
  ]

  it('returns valid empty reports rather than API errors when there are no project or student records', async () => {
    const overview = await get('/api/reports/overview?academicYearId=REPORT-year', 'REPORT-admin')
    expect(overview.response.status).toBe(200)
    expect(overview.body.data).toMatchObject({ activeStudentCount: 0, projectCount: 0, participatingStudentCount: 0, nonParticipatingStudentCount: 0, projectCreatorCount: 0 })
    for (const path of ['/api/reports/students', '/api/reports/projects']) {
      const result = await get(path, 'REPORT-teacher')
      expect(result.response.status, path).toBe(200)
      expect(result.body.data).toEqual([])
      expect(result.body.pagination?.total).toBe(0)
    }
  })

  it('serves all report URLs to both roles, rejects anonymous requests and rejects the missing teacher id route', async () => {
    for (const roleUserId of ['REPORT-admin', 'REPORT-teacher']) {
      for (const path of endpoints) {
        const result = await get(path, roleUserId)
        expect(result.response.status, `${roleUserId} ${path}`).toBe(200)
        expect(result.body.success, `${roleUserId} ${path}`).toBe(true)
      }
    }
    for (const path of endpoints) {
      const result = await get(path)
      expect(result.response.status, path).toBe(401)
      expect(result.body.error?.code).toBe('UNAUTHORIZED')
    }
    const malformed = await get('/api/reports/teachers//projects?type=advised', 'REPORT-teacher')
    expect(malformed.response.status).toBe(404)
    expect(malformed.body.error?.code).toBe('NOT_FOUND')
  })

  it('applies year and filter parameters and returns clear validation responses for invalid values', async () => {
    const validYear = await get('/api/reports/overview?academicYearId=REPORT-year', 'REPORT-teacher')
    expect(validYear.response.status).toBe(200)
    expect(validYear.body.data).toMatchObject({ academicYearId: 'REPORT-year' })
    const invalidPage = await get('/api/reports/students?page=not-a-number', 'REPORT-teacher')
    expect(invalidPage.response.status).toBe(400)
    expect(invalidPage.body.error?.code).toBe('VALIDATION_ERROR')
    const invalidType = await get('/api/reports/projects?participationType=DUO', 'REPORT-teacher')
    expect(invalidType.response.status).toBe(400)
    expect(invalidType.body.error?.code).toBe('VALIDATION_ERROR')
  })

  it('reads linked project, student, year, creator, category, status and advisor records through the HTTP routes', async () => {
    await db.insert(schema.students).values([
      { id: 'REPORT-student-a', bilsemNo: 'TEST-R001', firstName: 'TEST Elif', lastName: 'Ak' },
      { id: 'REPORT-student-b', bilsemNo: 'TEST-R002', firstName: 'TEST Efe', lastName: 'Kara' },
    ])
    await db.insert(schema.studentEnrollments).values([
      { id: 'REPORT-enrollment-a', studentId: 'REPORT-student-a', academicYearId: 'REPORT-year', talentArea: 'TEST Müzik', isActive: true },
      { id: 'REPORT-enrollment-b', studentId: 'REPORT-student-b', academicYearId: 'REPORT-year', talentArea: 'TEST Resim', isActive: true },
    ])
    await db.insert(schema.projects).values({ id: 'REPORT-team-project', title: 'TEST Takım Rapor Projesi', academicYearId: 'REPORT-year', categoryId: 'category-etwinning', statusId: 'status-active', createdBy: 'REPORT-teacher', participationType: 'TEAM', teamName: 'TEST Ekip' })
    await db.insert(schema.projectStudents).values([
      { projectId: 'REPORT-team-project', enrollmentId: 'REPORT-enrollment-a' },
      { projectId: 'REPORT-team-project', enrollmentId: 'REPORT-enrollment-b' },
    ])
    await db.insert(schema.projectAdvisors).values({ projectId: 'REPORT-team-project', userId: 'REPORT-advisor', isPrimary: true })

    const overview = await get('/api/reports/overview?academicYearId=REPORT-year', 'REPORT-admin')
    expect(overview.body.data).toMatchObject({ activeStudentCount: 2, projectCount: 1, participatingStudentCount: 2, nonParticipatingStudentCount: 0, projectCreatorCount: 1 })
    const studentRows = await get('/api/reports/students?academicYearId=REPORT-year&search=TEST-R001', 'REPORT-teacher')
    expect(studentRows.response.status).toBe(200)
    expect(studentRows.body.data).toMatchObject([{ studentId: 'REPORT-student-a', projectCount: 1, teamProjectCount: 1 }])
    const teacherRows = await get('/api/reports/teachers?academicYearId=REPORT-year', 'REPORT-teacher')
    expect(teacherRows.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'REPORT-teacher', createdProjectCount: 1, advisedProjectCount: 0 }),
      expect.objectContaining({ id: 'REPORT-advisor', createdProjectCount: 0, advisedProjectCount: 1, advisedStudentCount: 2 }),
    ]))
    const teacherProjects = await get('/api/reports/teachers/REPORT-advisor/projects?type=advised&academicYearId=REPORT-year', 'REPORT-advisor')
    expect(teacherProjects.body.data).toMatchObject([{ id: 'REPORT-team-project', title: 'TEST Takım Rapor Projesi' }])
    const projects = await get('/api/reports/projects?academicYearId=REPORT-year&participationType=TEAM', 'REPORT-admin')
    expect(projects.body.data).toMatchObject([{ id: 'REPORT-team-project', studentCount: 2, creatorName: 'TEST Proje Öğretmeni', advisors: ['TEST Danışman Öğretmen'] }])
  })

  it('tests V1.7.3 student report category and advisor filter scenarios', async () => {
    // 1. Setup students & enrollments
    await db.insert(schema.students).values([
      { id: 's-1', bilsemNo: 'S-101', firstName: 'Student', lastName: 'One' },
      { id: 's-2', bilsemNo: 'S-102', firstName: 'Student', lastName: 'Two' },
    ])
    await db.insert(schema.studentEnrollments).values([
      { id: 'e-1', studentId: 's-1', academicYearId: 'REPORT-year', isActive: true },
      { id: 'e-2', studentId: 's-2', academicYearId: 'REPORT-year', isActive: true },
    ])

    // 2. Project A: TÜBİTAK 2204-A, Advisor = REPORT-advisor, Creator = REPORT-teacher, Student 1
    await db.insert(schema.projects).values({
      id: 'p-tubitak-a', title: 'TÜBİTAK A Project', academicYearId: 'REPORT-year',
      categoryId: 'category-tubitak-2204-a', statusId: 'status-active', createdBy: 'REPORT-teacher', participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: 'p-tubitak-a', enrollmentId: 'e-1' })
    await db.insert(schema.projectAdvisors).values({ projectId: 'p-tubitak-a', userId: 'REPORT-advisor', isPrimary: true })

    // 3. Project B: TÜBİTAK 2204-A (second project for Student 1), Advisor = different advisor (REPORT-teacher), Creator = REPORT-advisor
    await db.insert(schema.projects).values({
      id: 'p-tubitak-a-2', title: 'Second TÜBİTAK A Project', academicYearId: 'REPORT-year',
      categoryId: 'category-tubitak-2204-a', statusId: 'status-active', createdBy: 'REPORT-advisor', participationType: 'INDIVIDUAL',
    })
    await db.insert(schema.projectStudents).values({ projectId: 'p-tubitak-a-2', enrollmentId: 'e-1' })
    await db.insert(schema.projectAdvisors).values({ projectId: 'p-tubitak-a-2', userId: 'REPORT-teacher', isPrimary: true })

    // Scenario 1: Only TÜBİTAK 2204-A category filter
    const resCat = await get('/api/reports/students?academicYearId=REPORT-year&categoryId=category-tubitak-2204-a', 'REPORT-teacher')
    expect(resCat.response.status).toBe(200)
    const studentsCat = resCat.body.data as Array<{ studentId: string; projectCount: number }>
    expect(studentsCat).toHaveLength(1) // Student 1 has projects in this category
    expect(studentsCat[0]?.studentId).toBe('s-1')
    expect(studentsCat[0]?.projectCount).toBe(2) // Same student has 2 projects in category

    // Scenario 2: Only advisor filter (REPORT-advisor advised p-tubitak-a, student 1)
    const resAdv = await get('/api/reports/students?academicYearId=REPORT-year&advisorUserId=REPORT-advisor', 'REPORT-teacher')
    const studentsAdv = resAdv.body.data as Array<{ studentId: string }>
    expect(studentsAdv).toHaveLength(1)
    expect(studentsAdv[0]?.studentId).toBe('s-1')

    // Scenario 3: TÜBİTAK 2204-A + advisor REPORT-advisor together (matches p-tubitak-a where REPORT-advisor is advisor)
    const resBoth = await get('/api/reports/students?academicYearId=REPORT-year&categoryId=category-tubitak-2204-a&advisorUserId=REPORT-advisor', 'REPORT-teacher')
    const studentsBoth = resBoth.body.data as Array<{ studentId: string }>
    expect(studentsBoth).toHaveLength(1)
    expect(studentsBoth[0]?.studentId).toBe('s-1')

    // Scenario 4: Creator vs Advisor separation (REPORT-teacher created p-tubitak-a, but advised p-tubitak-a-2. Filtering by REPORT-teacher as advisor should return student 1 via p-tubitak-a-2, ignoring created_by)
    const resTeacherAdv = await get('/api/reports/students?academicYearId=REPORT-year&advisorUserId=REPORT-teacher', 'REPORT-teacher')
    const studentsTeacherAdv = resTeacherAdv.body.data as Array<{ studentId: string }>
    expect(studentsTeacherAdv).toHaveLength(1)
    expect(studentsTeacherAdv[0]?.studentId).toBe('s-1')

    // Scenario 5: Student with no projects in selected category (Student 2 has no TÜBİTAK 2204-A projects)
    const resNoMatch = await get('/api/reports/students?academicYearId=REPORT-year&categoryId=category-etwinning', 'REPORT-teacher')
    const studentsNoMatch = resNoMatch.body.data as Array<{ studentId: string }>
    expect(studentsNoMatch).toHaveLength(0)

    // Scenario 6: Pagination and empty data
    const resEmpty = await get('/api/reports/students?academicYearId=REPORT-year&search=NONEXISTENT', 'REPORT-teacher')
    expect(resEmpty.response.status).toBe(200)
    expect(resEmpty.body.data).toEqual([])
    expect(resEmpty.body.pagination?.total).toBe(0)
  })
})
