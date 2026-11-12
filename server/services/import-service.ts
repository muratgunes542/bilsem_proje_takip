import { randomUUID } from 'node:crypto'
import { and, count, eq, isNull } from 'drizzle-orm'
import { AuthorizationError, canManageAllRecords, ResourceNotFoundError, type AuthenticatedUser } from '../authorization.js'
import * as schema from '../db/schema.js'
import type { AppDatabase } from './project-service.js'

export type StudentImportRecord = {
  rowNumber?: number
  bilsemNo?: string
  firstName?: string
  lastName?: string
  schoolName?: string | null
  gradeLevel?: number | null
  className?: string | null
  advisorName?: string | null
  talentArea?: string | null
  formulaFields?: string[]
  invalidFields?: string[]
}

export type ImportRecordResult = {
  rowNumber: number
  bilsemNo: string | null
  firstName?: string
  lastName?: string
  resultTypes: schema.ImportResultType[]
  matchedAdvisorUserId?: string | null
  resolutionRequired?: boolean
  schoolName?: string | null
  gradeLevel?: number | null
  className?: string | null
  advisorName?: string | null
  talentArea?: string | null
  message?: string
}

export class ImportBatchStateError extends Error {
  readonly statusCode = 422
}

export class StudentImportService {
  constructor(private readonly database: AppDatabase) {}

  async previewImport(actor: AuthenticatedUser, academicYearId: string, fileName: string, records: StudentImportRecord[], extraWarnings: unknown[] = []) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Excel aktarımı önizleme yetkiniz yok.')

