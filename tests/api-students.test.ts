import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
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
      { id: 'enroll-1-old', studentId: 'student-1', academicYearId: 'year-2023', talentArea: 'Müzik', isActive: true },
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

  it('returns student profile including multi-year enrollments', async () => {
    const res = await handleApiRequest({
      method: 'GET',
      url: 'http://localhost/api/students/student-1',
      headers: { 'x-test-user-id': 'teacher-1' },
    }, db)

    expect(res.statusCode).toBe(200)
    const profile = res.payload.data as { student: { id: string }; enrollments: unknown[] }
    expect(profile.student.id).toBe('student-1')
    expect(profile.enrollments).toHaveLength(2) // 2024-2025 and 2023-2024
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
})
