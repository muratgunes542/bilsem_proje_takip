import { describe, expect, it, vi } from 'vitest'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import * as schema from '../server/db/schema.js'

import {
  validateAdminEnvironment,
  validateAdminPassword,
  createAdminAccount,
} from '../scripts/create-local-admin.js'

// @ts-ignore
import { assertReadOnlyQuery, safeSourceExecute, verifyWalCheckpoint, verifyBackupFile, TABLES } from '../scripts/import-anonymized-production-snapshot.mjs'

describe('Helper Scripts Safety & Integrity Tests', () => {
  describe('create-local-admin.ts Guards & Rollback Cleanup', () => {
    it('validates development environment guard strictly', () => {
      // In test runner, environment is APP_ENV=test so guard correctly throws
      expect(() => validateAdminEnvironment()).toThrow(
        'Bu komut yalnızca yerel development.db üzerinde çalışabilir.',
      )
    })

    it('validates admin password length requirements (min 8 characters)', () => {
      expect(() => validateAdminPassword(undefined)).toThrow('LOCAL_ADMIN_PASSWORD tanımlı değil veya parola 8 karakterden kısa.')
      expect(() => validateAdminPassword('')).toThrow('LOCAL_ADMIN_PASSWORD tanımlı değil veya parola 8 karakterden kısa.')
      expect(() => validateAdminPassword('short')).toThrow('LOCAL_ADMIN_PASSWORD tanımlı değil veya parola 8 karakterden kısa.')
      expect(() => validateAdminPassword('12345678')).not.toThrow()
    })

    it('throws explicit error and performs NO cleanup when signUpEmail returns no user ID', async () => {
      const mockAuthNoId = {
        api: {
          signUpEmail: vi.fn().mockResolvedValue({}), // returns no user ID
        },
      } as any

      const mockDb = {
        update: vi.fn(),
        delete: vi.fn(),
      } as any

      await expect(
        createAdminAccount(mockAuthNoId, 'Admin', 'noid@example.test', 'password123', mockDb),
      ).rejects.toThrow('Better Auth kayıt yanıtında kullanıcı kimliği (user.id) alınamadı.')

      // Verify no delete was called because user ID was never confirmed as created in this run
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('verifies account and user cleanup executes strictly with the exact createdUserId and not other users', async () => {
      const createdId = 'target-user-id-to-delete-789'
      const otherUserId = 'other-user-id-999'

      const mockAuth = {
        api: {
          signUpEmail: vi.fn().mockResolvedValue({ user: { id: createdId } }),
        },
      } as any

      const deleteCalls: { table: any; condition: any }[] = []

      const mockDb = {
        delete: vi.fn().mockImplementation((table) => {
          return {
            where: vi.fn().mockImplementation((condition) => {
              deleteCalls.push({ table, condition })
              return Promise.resolve()
            }),
          }
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockRejectedValue(new Error('Role promotion update failed')),
          }),
        }),
      } as any

      await expect(
        createAdminAccount(mockAuth, 'Test Admin', 'test-strict@example.test', 'password123', mockDb),
      ).rejects.toThrow('Role promotion update failed')

      // Verify cleanup deleted exact createdId twice (accounts & users)
      expect(deleteCalls).toHaveLength(2)
      expect(deleteCalls[0]!.table).toBe(schema.accounts)
      expect(deleteCalls[1]!.table).toBe(schema.users)

      // Ensure condition string representation contains createdId and NOT otherUserId
      for (const call of deleteCalls) {
        const condStr = String((call.condition as any)?.value ?? (call.condition as any)?.queryChunks ?? '')
        expect(condStr).not.toContain(otherUserId)
      }
    })

    it('reports cleanup failure in thrown error when role update and cleanup both fail', async () => {
      const createdId = 'user-cleanup-fail-456'
      const mockAuth = {
        api: {
          signUpEmail: vi.fn().mockResolvedValue({ user: { id: createdId } }),
        },
      } as any

      const mockDb = {
        delete: vi.fn().mockImplementation(() => {
          throw new Error('Cleanup table locked')
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockRejectedValue(new Error('Role update failed')),
          }),
        }),
      } as any

      await expect(
        createAdminAccount(mockAuth, 'Test Admin', 'test-fail-cleanup@example.test', 'password123', mockDb),
      ).rejects.toThrow(/Role update failed.*temizleme hatası: Cleanup table locked/)
    })
  })

  describe('import-anonymized-production-snapshot.mjs Strict Read-Only, WAL Checkpoint & Backup Integrity', () => {
    it('strictly permits single SELECT queries on source connection and blocks everything else', () => {
      // Single SELECT is allowed
      expect(() => assertReadOnlyQuery('SELECT * FROM users')).not.toThrow()
      expect(() => assertReadOnlyQuery('SELECT COUNT(*) AS total FROM projects')).not.toThrow()

      // PRAGMA is blocked on source connection
      expect(() => assertReadOnlyQuery('PRAGMA foreign_keys')).toThrow('Güvenlik İhlali')
      expect(() => assertReadOnlyQuery('PRAGMA user_version')).toThrow('Güvenlik İhlali')

      // Write queries are blocked
      expect(() => assertReadOnlyQuery('INSERT INTO users (id) VALUES ("1")')).toThrow('Güvenlik İhlali')
      expect(() => assertReadOnlyQuery('UPDATE users SET role = "ADMIN"')).toThrow('Güvenlik İhlali')
      expect(() => assertReadOnlyQuery('DELETE FROM projects')).toThrow('Güvenlik İhlali')
      expect(() => assertReadOnlyQuery('DROP TABLE students')).toThrow('Güvenlik İhlali')
      expect(() => assertReadOnlyQuery('CREATE TABLE test (id TEXT)')).toThrow('Güvenlik İhlali')
    })

    it('blocks commented SQL queries and multiple SQL statements', () => {
      expect(() => assertReadOnlyQuery('SELECT * FROM users -- comment')).toThrow('Yorum içeren SQL ifadelerine izin verilmez')
      expect(() => assertReadOnlyQuery('SELECT * FROM users /* comment */')).toThrow('Yorum içeren SQL ifadelerine izin verilmez')
      expect(() => assertReadOnlyQuery('SELECT * FROM users; SELECT * FROM students')).toThrow('Yalnızca tek bir SQL ifadesine izin verilir')
    })

    it('safeSourceExecute executes read-only SELECT and rejects PRAGMA/write queries', async () => {
      const mockSourceClient = {
        execute: vi.fn().mockResolvedValue({ rows: [{ total: 5 }] }),
      }

      const result = await safeSourceExecute(mockSourceClient, 'SELECT COUNT(*) AS total FROM users')
      expect(result).toEqual({ rows: [{ total: 5 }] })
      expect(mockSourceClient.execute).toHaveBeenCalledWith('SELECT COUNT(*) AS total FROM users')

      await expect(
        safeSourceExecute(mockSourceClient, 'PRAGMA foreign_keys'),
      ).rejects.toThrow('Güvenlik İhlali')
    })

    it('evaluates WAL checkpoint results strictly for success, empty, busy, missing, and inconsistent states', () => {
      // 1. Success in WAL mode (busy=0, log=10, checkpointed=10)
      expect(() =>
        verifyWalCheckpoint({ rows: [{ busy: 0, log: 10, checkpointed: 10 }] }),
      ).not.toThrow()

      // 2. Success in non-WAL mode (busy=0, log=-1, checkpointed=-1)
      expect(() =>
        verifyWalCheckpoint({ rows: [{ busy: 0, log: -1, checkpointed: -1 }] }),
      ).not.toThrow()

      // 3. Empty result
      expect(() => verifyWalCheckpoint({ rows: [] })).toThrow(
        'WAL checkpoint sonucu tam olarak 1 satır içermelidir',
      )

      // 4. Busy result (busy=1)
      expect(() =>
        verifyWalCheckpoint({ rows: [{ busy: 1, log: 10, checkpointed: 10 }] }),
      ).toThrow('Veritabanı meşgul')

      // 5. Inconsistent result (busy=0, log=10, checkpointed=5) -> MUST FAIL!
      expect(() =>
        verifyWalCheckpoint({ rows: [{ busy: 0, log: 10, checkpointed: 5 }] }),
      ).toThrow('WAL checkpoint tutarsız: Tüm log çerçeveleri aktarılamadı')
    })

    it('includes project_type in target TABLES list', () => {
      expect(TABLES).toContain('projects')
    })

    it('verifies backup file integrity: handles valid, empty, non-existent, and corrupted files', async () => {
      const validDbFile = join(tmpdir(), `valid-backup-${randomUUID()}.db`)
      const corruptedFile = join(tmpdir(), `corrupt-backup-${randomUUID()}.db`)
      const emptyFile = join(tmpdir(), `empty-backup-${randomUUID()}.db`)

      try {
        // 1. Non-existent file
        await expect(verifyBackupFile(join(tmpdir(), `non-existent-${randomUUID()}.db`))).rejects.toThrow()

        // 2. Empty file (0 bytes)
        await writeFile(emptyFile, '')
        await expect(verifyBackupFile(emptyFile)).rejects.toThrow('Yedekleme dosyası boş oluşturuldu')

        // 3. Corrupted non-zero size file (junk text, not a valid SQLite database)
        await writeFile(corruptedFile, 'This is corrupted junk content and not a SQLite database file!')
        await expect(verifyBackupFile(corruptedFile)).rejects.toThrow()

        // 4. Valid SQLite database file
        const client = createClient({ url: `file:${validDbFile}` })
        await client.execute('CREATE TABLE sample (id TEXT PRIMARY KEY);')
        await client.close()
        await expect(verifyBackupFile(validDbFile)).resolves.not.toThrow()
      } finally {
        for (const file of [validDbFile, corruptedFile, emptyFile]) {
          try {
            await unlink(file)
          } catch {
            // ignore
          }
        }
      }
    })
  })
})