    return this.database.transaction(async (transaction) => {
      const batchId = randomUUID()

      const academicYear = await transaction.select({ id: schema.academicYears.id })
        .from(schema.academicYears)
        .where(and(eq(schema.academicYears.id, academicYearId), isNull(schema.academicYears.deletedAt)))
        .limit(1)
      if (!academicYear[0]) throw new ResourceNotFoundError('Akademik yıl bulunamadı.')

      // Automatic matches require a unique exact account-name match.
      const users = await transaction
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(and(eq(schema.users.isActive, true), eq(schema.users.role, 'TEACHER'), isNull(schema.users.deletedAt)))

      const userMap = new Map<string, string[]>()
      for (const u of users) {
        const key = u.name.trim().toLocaleLowerCase('tr-TR')
        userMap.set(key, [...(userMap.get(key) ?? []), u.id])
      }

      const duplicateNumbersInFile = new Set(
        records
          .map((r) => r.bilsemNo?.trim())
          .filter((v): v is string => Boolean(v))
          .filter((v, index, all) => all.indexOf(v) !== index)
      )

      const importedStudentIds = new Set<string>()
      const results: ImportRecordResult[] = []

      await transaction.insert(schema.importBatches).values({
        id: batchId,
        academicYearId,
        fileName: fileName.split(/[\\/]/).at(-1)?.slice(0, 255) ?? 'students.xlsx',
        createdBy: actor.id,
        status: 'READY',
        warningsJson: JSON.stringify(extraWarnings),
      })

      for (const [index, record] of records.entries()) {
        const rowNumber = record.rowNumber ?? index + 1
        const bilsemNo = record.bilsemNo?.trim() ?? ''

        if (!bilsemNo || !record.firstName?.trim() || !record.lastName?.trim() || !record.talentArea?.trim() || !record.advisorName?.trim() || record.formulaFields?.length || record.invalidFields?.length) {
          results.push({
            rowNumber,
            bilsemNo: bilsemNo || null,
            firstName: record.firstName,
            lastName: record.lastName,
            resultTypes: ['INVALID_RECORD'],
            message: record.formulaFields?.length ? 'Formül hücreleri öğrenci verisi olarak kabul edilmez.'
              : record.invalidFields?.includes('bilsemNo') ? 'BİLSEM numarası boşluksuz, yalnızca rakamlardan oluşmalıdır. Sayısal hücrelerde yalnızca tam sayı veya açık sıfır dolgulu biçimler kabul edilir.'
                : 'Zorunlu alan (BİLSEM no, ad, soyad, yetenek alanı, danışman öğretmen) eksik.',
          })
          continue
        }

        if (duplicateNumbersInFile.has(bilsemNo)) {
          results.push({
            rowNumber,
            bilsemNo,
            firstName: record.firstName,
            lastName: record.lastName,
            resultTypes: ['DUPLICATE_BILSEM_NO'],
            message: 'Aktarım dosyasında mükerrer BİLSEM numarası.',
          })
          continue
        }

        const existingStudent = await transaction
          .select()
          .from(schema.students)
          .where(eq(schema.students.bilsemNo, bilsemNo))
          .limit(1)

        const studentId = existingStudent[0]?.id ?? randomUUID()
        const resultTypes: schema.ImportResultType[] = []

        if (!existingStudent[0]) {
          resultTypes.push('NEW_STUDENT')
        } else {
          resultTypes.push('CONTINUING_STUDENT')
        }

        const existingEnrollment = await transaction
          .select()
          .from(schema.studentEnrollments)
          .where(and(
            eq(schema.studentEnrollments.studentId, studentId),
            eq(schema.studentEnrollments.academicYearId, academicYearId),
          ))
          .limit(1)

        const advisorKey = record.advisorName!.trim().toLocaleLowerCase('tr-TR')
        const advisorMatches = userMap.get(advisorKey) ?? []
        const matchedAdvisorUserId = advisorMatches.length === 1 ? advisorMatches[0] : null
        if (!matchedAdvisorUserId) resultTypes.push('UNMATCHED_TEACHER')
        const advisorChanged = existingEnrollment[0]
          ? existingEnrollment[0].advisorUserId
            ? existingEnrollment[0].advisorUserId !== matchedAdvisorUserId
            : existingEnrollment[0].advisorName?.trim().toLocaleLowerCase('tr-TR') !== advisorKey
          : false
        const talentChanged = Boolean(existingEnrollment[0] && existingEnrollment[0].talentArea !== (record.talentArea ?? null))
        if (advisorChanged && talentChanged) resultTypes.push('ADVISOR_AND_TALENT_CHANGED')
        else {
          if (advisorChanged) resultTypes.push('ADVISOR_CHANGED')
          if (talentChanged) resultTypes.push('TALENT_AREA_CHANGED')
        }

        importedStudentIds.add(studentId)

        results.push({
          rowNumber,
          bilsemNo,
          firstName: record.firstName.trim(),
          lastName: record.lastName.trim(),
          resultTypes,
          matchedAdvisorUserId,
          resolutionRequired: !matchedAdvisorUserId,
          schoolName: record.schoolName ?? null,
          gradeLevel: record.gradeLevel ?? null,
          className: record.className ?? null,
          advisorName: record.advisorName ?? null,
          talentArea: record.talentArea ?? null,
        })
      }

      // Check current enrollments in that academic year that are NOT in the import file
      const currentEnrollments = await transaction
        .select({
          enrollmentId: schema.studentEnrollments.id,
          studentId: schema.studentEnrollments.studentId,
          bilsemNo: schema.students.bilsemNo,
          firstName: schema.students.firstName,
          lastName: schema.students.lastName,
        })
        .from(schema.studentEnrollments)
        .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
        .where(and(
          eq(schema.studentEnrollments.academicYearId, academicYearId),
          isNull(schema.studentEnrollments.deletedAt),
        ))

      for (const enrollment of currentEnrollments) {
        if (!importedStudentIds.has(enrollment.studentId)) {
          results.push({
            rowNumber: 0,
            bilsemNo: enrollment.bilsemNo,
            firstName: enrollment.firstName,
            lastName: enrollment.lastName,
            resultTypes: ['NOT_IN_CURRENT_IMPORT'],
            message: 'Mevcut akademik yıl listesinde var fakat aktarım dosyasında yok (Silinmez).',
          })
        }
      }

      if (results.length > 0) {
        const lastSourceRow = Math.max(...records.map((record, index) => record.rowNumber ?? index + 1))
        await transaction.insert(schema.importRows).values(
          results.map((result, idx) => {
            const isInvalid = result.resultTypes.some((type) =>
              ['INVALID_RECORD', 'DUPLICATE_BILSEM_NO', 'UNMATCHED_TEACHER'].includes(type))
            const status: schema.ImportRowStatus = isInvalid ? 'INVALID' : 'VALID'
            return {
              id: randomUUID(),
              batchId,
              rowNumber: result.rowNumber || lastSourceRow + idx + 1,
              rawJson: JSON.stringify(result),
              normalizedJson: JSON.stringify({
                bilsemNo: result.bilsemNo,
                firstName: result.firstName,
                lastName: result.lastName,
              }),
              status,
              resultType: result.resultTypes[0],
              matchedAdvisorUserId: result.matchedAdvisorUserId ?? null,
              isSourceRow: result.rowNumber > 0,
              errorMessage: result.message,
            }
          })
        )
      }

      const sourceResults = results.filter((result) => result.rowNumber > 0)
      const invalidRows = sourceResults.filter((r) => r.resultTypes.some((type) =>
        ['INVALID_RECORD', 'DUPLICATE_BILSEM_NO', 'UNMATCHED_TEACHER'].includes(type))).length
      const validRows = sourceResults.length - invalidRows
      const newStudentCount = sourceResults.filter((row) => row.resultTypes.includes('NEW_STUDENT')).length
      const continuingStudentCount = sourceResults.filter((row) => row.resultTypes.includes('CONTINUING_STUDENT')).length
      const changedCount = sourceResults.filter((row) => row.resultTypes.some((type) =>
        ['ADVISOR_CHANGED', 'TALENT_AREA_CHANGED', 'ADVISOR_AND_TALENT_CHANGED'].includes(type))).length

      await transaction
        .update(schema.importBatches)
        .set({
          totalRows: records.length,
          validRows,
          invalidRows,
          newStudentCount,
          continuingStudentCount,
          changedCount,
          updatedAt: new Date(),
        })
        .where(eq(schema.importBatches.id, batchId))

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: actor.id, action: 'IMPORT_BATCH_PREVIEWED',
        entityType: 'IMPORT_BATCH', entityId: batchId,
        afterJson: JSON.stringify({ academicYearId, fileName, totalRows: records.length, invalidRows, newStudentCount, continuingStudentCount, changedCount }),
      })

