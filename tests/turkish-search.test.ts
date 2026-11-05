import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { StudentService } from '../server/services/student-service'

describe('Turkish Character and Case-Insensitive Student Search', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let studentService: StudentService

  const admin: AuthenticatedUser = { id: 'admin-1', role: 'ADMIN', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `turkish-search-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: admin.id, name: 'Admin User', email: 'admin@test.com', role: 'ADMIN' },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 's-1', bilsemNo: '1001', firstName: 'ALİ', lastName: 'YILMAZ' },
      { id: 's-2', bilsemNo: '1002', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 's-3', bilsemNo: '1003', firstName: 'IŞIL', lastName: 'DEMİR' },
      { id: 's-4', bilsemNo: '1004', firstName: 'İPEK', lastName: 'KAYA' },
      { id: 's-5', bilsemNo: '1005', firstName: 'ŞULE', lastName: 'AKIN' },
      { id: 's-6', bilsemNo: '1006', firstName: 'Çağrı', lastName: 'Öztürk' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'e-1', studentId: 's-1', academicYearId: 'year-2024', isActive: true },
      { id: 'e-2', studentId: 's-2', academicYearId: 'year-2024', isActive: true },
      { id: 'e-3', studentId: 's-3', academicYearId: 'year-2024', isActive: true },
      { id: 'e-4', studentId: 's-4', academicYearId: 'year-2024', isActive: true },
      { id: 'e-5', studentId: 's-5', academicYearId: 'year-2024', isActive: true },
      { id: 'e-6', studentId: 's-6', academicYearId: 'year-2024', isActive: true },
    ])

    studentService = new StudentService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  const testCases = [
    { name: 'ALİ YILMAZ', query: 'ali', bilsemNo: '1001' },
    { name: 'Ali Yılmaz', query: 'ALİ', bilsemNo: '1002' },
    { name: 'IŞIL DEMİR', query: 'ışıl', bilsemNo: '1003' },
    { name: 'İPEK KAYA', query: 'ipek', bilsemNo: '1004' },
    { name: 'ŞULE AKIN', query: 'şule', bilsemNo: '1005' },
    { name: 'Çağrı Öztürk', query: 'ÇAĞRI', bilsemNo: '1006' },
  ]

  for (const tc of testCases) {
    it(`finds student matching query "${tc.query}" with bilsemNo "${tc.bilsemNo}"`, async () => {
      const result = await studentService.listStudents(admin, { search: tc.query, academicYearId: 'year-2024' })
      expect(result.students.length).toBeGreaterThan(0)
      const matched = result.students.find((s) => s.bilsemNo === tc.bilsemNo)
      expect(matched).toBeDefined()
      expect(matched?.bilsemNo).toBe(tc.bilsemNo)
    })
  }

  it('distinguishes I/ı and İ/i scenarios correctly', async () => {
    const res1 = await studentService.listStudents(admin, { search: 'IŞIL', academicYearId: 'year-2024' })
    expect(res1.students.some((s) => s.bilsemNo === '1003')).toBe(true)

    const res2 = await studentService.listStudents(admin, { search: 'İPEK', academicYearId: 'year-2024' })
    expect(res2.students.some((s) => s.bilsemNo === '1004')).toBe(true)
  })
})
