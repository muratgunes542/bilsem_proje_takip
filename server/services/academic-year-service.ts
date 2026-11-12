import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { AuthorizationError, canManageAllRecords, type AuthenticatedUser } from '../authorization.js'
import * as schema from '../db/schema.js'
import type { AppDatabase } from './project-service.js'

export type CreateAcademicYearInput = {
  name: string
  startsOn: Date
  endsOn: Date
  isCurrent?: boolean
}

export class AcademicYearService {
  constructor(private readonly database: AppDatabase) {}

  async listAcademicYears(actor: AuthenticatedUser) {
    if (!actor || !actor.isActive) throw new AuthorizationError()

    return this.database
      .select({
        id: schema.academicYears.id,
        name: schema.academicYears.name,
        startsOn: schema.academicYears.startsOn,
        endsOn: schema.academicYears.endsOn,
        isCurrent: schema.academicYears.isCurrent,
        createdAt: schema.academicYears.createdAt,
      })
      .from(schema.academicYears)
      .where(isNull(schema.academicYears.deletedAt))
      .orderBy(desc(schema.academicYears.startsOn))
  }

  async getCurrentAcademicYear(actor: AuthenticatedUser) {
    if (!actor || !actor.isActive) throw new AuthorizationError()

    const rows = await this.database
      .select({
        id: schema.academicYears.id,
        name: schema.academicYears.name,
        startsOn: schema.academicYears.startsOn,
        endsOn: schema.academicYears.endsOn,
        isCurrent: schema.academicYears.isCurrent,
      })
      .from(schema.academicYears)
      .where(and(eq(schema.academicYears.isCurrent, true), isNull(schema.academicYears.deletedAt)))
      .limit(1)

    if (rows[0]) return rows[0]

    // Fallback: Return latest academic year
    const latest = await this.database
      .select({
        id: schema.academicYears.id,
        name: schema.academicYears.name,
        startsOn: schema.academicYears.startsOn,
        endsOn: schema.academicYears.endsOn,
        isCurrent: schema.academicYears.isCurrent,
      })
      .from(schema.academicYears)
      .where(isNull(schema.academicYears.deletedAt))
      .orderBy(desc(schema.academicYears.startsOn))
      .limit(1)

    return latest[0] ?? null
  }

  async createAcademicYear(actor: AuthenticatedUser, input: CreateAcademicYearInput) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Akademik yıl ekleme yetkiniz yok.')

    return this.database.transaction(async (transaction) => {
      if (input.isCurrent) {
        await transaction
          .update(schema.academicYears)
          .set({ isCurrent: false, updatedAt: new Date() })
          .where(eq(schema.academicYears.isCurrent, true))
      }

      const id = randomUUID()
      await transaction.insert(schema.academicYears).values({
        id,
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        isCurrent: input.isCurrent ?? false,
      })

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'ACADEMIC_YEAR_CREATED',
        entityType: 'ACADEMIC_YEAR',
        entityId: id,
        afterJson: JSON.stringify(input),
      })

      const [created] = await transaction
        .select({
          id: schema.academicYears.id,
          name: schema.academicYears.name,
          startsOn: schema.academicYears.startsOn,
          endsOn: schema.academicYears.endsOn,
          isCurrent: schema.academicYears.isCurrent,
        })
        .from(schema.academicYears)
        .where(eq(schema.academicYears.id, id))

      return created
    })
  }
}
