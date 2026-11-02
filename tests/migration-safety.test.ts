import { describe, expect, it } from 'vitest'
import { validateMigrationTarget } from '../scripts/migrate'

describe('Migration Target Safety Guards', () => {
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
    // Even in CI or test mode, if appEnv === 'production' and inputs are invalid, it MUST throw
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
