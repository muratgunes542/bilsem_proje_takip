import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseFile = join(tmpdir(), `project-tracker-${randomUUID()}.db`)
let client: Client

beforeAll(async () => {
  client = createClient({ url: `file:${databaseFile}` })
  await migrate(drizzle(client), { migrationsFolder: 'drizzle/test' })
})

afterAll(async () => {
  await client.close()
})

describe('initial database migration', () => {
  it('creates all domain and Better Auth tables', async () => {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    const tableNames = result.rows.map((row) => String(row.name))

    expect(tableNames).toEqual(expect.arrayContaining([
      'users',
      'sessions',
      'accounts',
      'verifications',
      'students',
      'academic_years',
      'student_enrollments',
      'project_categories',
      'projects',
      'project_students',
      'project_advisors',
      'project_statuses',
      'project_status_history',
      'audit_logs',
      'project_attachments',
      'import_batches',
      'import_rows',
    ]))
  })

  it('seeds all required project categories', async () => {
    const result = await client.execute('SELECT code FROM project_categories ORDER BY code')
    expect(result.rows.map((row) => row.code)).toHaveLength(8)
  })

  it('enforces unique BİLSEM numbers', async () => {
    await client.execute({
      sql: 'INSERT INTO students (id, bilsem_no, first_name, last_name) VALUES (?, ?, ?, ?)',
      args: ['student-1', 'SYNTHETIC-001', 'Test', 'Student'],
    })

    await expect(client.execute({
      sql: 'INSERT INTO students (id, bilsem_no, first_name, last_name) VALUES (?, ?, ?, ?)',
      args: ['student-2', 'SYNTHETIC-001', 'Other', 'Student'],
    })).rejects.toThrow()
  })

  it('prevents audit log updates and deletes', async () => {
    await client.execute("INSERT INTO audit_logs (id, action, entity_type) VALUES ('audit-1', 'CREATE', 'TEST')")
    await expect(client.execute("UPDATE audit_logs SET action = 'UPDATE' WHERE id = 'audit-1'")).rejects.toThrow('append-only')
    await expect(client.execute("DELETE FROM audit_logs WHERE id = 'audit-1'")).rejects.toThrow('append-only')
  })
})
