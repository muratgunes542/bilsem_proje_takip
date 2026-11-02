import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateMigrationTarget } from '../scripts/migrate'

describe('Migration Target Safety Guards (Unit Tests)', () => {
  it('allows production migration when target is remote libsql:// with authToken and correct confirmation', () => {
    expect(() => {
      validateMigrationTarget({
        appEnv: 'production',
        databaseUrl: 'libsql://bilsem-prod-db.turso.io',
        authToken: 'valid-turso-token-123',
        confirmationInput: 'MIGRATE_PROD',
        expectedDatabaseName: 'bilsem-prod-db',
      })
    }).not.toThrow()
  })

  it('rejects production migration if target URL is a local file database', () => {
    expect(() => {
      validateMigrationTarget({
        appEnv: 'production',
        databaseUrl: 'file:./local.db',
        authToken: 'valid-token',
        confirmationInput: 'MIGRATE_PROD',
      })
    }).toThrow('Production migration aborted: TURSO_DATABASE_URL must be a remote libsql:// database.')
  })

  it('rejects production migration if auth token is missing', () => {
    expect(() => {
      validateMigrationTarget({
        appEnv: 'production',
        databaseUrl: 'libsql://bilsem-prod-db.turso.io',
        authToken: undefined,
        confirmationInput: 'MIGRATE_PROD',
      })
    }).toThrow('Production migration aborted: TURSO_AUTH_TOKEN is required.')
  })

  it('rejects production migration if confirmation input is invalid or missing', () => {
    expect(() => {
      validateMigrationTarget({
        appEnv: 'production',
        databaseUrl: 'libsql://bilsem-prod-db.turso.io',
        authToken: 'valid-token',
        confirmationInput: 'YES',
      })
    }).toThrow('Migration canceled: Invalid or missing confirmation input.')
  })

  it('rejects production migration if database name does not match expected target', () => {
    expect(() => {
      validateMigrationTarget({
        appEnv: 'production',
        databaseUrl: 'libsql://wrong-db.turso.io',
        authToken: 'valid-token',
        confirmationInput: 'MIGRATE_PROD',
        expectedDatabaseName: 'bilsem-prod-db',
      })
    }).toThrow("Migration canceled: Target database URL does not match expected database name 'bilsem-prod-db'.")
  })

  it('ensures CI/test environment conditions cannot bypass production migration guards', () => {
    expect(() => {
      validateMigrationTarget({
        appEnv: 'production',
        databaseUrl: 'file:./test.db',
        authToken: 'token',
        confirmationInput: 'MIGRATE_PROD',
      })
    }).toThrow('Production migration aborted')
  })
})

describe('Migration CLI Entry Point (Child Process Tests)', () => {
  const rootDir = join(__dirname, '..')

  it('CLI rejects production migration when TURSO_DATABASE_URL is a local file database', () => {
    let output = ''
    let exitCode = 0
    try {
      execSync('npx tsx scripts/migrate.ts', {
        cwd: rootDir,
        env: {
          ...process.env,
          MIGRATE_RUN: 'true',
          APP_ENV: 'production',
          TURSO_DATABASE_URL: 'file:./local.db',
          TURSO_AUTH_TOKEN: 'mock-token',
          BETTER_AUTH_SECRET: '32characterlongmocksecretkeyvalue!!',
          BETTER_AUTH_URL: 'http://localhost:3000',
        },
        encoding: 'utf-8',
        stdio: 'pipe',
      })
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string }
      exitCode = execErr.status ?? 1
      output = (execErr.stdout ?? '') + (execErr.stderr ?? '')
    }

    expect(exitCode).not.toBe(0)
    expect(output).toContain('Production environment cannot use a local file database URL')
  })

  it('CLI rejects production migration when TURSO_AUTH_TOKEN is missing', () => {
    let output = ''
    let exitCode = 0
    try {
      execSync('npx tsx scripts/migrate.ts', {
        cwd: rootDir,
        env: {
          ...process.env,
          MIGRATE_RUN: 'true',
          APP_ENV: 'production',
          TURSO_DATABASE_URL: 'libsql://bilsem-prod-db.turso.io',
          TURSO_AUTH_TOKEN: '',
          BETTER_AUTH_SECRET: '32characterlongmocksecretkeyvalue!!',
          BETTER_AUTH_URL: 'http://localhost:3000',
        },
        encoding: 'utf-8',
        stdio: 'pipe',
      })
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string }
      exitCode = execErr.status ?? 1
      output = (execErr.stdout ?? '') + (execErr.stderr ?? '')
    }

    expect(exitCode).not.toBe(0)
    expect(output).toContain('Production environment requires TURSO_AUTH_TOKEN')
  })

  it('CLI rejects production migration when confirmation MIGRATE_PROD is not provided', () => {
    let output = ''
    let exitCode = 0
    try {
      execSync('npx tsx scripts/migrate.ts', {
        cwd: rootDir,
        env: {
          ...process.env,
          MIGRATE_RUN: 'true',
          APP_ENV: 'production',
          TURSO_DATABASE_URL: 'libsql://bilsem-prod-db.turso.io',
          TURSO_AUTH_TOKEN: 'mock-token-123',
          BETTER_AUTH_SECRET: '32characterlongmocksecretkeyvalue!!',
          BETTER_AUTH_URL: 'http://localhost:3000',
          MIGRATE_CONFIRM: 'NO',
        },
        encoding: 'utf-8',
        stdio: 'pipe',
        input: 'WRONG_CONFIRM\n',
      })
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string }
      exitCode = execErr.status ?? 1
      output = (execErr.stdout ?? '') + (execErr.stderr ?? '')
    }

    expect(exitCode).not.toBe(0)
    expect(output).toContain('Migration canceled: Invalid or missing confirmation input')
  })
})
