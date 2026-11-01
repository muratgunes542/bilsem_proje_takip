import { createServer } from 'node:http'
import ExcelJS from 'exceljs'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchNodeApi } from '../server/api/router'
import * as schema from '../server/db/schema'

describe('HTTP API adapter', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  beforeEach(async () => {
    client = createClient({ url: `file:${join(tmpdir(), `api-http-${randomUUID()}.db`)}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })
    await db.insert(schema.users).values({ id: 'http-teacher', name: 'HTTP Teacher', email: 'http-teacher@test.com', role: 'TEACHER' })
    await db.insert(schema.users).values({ id: 'http-admin', name: 'HTTP Admin', email: 'http-admin@test.com', role: 'ADMIN' })
    await db.insert(schema.academicYears).values({ id: 'http-year', name: '2026-2027', startsOn: new Date('2026-09-01'), endsOn: new Date('2027-06-30'), isCurrent: true })

    server = createServer((req, res) => { void dispatchNodeApi(req, res, undefined, db) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server failed to bind')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await client.close()
  })

  it('returns 401 over HTTP without a Better Auth session', async () => {
    const response = await fetch(`${baseUrl}/api/me`)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
  })

  it('uses server-side account role and status for an authenticated test session', async () => {
    const response = await fetch(`${baseUrl}/api/me`, { headers: { 'x-test-user-id': 'http-teacher' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, data: { id: 'http-teacher', role: 'TEACHER', isActive: true } })
  })

  it('does not grant administrator access from client-supplied role or user identity headers', async () => {
    const response = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { 'x-test-user-id': 'http-teacher', 'x-user-role': 'ADMIN', 'x-user-id': 'admin-id' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
  })

  it('previews a valid XLSX without changing students, then resolves and commits only after approval', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Students')
    sheet.addRow(['Danışman Öğretmen', 'Soyadı', 'BİLSEM No', 'Yetenek Alanı', 'Adı'])
    sheet.addRow(['HTTP Teacher', 'Yeni', '00125', 'Müzik', 'Öğrenci'])
    sheet.addRow(['Missing Teacher', 'Bekleyen', '00126', 'Resim', 'Başka'])
    const file = Buffer.from(await workbook.xlsx.writeBuffer())

    const response = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-file-name': 'roster.xlsx',
        'x-test-user-id': 'http-admin',
      },
      body: file,
    })
    expect(response.status).toBe(200)
    const preview = await response.json() as { data: { batchId: string; validRows: number; invalidRows: number; results: Array<{ bilsemNo: string | null; resultTypes: string[] }> } }
    expect(preview.data.validRows).toBe(1)
    expect(preview.data.invalidRows).toBe(1)
    expect(preview.data.results[0]?.bilsemNo).toBe('00125')
    expect((await db.select().from(schema.students))).toHaveLength(0)

    const batchResponse = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}`, { headers: { 'x-test-user-id': 'http-admin' } })
    expect(batchResponse.status).toBe(200)
    const rowsResponse = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}/rows?page=1&pageSize=10`, { headers: { 'x-test-user-id': 'http-admin' } })
    const rowsPayload = await rowsResponse.json() as { data: Array<{ id: string; result: { resultTypes: string[] } }> }
    const unresolved = rowsPayload.data.find((item) => item.result.resultTypes.includes('UNMATCHED_TEACHER'))
    expect(unresolved).toBeDefined()

    const resolveResponse = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}/rows/${unresolved!.id}/advisor`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user-id': 'http-admin' },
      body: JSON.stringify({ advisorUserId: 'http-teacher' }),
    })
    expect(resolveResponse.status).toBe(200)
    const commitResponse = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}/commit`, { method: 'POST', headers: { 'x-test-user-id': 'http-admin' } })
    expect(commitResponse.status).toBe(200)
    const committed = await db.select().from(schema.students)
    expect(committed.map((student) => student.bilsemNo).sort()).toEqual(['00125', '00126'])
    const enrollments = await db.select().from(schema.studentEnrollments)
    expect(enrollments.every((enrollment) => enrollment.advisorUserId === 'http-teacher')).toBe(true)
    const secondCommit = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}/commit`, { method: 'POST', headers: { 'x-test-user-id': 'http-admin' } })
    expect(secondCommit.status).toBe(422)
  })

  it('rejects malformed workbooks and teacher uploads', async () => {
    const teacherResponse = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST', headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-file-name': 'roster.xlsx', 'x-test-user-id': 'http-teacher',
      }, body: Buffer.from('PK\u0003\u0004garbage'),
    })
    expect(teacherResponse.status).toBe(403)

    const malformedResponse = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST', headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-file-name': 'roster.xlsx', 'x-test-user-id': 'http-admin',
      }, body: Buffer.from('PK\u0003\u0004garbage'),
    })
    expect(malformedResponse.status).toBe(400)

    const wrongExtension = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST', headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-file-name': 'roster.xls', 'x-test-user-id': 'http-admin',
      }, body: Buffer.from('PK\u0003\u0004'),
    })
    expect(wrongExtension.status).toBe(400)
  })

  it('classifies duplicate, numeric, formula, continuing and missing-list rows and preserves previous-year project links', async () => {
    await db.insert(schema.users).values({ id: 'http-teacher-old', name: 'Old Teacher', email: 'old-teacher@test.com', role: 'TEACHER' })
    await db.insert(schema.academicYears).values({ id: 'http-year-old', name: '2025-2026', startsOn: new Date('2025-09-01'), endsOn: new Date('2026-06-30'), isCurrent: false })
    await db.insert(schema.students).values([
      { id: 'existing-student', bilsemNo: '00007', firstName: 'Önceki', lastName: 'Ad' },
      { id: 'omitted-student', bilsemNo: '00006', firstName: 'Listede', lastName: 'Eksik' },
    ])
    await db.insert(schema.studentEnrollments).values([
      { id: 'existing-enrollment', studentId: 'existing-student', academicYearId: 'http-year', advisorName: 'Old Teacher', advisorUserId: 'http-teacher-old', talentArea: 'Resim', isActive: true },
      { id: 'past-enrollment', studentId: 'existing-student', academicYearId: 'http-year-old', advisorName: 'Old Teacher', advisorUserId: 'http-teacher-old', talentArea: 'Resim', isActive: true },
      { id: 'omitted-enrollment', studentId: 'omitted-student', academicYearId: 'http-year', isActive: true },
    ])
    await db.insert(schema.projects).values({ id: 'past-project', title: 'Geçmiş proje', academicYearId: 'http-year-old', categoryId: 'category-etwinning', statusId: 'status-draft', createdBy: 'http-teacher' })
    await db.insert(schema.projectStudents).values({ projectId: 'past-project', enrollmentId: 'past-enrollment' })

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Students')
    sheet.addRow(['BİLSEM No', 'Ad', 'Soyad', 'Yetenek Alanı', 'Danışman Öğretmen', 'Gereksiz'])
    sheet.addRow(['00007', 'Güncel', 'Ad', 'Müzik', 'HTTP Teacher', 'extra'])
    sheet.addRow(['00008', 'Mükerrer', 'Bir', 'Resim', 'HTTP Teacher', ''])
    sheet.addRow(['00008', 'Mükerrer', 'İki', 'Resim', 'HTTP Teacher', ''])
    sheet.addRow([9, 'Sayısal', 'No', 'Müzik', 'HTTP Teacher', ''])
    sheet.addRow(['00009', { formula: '="Formül"', result: 'Formül' }, 'Hücre', 'Müzik', 'HTTP Teacher', ''])
    sheet.addRow(['00005', 'Yeni', 'Öğrenci', 'Müzik', 'HTTP Teacher', ''])
    sheet.addRow(['', '', '', '', '', 'sadece beklenmeyen sütun'])
    const file = Buffer.from(await workbook.xlsx.writeBuffer())
    const response = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-file-name': 'comparison.xlsx', 'x-test-user-id': 'http-admin' },
      body: file,
    })
    expect(response.status).toBe(200)
    const preview = await response.json() as { data: { batchId: string; totalRows: number; newStudentCount: number; continuingStudentCount: number; changedCount: number; invalidRows: number; warnings: Array<{ type: string }> } }
    expect(preview.data.totalRows).toBe(6)
    expect(preview.data.newStudentCount).toBe(1)
    expect(preview.data.continuingStudentCount).toBe(1)
    expect(preview.data.changedCount).toBe(1)
    expect(preview.data.invalidRows).toBe(4)
    expect(preview.data.warnings.map((warning) => warning.type)).toContain('UNEXPECTED_COLUMN')
    expect(preview.data.warnings.map((warning) => warning.type)).toContain('UNEXPECTED_ROW')
    expect((await db.select().from(schema.students))).toHaveLength(2)

    await client.execute({ sql: "CREATE TRIGGER fail_import_enrollment BEFORE INSERT ON student_enrollments BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END;" })
    const failedCommit = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}/commit`, { method: 'POST', headers: { 'x-test-user-id': 'http-admin' } })
    expect(failedCommit.status).toBe(500)
    expect((await db.select().from(schema.students))).toHaveLength(2)
    await client.execute({ sql: 'DROP TRIGGER fail_import_enrollment;' })

    const commit = await fetch(`${baseUrl}/api/imports/${preview.data.batchId}/commit`, { method: 'POST', headers: { 'x-test-user-id': 'http-admin' } })
    expect(commit.status).toBe(200)
    const current = (await db.select().from(schema.studentEnrollments)).find((enrollment) => enrollment.id === 'existing-enrollment')
    const past = (await db.select().from(schema.studentEnrollments)).find((enrollment) => enrollment.id === 'past-enrollment')
    expect(current).toMatchObject({ advisorUserId: 'http-teacher', talentArea: 'Müzik' })
    expect(past).toMatchObject({ advisorUserId: 'http-teacher-old', talentArea: 'Resim' })
    expect((await db.select().from(schema.projectStudents)).map((member) => member.projectId)).toContain('past-project')
    expect((await db.select().from(schema.students)).map((student) => student.bilsemNo)).not.toContain('00008')
    expect((await db.select().from(schema.students)).map((student) => student.bilsemNo)).toContain('00005')
  })

  it('rejects unexpected MIME types and requests beyond the configured upload limit', async () => {
    const wrongType = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-file-name': 'roster.xlsx', 'x-test-user-id': 'http-admin' },
      body: JSON.stringify({ records: [] }),
    })
    expect(wrongType.status).toBe(400)

    const tooLarge = await fetch(`${baseUrl}/api/imports/preview?academicYearId=http-year`, {
      method: 'POST', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-file-name': 'roster.xlsx', 'x-test-user-id': 'http-admin' },
      body: Buffer.alloc(131073),
    })
    expect(tooLarge.status).toBe(413)
  })
})
