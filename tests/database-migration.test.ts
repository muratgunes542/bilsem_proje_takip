import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
    const result = await client.execute('SELECT code, name FROM project_categories ORDER BY code')
    expect(result.rows.length).toBeGreaterThanOrEqual(8)

    const expectedNewCategories = [
      { code: 'TEKNOFEST', name: 'TEKNOFEST' },
      { code: 'TUBITAK_4005', name: 'TÜBİTAK 4005' },
      { code: 'TUBITAK_4008', name: 'TÜBİTAK 4008' },
      { code: 'TUBITAK_BILIM_SOYLESISI', name: 'TÜBİTAK Bilim Söyleşisi' },
      { code: 'OTHER_COMPETITIONS', name: 'Diğer Yarışmalar' },
    ]

    for (const expected of expectedNewCategories) {
      const matchingRows = result.rows.filter(
        (row) => String(row.code) === expected.code && String(row.name) === expected.name,
      )
      expect(matchingRows).toHaveLength(1)

      const exactCodeRows = await client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM project_categories WHERE code = ?',
        args: [expected.code],
      })
      expect(Number(exactCodeRows.rows[0]?.cnt)).toBe(1)
    }
  })

  it('verifies 0008 migration idempotency when executed multiple times', async () => {
    const migrationSql = await readFile(join(process.cwd(), 'drizzle/test/0008_dynamic_categories.sql'), 'utf-8')

    await client.executeMultiple(migrationSql)
    await client.executeMultiple(migrationSql)

    const expectedCodes = [
      'TEKNOFEST',
      'TUBITAK_4005',
      'TUBITAK_4008',
      'TUBITAK_BILIM_SOYLESISI',
      'OTHER_COMPETITIONS',
    ]

    for (const code of expectedCodes) {
      const result = await client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM project_categories WHERE code = ?',
        args: [code],
      })
      expect(Number(result.rows[0]?.cnt)).toBe(1)
    }
  })

  it('keeps 0008 migration files and journals in sync across environments', async () => {
    const [developmentSql, productionSql, testSql] = await Promise.all([
      readFile(join(process.cwd(), 'drizzle/development/0008_dynamic_categories.sql'), 'utf-8'),
      readFile(join(process.cwd(), 'drizzle/production/0008_dynamic_categories.sql'), 'utf-8'),
      readFile(join(process.cwd(), 'drizzle/test/0008_dynamic_categories.sql'), 'utf-8'),
    ])
    const [developmentJournal, productionJournal, testJournal] = await Promise.all([
      readFile(join(process.cwd(), 'drizzle/development/meta/_journal.json'), 'utf-8'),
      readFile(join(process.cwd(), 'drizzle/production/meta/_journal.json'), 'utf-8'),
      readFile(join(process.cwd(), 'drizzle/test/meta/_journal.json'), 'utf-8'),
    ])

    expect(productionSql).toBe(developmentSql)
    expect(testSql).toBe(developmentSql)
    expect(JSON.parse(productionJournal)).toEqual(JSON.parse(developmentJournal))
    expect(JSON.parse(testJournal)).toEqual(JSON.parse(developmentJournal))
  })

  it('does not seed a duplicate category when its code or name already belongs to another record', async () => {
    await client.execute("DELETE FROM project_categories WHERE code IN ('TEKNOFEST', 'TUBITAK_4005', 'TUBITAK_4008', 'TUBITAK_BILIM_SOYLESISI', 'OTHER_COMPETITIONS')")
    await client.execute({
      sql: 'INSERT INTO project_categories (id, code, name) VALUES (?, ?, ?)',
      args: ['legacy-bilim-soylesisi', 'LEGACY_BILIM', 'TÜBİTAK Bilim Söyleşisi'],
    })
    await client.execute({
      sql: 'INSERT INTO project_categories (id, code, name) VALUES (?, ?, ?)',
      args: ['legacy-4005', 'TUBITAK_4005', 'Legacy TÜBİTAK category'],
    })
    await client.execute({
      sql: 'INSERT INTO project_categories (id, code, name) VALUES (?, ?, ?)',
      args: ['legacy-teknofest-code', 'teknofest', 'Legacy TEKNOFEST code'],
    })
    await client.execute({
      sql: 'INSERT INTO project_categories (id, code, name) VALUES (?, ?, ?)',
      args: ['legacy-teknofest-name', 'LEGACY_TEKNOFEST', ' TEKNOFEST '],
    })

    const migrationSql = await readFile(join(process.cwd(), 'drizzle/test/0008_dynamic_categories.sql'), 'utf-8')
    await client.executeMultiple(migrationSql)

    const bilimName = await client.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM project_categories WHERE name = ?',
      args: ['TÜBİTAK Bilim Söyleşisi'],
    })
    const bilimCode = await client.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM project_categories WHERE code = ?',
      args: ['TUBITAK_BILIM_SOYLESISI'],
    })
    const codeCollision = await client.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM project_categories WHERE code = ?',
      args: ['TUBITAK_4005'],
    })
    const canonicalName = await client.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM project_categories WHERE name = ?',
      args: ['TÜBİTAK 4005'],
    })
    const normalizedTeknofestCode = await client.execute({
      sql: "SELECT COUNT(*) AS cnt FROM project_categories WHERE lower(trim(code)) = lower('TEKNOFEST')",
    })
    const normalizedTeknofestName = await client.execute({
      sql: "SELECT COUNT(*) AS cnt FROM project_categories WHERE lower(trim(name)) = lower('TEKNOFEST')",
    })

    expect(Number(bilimName.rows[0]?.cnt)).toBe(1)
    expect(Number(bilimCode.rows[0]?.cnt)).toBe(0)
    expect(Number(codeCollision.rows[0]?.cnt)).toBe(1)
    expect(Number(canonicalName.rows[0]?.cnt)).toBe(0)
    expect(Number(normalizedTeknofestCode.rows[0]?.cnt)).toBe(1)
    expect(Number(normalizedTeknofestName.rows[0]?.cnt)).toBe(1)
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
