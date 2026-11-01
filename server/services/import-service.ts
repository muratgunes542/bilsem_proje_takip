import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { AuthenticatedUser } from '../authorization'
import * as schema from '../db/schema'
import type { AppDatabase } from './project-service'

export type StudentImportRecord = {
  bilsemNo?: string
  firstName?: string
  lastName?: string
  schoolName?: string | null
  gradeLevel?: number | null
  className?: string | null
  advisorName?: string | null
  talentArea?: string | null
}

export type ImportRecordResult = {
  rowNumber: number
  bilsemNo: string | null
  resultTypes: schema.ImportResultType[]
  message?: string
}

export class StudentImportService {
  constructor(private readonly database: AppDatabase) {}

  async importAcademicYear(actor: AuthenticatedUser, academicYearId: string, fileName: string, records: StudentImportRecord[]) {
    return this.database.transaction(async (transaction) => {
      const batchId = randomUUID()
      const duplicateNumbers = new Set(records
        .map((record) => record.bilsemNo?.trim())
        .filter((value): value is string => Boolean(value))
        .filter((value, index, all) => all.indexOf(value) !== index))
      const importedStudentIds = new Set<string>()
      const results: ImportRecordResult[] = []

      await transaction.insert(schema.importBatches).values({ id: batchId, academicYearId, fileName, createdBy: actor.id, status: 'VALIDATING' })

      for (const [index, record] of records.entries()) {
        const rowNumber = index + 1
        const bilsemNo = record.bilsemNo?.trim() ?? ''
        if (!bilsemNo || !record.firstName?.trim() || !record.lastName?.trim()) {
          results.push({ rowNumber, bilsemNo: bilsemNo || null, resultTypes: ['INVALID_RECORD'], message: 'Zorunlu alan eksik.' })
          continue
        }
        if (duplicateNumbers.has(bilsemNo)) {
          results.push({ rowNumber, bilsemNo, resultTypes: ['DUPLICATE_BILSEM_NO'], message: 'Aktarım dosyasında BİLSEM numarası tekrar ediyor.' })
          continue
        }

        const existingStudent = await transaction.select().from(schema.students)
          .where(eq(schema.students.bilsemNo, bilsemNo)).limit(1)
        const studentId = existingStudent[0]?.id ?? randomUUID()
        const resultTypes: schema.ImportResultType[] = []

        if (!existingStudent[0]) {
          await transaction.insert(schema.students).values({
            id: studentId, bilsemNo, firstName: record.firstName.trim(), lastName: record.lastName.trim(),
          })
          resultTypes.push('NEW_STUDENT')
        } else {
          resultTypes.push('CONTINUING_STUDENT')
        }

        const existingEnrollment = await transaction.select().from(schema.studentEnrollments).where(and(
          eq(schema.studentEnrollments.studentId, studentId),
          eq(schema.studentEnrollments.academicYearId, academicYearId),
        )).limit(1)

        if (existingEnrollment[0]?.advisorName !== (record.advisorName ?? null)) resultTypes.push('ADVISOR_CHANGED')
        if (existingEnrollment[0]?.talentArea !== (record.talentArea ?? null)) resultTypes.push('TALENT_AREA_CHANGED')

        if (existingEnrollment[0]) {
          await transaction.update(schema.studentEnrollments).set({
            schoolName: record.schoolName, gradeLevel: record.gradeLevel, className: record.className,
            advisorName: record.advisorName, talentArea: record.talentArea, isActive: true,
            deletedAt: null, deletedBy: null, updatedAt: new Date(),
          }).where(eq(schema.studentEnrollments.id, existingEnrollment[0].id))
        } else {
          await transaction.insert(schema.studentEnrollments).values({
            id: randomUUID(), studentId, academicYearId, schoolName: record.schoolName,
            gradeLevel: record.gradeLevel, className: record.className, advisorName: record.advisorName,
            talentArea: record.talentArea, isActive: true,
          })
        }
        importedStudentIds.add(studentId)
        results.push({ rowNumber, bilsemNo, resultTypes })
      }

      const currentEnrollments = await transaction.select().from(schema.studentEnrollments)
        .where(eq(schema.studentEnrollments.academicYearId, academicYearId))
      for (const enrollment of currentEnrollments) {
        if (!importedStudentIds.has(enrollment.studentId)) {
          await transaction.update(schema.studentEnrollments).set({ isActive: false, updatedAt: new Date() })
            .where(eq(schema.studentEnrollments.id, enrollment.id))
          const student = await transaction.select({ bilsemNo: schema.students.bilsemNo }).from(schema.students)
            .where(eq(schema.students.id, enrollment.studentId)).limit(1)
          results.push({ rowNumber: 0, bilsemNo: student[0]?.bilsemNo ?? null, resultTypes: ['NOT_IN_CURRENT_IMPORT'] })
        }
      }

      if (results.length > 0) {
        await transaction.insert(schema.importRows).values(results.map((result, index) => {
          const status: 'INVALID' | 'IMPORTED' = result.resultTypes.some((type) => type === 'INVALID_RECORD' || type === 'DUPLICATE_BILSEM_NO') ? 'INVALID' : 'IMPORTED'
          return {
            id: randomUUID(), batchId, rowNumber: result.rowNumber || records.length + index + 1,
            rawJson: JSON.stringify(result), normalizedJson: JSON.stringify({ bilsemNo: result.bilsemNo }),
            status, resultType: result.resultTypes[0], errorMessage: result.message,
          }
        }))
      }

      const invalidRows = results.filter((result) => result.resultTypes.some((type) => type === 'INVALID_RECORD' || type === 'DUPLICATE_BILSEM_NO')).length
      await transaction.update(schema.importBatches).set({
        status: 'IMPORTED', totalRows: results.length, validRows: results.length - invalidRows, invalidRows, updatedAt: new Date(),
      }).where(eq(schema.importBatches.id, batchId))
      return { batchId, results }
    })
  }
}