      return {
        batchId,
        totalRows: records.length,
        validRows,
        invalidRows,
        newStudentCount,
        continuingStudentCount,
        changedCount,
        warnings: extraWarnings,
        results,
      }
    })
  }

  async getBatch(actor: AuthenticatedUser, batchId: string) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Aktarım görüntüleme yetkiniz yok.')
    const rows = await this.database.select({
      id: schema.importBatches.id,
      academicYearId: schema.importBatches.academicYearId,
      academicYearName: schema.academicYears.name,
      fileName: schema.importBatches.fileName,
      status: schema.importBatches.status,
      totalRows: schema.importBatches.totalRows,
      validRows: schema.importBatches.validRows,
      invalidRows: schema.importBatches.invalidRows,
      newStudentCount: schema.importBatches.newStudentCount,
      continuingStudentCount: schema.importBatches.continuingStudentCount,
      changedCount: schema.importBatches.changedCount,
      createdBy: schema.importBatches.createdBy,
      uploadedBy: schema.users.name,
      approvedBy: schema.importBatches.approvedBy,
      approvedAt: schema.importBatches.approvedAt,
      createdAt: schema.importBatches.createdAt,
      updatedAt: schema.importBatches.updatedAt,
      warningsJson: schema.importBatches.warningsJson,
    }).from(schema.importBatches)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.importBatches.academicYearId))
      .innerJoin(schema.users, eq(schema.users.id, schema.importBatches.createdBy))
      .where(and(eq(schema.importBatches.id, batchId), isNull(schema.importBatches.deletedAt)))
      .limit(1)
    const batch = rows[0]
    if (!batch) throw new ResourceNotFoundError('Aktarım paketi bulunamadı.')
    return { ...batch, warnings: batch.warningsJson ? JSON.parse(batch.warningsJson) as unknown[] : [] }
  }

  async listBatchRows(actor: AuthenticatedUser, batchId: string, options: { page?: number; pageSize?: number } = {}) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Aktarım satırlarını görüntüleme yetkiniz yok.')
    await this.getBatch(actor, batchId)
    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20))
    const [totalRow] = await this.database.select({ total: count() }).from(schema.importRows)
      .where(eq(schema.importRows.batchId, batchId))
    const rows = await this.database.select({
      id: schema.importRows.id,
      rowNumber: schema.importRows.rowNumber,
      status: schema.importRows.status,
      resultType: schema.importRows.resultType,
      errorMessage: schema.importRows.errorMessage,
      matchedAdvisorUserId: schema.importRows.matchedAdvisorUserId,
      isSourceRow: schema.importRows.isSourceRow,
      rawJson: schema.importRows.rawJson,
    }).from(schema.importRows).where(eq(schema.importRows.batchId, batchId))
      .orderBy(schema.importRows.rowNumber).limit(pageSize).offset((page - 1) * pageSize)
    const total = totalRow?.total ?? 0
    return {
      rows: rows.map(({ rawJson, ...row }) => ({ ...row, result: JSON.parse(rawJson) as ImportRecordResult })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  async resolveAdvisor(actor: AuthenticatedUser, batchId: string, rowId: string, advisorUserId: string) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Danışman eşleştirme yetkiniz yok.')
    return this.database.transaction(async (transaction) => {
      const [batch] = await transaction.select({ status: schema.importBatches.status }).from(schema.importBatches)
        .where(eq(schema.importBatches.id, batchId)).limit(1)
      if (!batch) throw new ResourceNotFoundError('Aktarım paketi bulunamadı.')
      if (batch.status !== 'READY') throw new ImportBatchStateError('Yalnızca bekleyen aktarımın eşleştirmesi değiştirilebilir.')
      const [row] = await transaction.select().from(schema.importRows)
        .where(and(eq(schema.importRows.id, rowId), eq(schema.importRows.batchId, batchId))).limit(1)
      if (!row) throw new ResourceNotFoundError('Aktarım satırı bulunamadı.')
      const [teacher] = await transaction.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
        .where(and(eq(schema.users.id, advisorUserId), eq(schema.users.role, 'TEACHER'), eq(schema.users.isActive, true), isNull(schema.users.deletedAt))).limit(1)
      if (!teacher) throw new ResourceNotFoundError('Etkin öğretmen hesabı bulunamadı.')

      const result = JSON.parse(row.rawJson) as ImportRecordResult
      if (!result.resultTypes.includes('UNMATCHED_TEACHER')) throw new ImportBatchStateError('Bu satırda çözümlenmemiş öğretmen eşleştirmesi yok.')
      result.resultTypes = result.resultTypes.filter((type) => type !== 'UNMATCHED_TEACHER')
      result.matchedAdvisorUserId = teacher.id
      result.resolutionRequired = false
      result.advisorName = teacher.name
      result.message = undefined
      const resultType = result.resultTypes.find((type) => type !== 'CONTINUING_STUDENT' && type !== 'NEW_STUDENT') ?? result.resultTypes[0]
      await transaction.update(schema.importRows).set({
        status: 'VALID', matchedAdvisorUserId: teacher.id, errorMessage: null,
        resultType, rawJson: JSON.stringify(result), updatedAt: new Date(),
      }).where(eq(schema.importRows.id, rowId))
      const remaining = await transaction.select({ status: schema.importRows.status, isSourceRow: schema.importRows.isSourceRow }).from(schema.importRows)
        .where(eq(schema.importRows.batchId, batchId))
      const invalidRows = remaining.filter((item) => item.isSourceRow && item.status === 'INVALID').length
      const validRows = remaining.filter((item) => item.isSourceRow && item.status === 'VALID').length
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: actor.id, action: 'IMPORT_ADVISOR_RESOLVED',
        entityType: 'IMPORT_ROW', entityId: rowId,
        afterJson: JSON.stringify({ batchId, rowId, advisorUserId }),
      })
      await transaction.update(schema.importBatches).set({ invalidRows, validRows, updatedAt: new Date() })
        .where(eq(schema.importBatches.id, batchId))
      return { rowId, advisorUserId, advisorName: teacher.name, status: 'VALID' as const }
    })
  }

  async cancelImport(actor: AuthenticatedUser, batchId: string) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Aktarımı iptal etme yetkiniz yok.')
    return this.database.transaction(async (transaction) => {
      const [batch] = await transaction.select().from(schema.importBatches)
        .where(eq(schema.importBatches.id, batchId)).limit(1)
      if (!batch) throw new ResourceNotFoundError('Aktarım paketi bulunamadı.')
      if (batch.status !== 'READY') throw new ImportBatchStateError('Yalnızca bekleyen aktarım iptal edilebilir.')
      await transaction.update(schema.importBatches).set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(schema.importBatches.id, batchId))
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: actor.id, action: 'IMPORT_BATCH_CANCELLED',
        entityType: 'IMPORT_BATCH', entityId: batchId,
      })
      return { batchId, status: 'CANCELLED' as const }
    })
  }

  async commitImport(actor: AuthenticatedUser, batchId: string) {
    if (!canManageAllRecords(actor)) throw new AuthorizationError('Excel aktarımını onaylama yetkiniz yok.')

    return this.database.transaction(async (transaction) => {
      const batchRows = await transaction
        .select()
        .from(schema.importBatches)
        .where(eq(schema.importBatches.id, batchId))
        .limit(1)

      const batch = batchRows[0]
      if (!batch) throw new ResourceNotFoundError('Aktarım paketi bulunamadı.')
      if (batch.status !== 'READY') throw new ImportBatchStateError('Onaylanacak geçerli aktarım paketi bulunamadı.')

      const [year] = await transaction.select({ id: schema.academicYears.id }).from(schema.academicYears)
        .where(and(eq(schema.academicYears.id, batch.academicYearId), isNull(schema.academicYears.deletedAt))).limit(1)
      if (!year) throw new ResourceNotFoundError('Aktarımın akademik yılı artık kullanılamıyor.')

      const rows = await transaction
        .select()
        .from(schema.importRows)
        .where(and(eq(schema.importRows.batchId, batchId), eq(schema.importRows.status, 'VALID'), eq(schema.importRows.isSourceRow, true)))

      if (rows.length === 0) throw new ImportBatchStateError('Onaylanabilir geçerli öğrenci satırı bulunamadı.')

      let importedCount = 0

      for (const row of rows) {
        if (!row.rawJson) continue
        const data = JSON.parse(row.rawJson) as ImportRecordResult
        if (!data.bilsemNo || !data.firstName || !data.lastName) continue
        if (!row.matchedAdvisorUserId) throw new ImportBatchStateError('Danışmanı eşleştirilmemiş satırlar onaylanamaz.')
        const [advisor] = await transaction.select({ id: schema.users.id }).from(schema.users)
          .where(and(eq(schema.users.id, row.matchedAdvisorUserId), eq(schema.users.role, 'TEACHER'), eq(schema.users.isActive, true), isNull(schema.users.deletedAt))).limit(1)
        if (!advisor) throw new ImportBatchStateError('Eşleştirilen öğretmen hesabı etkin değil; aktarım önizlemesini yenileyin.')

        // 1. Insert or get student
        const existingStudent = await transaction
          .select({ id: schema.students.id })
          .from(schema.students)
          .where(eq(schema.students.bilsemNo, data.bilsemNo))
          .limit(1)

        let studentId = existingStudent[0]?.id
        if (!studentId) {
          studentId = randomUUID()
          await transaction.insert(schema.students).values({
            id: studentId,
            bilsemNo: data.bilsemNo,
            firstName: data.firstName,
            lastName: data.lastName,
          })
        } else {
          await transaction
            .update(schema.students)
            .set({
              firstName: data.firstName,
              lastName: data.lastName,
              deletedAt: null,
              deletedBy: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.students.id, studentId))
        }

        // 2. Insert or update enrollment
        const existingEnrollment = await transaction
          .select({ id: schema.studentEnrollments.id })
          .from(schema.studentEnrollments)
          .where(and(
            eq(schema.studentEnrollments.studentId, studentId),
            eq(schema.studentEnrollments.academicYearId, batch.academicYearId),
          ))
          .limit(1)

        if (existingEnrollment[0]) {
          await transaction
            .update(schema.studentEnrollments)
            .set({
              isActive: true,
              schoolName: data.schoolName,
              gradeLevel: data.gradeLevel,
              className: data.className,
              advisorName: data.advisorName,
              advisorUserId: row.matchedAdvisorUserId,
              talentArea: data.talentArea ?? null,
              deletedAt: null,
              deletedBy: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.studentEnrollments.id, existingEnrollment[0].id))
        } else {
          await transaction.insert(schema.studentEnrollments).values({
            id: randomUUID(),
            studentId,
            academicYearId: batch.academicYearId,
            isActive: true,
            schoolName: data.schoolName ?? null,
            gradeLevel: data.gradeLevel ?? null,
            className: data.className ?? null,
            advisorName: data.advisorName ?? null,
            advisorUserId: row.matchedAdvisorUserId,
            talentArea: data.talentArea ?? null,
          })
        }

        await transaction
          .update(schema.importRows)
          .set({ status: 'IMPORTED', studentId, updatedAt: new Date() })
          .where(eq(schema.importRows.id, row.id))

        importedCount++
      }

      await transaction
        .update(schema.importBatches)
        .set({
          status: 'IMPORTED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.importBatches.id, batchId))

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'IMPORT_BATCH_COMMITTED',
        entityType: 'IMPORT_BATCH',
        entityId: batchId,
        afterJson: JSON.stringify({ batchId, importedCount }),
      })

      return {
        batchId,
        importedCount,
      }
    })
  }
}
