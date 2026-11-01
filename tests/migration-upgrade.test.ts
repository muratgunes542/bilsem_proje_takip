import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('Migration chain and upgrade verification', () => {
  const databaseFile = join(tmpdir(), `migration-upgrade-${randomUUID()}.db`)
  let client: Client

  beforeAll(() => {
    client = createClient({ url: `file:${databaseFile}` })
  })

  afterAll(async () => {
    await client.close()
  })

  it('verifies drizzle migration directories in dev, test, prod are in sync', () => {
    const getFilesMap = (envName: string) => {
      const baseDir = join(process.cwd(), 'drizzle', envName)
      const files = readdirSync(baseDir, { recursive: true, withFileTypes: true })
      const fileMap = new Map<string, string>()
      for (const file of files) {
        if (file.isFile()) {
          const fileParent = 'parentPath' in file ? (file as { parentPath: string }).parentPath : baseDir
          const relativePath = join(fileParent || baseDir, file.name).replace(baseDir, '')
          const content = readFileSync(join(baseDir, relativePath), 'utf-8')
          fileMap.set(relativePath, content)
        }
      }
      return fileMap
    }

    const devMap = getFilesMap('development')
    const testMap = getFilesMap('test')
    const prodMap = getFilesMap('production')

    expect(testMap).toEqual(devMap)
    expect(prodMap).toEqual(devMap)
  })

  it('executes step-by-step upgrade starting from v1.0 schema (0000) with synthetic data', async () => {
    const sql0000 = readFileSync(join(process.cwd(), 'drizzle/development/0000_icy_drax.sql'), 'utf-8')
    const statements0000 = sql0000.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    for (const statement of statements0000) {
      await client.execute(statement)
    }

    await client.execute({
      sql: 'INSERT INTO students (id, student_code, first_name, last_name) VALUES (?, ?, ?, ?)',
      args: ['student-legacy-1', 'BS-2023-001', 'Ahmet', 'Yılmaz'],
    })
    await client.execute({
      sql: 'INSERT INTO students (id, student_code, first_name, last_name) VALUES (?, ?, ?, ?)',
      args: ['student-legacy-2', 'BS-2023-002', 'Ayşe', 'Kaya'],
    })

    const legacyCheck = await client.execute("SELECT student_code FROM students WHERE id = 'student-legacy-1'")
    expect(legacyCheck.rows[0]?.student_code).toBe('BS-2023-001')

    const sql0001 = readFileSync(join(process.cwd(), 'drizzle/development/0001_sudden_albert_cleary.sql'), 'utf-8')
    const statements0001 = sql0001.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    for (const statement of statements0001) {
      await client.execute(statement)
    }

    const sql0002 = readFileSync(join(process.cwd(), 'drizzle/development/0002_noisy_skreet.sql'), 'utf-8')
    const statements0002 = sql0002.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    for (const statement of statements0002) {
      await client.execute(statement)
    }

    const sql0003 = readFileSync(join(process.cwd(), 'drizzle/development/0003_v1_1_safeguards.sql'), 'utf-8')
    const statements0003 = sql0003.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    for (const statement of statements0003) {
      await client.execute(statement)
    }

    const migratedCheck = await client.execute("SELECT bilsem_no, first_name, last_name FROM students WHERE id = 'student-legacy-1'")
    expect(migratedCheck.rows[0]?.bilsem_no).toBe('BS-2023-001')
    expect(migratedCheck.rows[0]?.first_name).toBe('Ahmet')
    expect(migratedCheck.rows[0]?.last_name).toBe('Yılmaz')

    const migratedCheck2 = await client.execute("SELECT bilsem_no FROM students WHERE id = 'student-legacy-2'")
    expect(migratedCheck2.rows[0]?.bilsem_no).toBe('BS-2023-002')

    await expect(client.execute({
      sql: 'INSERT INTO students (id, bilsem_no, first_name, last_name) VALUES (?, ?, ?, ?)',
      args: ['student-duplicate', 'BS-2023-001', 'Fatma', 'Demir'],
    })).rejects.toThrow()

    const tubitakCategory = await client.execute("SELECT duplicate_check_enabled FROM project_categories WHERE code = 'TUBITAK_2204_A'")
    expect(tubitakCategory.rows[0]?.duplicate_check_enabled).toBe(1)
  })

  it('runs full migration using drizzle migrator without errors', async () => {
    const fullDbFile = join(tmpdir(), `migration-full-${randomUUID()}.db`)
    const fullClient = createClient({ url: `file:${fullDbFile}` })
    const fullDb = drizzle(fullClient)

    await expect(migrate(fullDb, { migrationsFolder: 'drizzle/test' })).resolves.not.toThrow()
    await fullClient.close()
  })
})
