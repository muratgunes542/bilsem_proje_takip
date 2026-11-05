import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { AuthorizationError, canViewStudents, ResourceNotFoundError, type AuthenticatedUser } from '../authorization.js'
import * as schema from '../db/schema.js'
import type { AppDatabase } from './project-service.js'

export type ListStudentsOptions = {
  page?: number
  pageSize?: number
  search?: string
  academicYearId?: string
  allAcademicYears?: boolean
  talentArea?: string
  advisorName?: string
}

export class StudentRuleError extends Error {
  readonly statusCode = 422
}

export class StudentService {
  constructor(private readonly database: AppDatabase) {}

  async createStudent(actor: AuthenticatedUser, input: { bilsemNo: string; firstName: string; lastName: string; academicYearId: string; talentArea: string; advisorUserId?: string | null }) {
    if (actor.role !== 'ADMIN' || !actor.isActive) throw new AuthorizationError('Öğrenci kaydı oluşturma yetkiniz yok.')
    const bilsemNo = input.bilsemNo.trim()
    if (!/^\d+$/.test(bilsemNo)) throw new StudentRuleError('BİLSEM numarası yalnızca rakamlardan oluşmalıdır.')
    return this.database.transaction(async (tx) => {
      const duplicate = await tx.select({ id: schema.students.id }).from(schema.students).where(eq(schema.students.bilsemNo, bilsemNo)).limit(1)
      if (duplicate[0]) throw new StudentRuleError('Bu BİLSEM numarası başka bir öğrenciye kayıtlı.')
      await this.assertEnrollmentReferences(tx, input.academicYearId, input.advisorUserId)
      const studentId = randomUUID()
      const enrollmentId = randomUUID()
      await tx.insert(schema.students).values({ id: studentId, bilsemNo, firstName: input.firstName.trim(), lastName: input.lastName.trim() })
      await tx.insert(schema.studentEnrollments).values({ id: enrollmentId, studentId, academicYearId: input.academicYearId, talentArea: input.talentArea.trim() || null, advisorUserId: input.advisorUserId ?? null, advisorName: await this.advisorName(tx, input.advisorUserId) })
      await tx.insert(schema.auditLogs).values({ id: randomUUID(), actorUserId: actor.id, action: 'STUDENT_CREATED', entityType: 'STUDENT', entityId: studentId, afterJson: JSON.stringify({ bilsemNo, firstName: input.firstName.trim(), lastName: input.lastName.trim(), enrollmentId, academicYearId: input.academicYearId }) })
      return { studentId, enrollmentId }
    })
  }

  async updateStudent(actor: AuthenticatedUser, studentId: string, input: { bilsemNo: string; firstName: string; lastName: string }) {
    if (actor.role !== 'ADMIN' || !actor.isActive) throw new AuthorizationError('Öğrenci düzenleme yetkiniz yok.')
    const bilsemNo = input.bilsemNo.trim()
    if (!/^\d+$/.test(bilsemNo)) throw new StudentRuleError('BİLSEM numarası yalnızca rakamlardan oluşmalıdır.')
    return this.database.transaction(async (tx) => {
      const rows = await tx.select().from(schema.students).where(and(eq(schema.students.id, studentId), isNull(schema.students.deletedAt))).limit(1)
      const old = rows[0]
      if (!old) throw new ResourceNotFoundError('Öğrenci bulunamadı.')
      const duplicate = await tx.select({ id: schema.students.id }).from(schema.students).where(eq(schema.students.bilsemNo, bilsemNo)).limit(1)
      if (duplicate[0] && duplicate[0].id !== studentId) throw new StudentRuleError('Bu BİLSEM numarası başka bir öğrenciye kayıtlı.')
      const changes = { bilsemNo, firstName: input.firstName.trim(), lastName: input.lastName.trim(), updatedAt: new Date() }
      await tx.update(schema.students).set(changes).where(eq(schema.students.id, studentId))
      await tx.insert(schema.auditLogs).values({ id: randomUUID(), actorUserId: actor.id, action: 'STUDENT_UPDATED', entityType: 'STUDENT', entityId: studentId, beforeJson: JSON.stringify({ bilsemNo: old.bilsemNo, firstName: old.firstName, lastName: old.lastName }), afterJson: JSON.stringify(changes) })
      return { studentId }
    })
  }

  async addEnrollment(actor: AuthenticatedUser, studentId: string, input: { academicYearId: string; talentArea: string; advisorUserId?: string | null }) {
    if (actor.role !== 'ADMIN' || !actor.isActive) throw new AuthorizationError('Öğrenci yıl kaydı ekleme yetkiniz yok.')
    return this.database.transaction(async (tx) => {
      const student = await tx.select({ id: schema.students.id }).from(schema.students).where(and(eq(schema.students.id, studentId), isNull(schema.students.deletedAt))).limit(1)
      if (!student[0]) throw new ResourceNotFoundError('Öğrenci bulunamadı.')
      await this.assertEnrollmentReferences(tx, input.academicYearId, input.advisorUserId)
      const existing = await tx.select({ id: schema.studentEnrollments.id }).from(schema.studentEnrollments).where(and(eq(schema.studentEnrollments.studentId, studentId), eq(schema.studentEnrollments.academicYearId, input.academicYearId), isNull(schema.studentEnrollments.deletedAt))).limit(1)
      if (existing[0]) throw new StudentRuleError('Bu öğrencinin seçilen akademik yılda zaten kaydı var. Düzenlemek için mevcut yıl kaydını kullanın.')
      const enrollmentId = randomUUID()
      await tx.insert(schema.studentEnrollments).values({ id: enrollmentId, studentId, academicYearId: input.academicYearId, talentArea: input.talentArea.trim() || null, advisorUserId: input.advisorUserId ?? null, advisorName: await this.advisorName(tx, input.advisorUserId) })
      await tx.insert(schema.auditLogs).values({ id: randomUUID(), actorUserId: actor.id, action: 'STUDENT_ENROLLMENT_CREATED', entityType: 'STUDENT_ENROLLMENT', entityId: enrollmentId, afterJson: JSON.stringify({ studentId, academicYearId: input.academicYearId, talentArea: input.talentArea, advisorUserId: input.advisorUserId ?? null }) })
      return { enrollmentId }
    })
  }

  async updateEnrollment(actor: AuthenticatedUser, studentId: string, enrollmentId: string, input: { talentArea: string; advisorUserId?: string | null }) {
    if (actor.role !== 'ADMIN' || !actor.isActive) throw new AuthorizationError('Akademik yıl kaydı düzenleme yetkiniz yok.')
    return this.database.transaction(async (tx) => {
      const rows = await tx.select().from(schema.studentEnrollments).where(and(eq(schema.studentEnrollments.id, enrollmentId), eq(schema.studentEnrollments.studentId, studentId), isNull(schema.studentEnrollments.deletedAt))).limit(1)
      const old = rows[0]
      if (!old) throw new ResourceNotFoundError('Akademik yıl kaydı bulunamadı.')
      await this.assertEnrollmentReferences(tx, old.academicYearId, input.advisorUserId)
      const advisorName = await this.advisorName(tx, input.advisorUserId)
      await tx.update(schema.studentEnrollments).set({ talentArea: input.talentArea.trim() || null, advisorUserId: input.advisorUserId ?? null, advisorName, updatedAt: new Date() }).where(eq(schema.studentEnrollments.id, enrollmentId))
      await tx.insert(schema.auditLogs).values({ id: randomUUID(), actorUserId: actor.id, action: 'STUDENT_ENROLLMENT_UPDATED', entityType: 'STUDENT_ENROLLMENT', entityId: enrollmentId, beforeJson: JSON.stringify({ talentArea: old.talentArea, advisorUserId: old.advisorUserId, advisorName: old.advisorName }), afterJson: JSON.stringify({ talentArea: input.talentArea.trim(), advisorUserId: input.advisorUserId ?? null, academicYearId: old.academicYearId }) })
      return { enrollmentId }
    })
  }

  private async assertEnrollmentReferences(tx: Parameters<Parameters<AppDatabase['transaction']>[0]>[0], academicYearId: string, advisorUserId?: string | null) {
    const year = await tx.select({ id: schema.academicYears.id }).from(schema.academicYears).where(and(eq(schema.academicYears.id, academicYearId), isNull(schema.academicYears.deletedAt))).limit(1)
    if (!year[0]) throw new StudentRuleError('Seçilen akademik yıl bulunamadı.')
    if (advisorUserId) {
      const teacher = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, advisorUserId), eq(schema.users.role, 'TEACHER'), eq(schema.users.isActive, true), isNull(schema.users.deletedAt))).limit(1)
      if (!teacher[0]) throw new StudentRuleError('Danışman olarak etkin bir öğretmen seçin.')
    }
  }

  private async advisorName(tx: Parameters<Parameters<AppDatabase['transaction']>[0]>[0], advisorUserId?: string | null) {
    if (!advisorUserId) return null
    const teacher = await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, advisorUserId)).limit(1)
    return teacher[0]?.name ?? null
  }

  async listStudents(user: AuthenticatedUser, options: ListStudentsOptions = {}) {
    if (!canViewStudents(user)) throw new AuthorizationError()

    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20))
    const offset = (page - 1) * pageSize

    let activeYearId = options.academicYearId
    if (!activeYearId && !options.allAcademicYears) {
      const currentYear = await this.database
        .select({ id: schema.academicYears.id })
        .from(schema.academicYears)
        .where(and(eq(schema.academicYears.isCurrent, true), isNull(schema.academicYears.deletedAt)))
        .limit(1)

      activeYearId = currentYear[0]?.id
    }

    const conditions = [
      isNull(schema.students.deletedAt),
      isNull(schema.studentEnrollments.deletedAt),
      eq(schema.studentEnrollments.isActive, true),
    ]

    if (activeYearId) {
      conditions.push(eq(schema.studentEnrollments.academicYearId, activeYearId))
    }

    if (options.talentArea) {
      conditions.push(eq(schema.studentEnrollments.talentArea, options.talentArea))
    }

    if (options.advisorName) {
      conditions.push(like(schema.studentEnrollments.advisorName, `%${options.advisorName.trim()}%`))
    }

    if (options.search?.trim()) {
      const searchConds = buildTurkishSearchConditions(options.search)
      if (searchConds) conditions.push(searchConds)
    }

    const whereClause = and(...conditions)

    const [totalRow] = await this.database
      .select({ total: count() })
      .from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(whereClause)

    const total = totalRow?.total ?? 0
    const totalPages = Math.ceil(total / pageSize)

    const rows = await this.database
      .select({
        enrollmentId: schema.studentEnrollments.id,
        studentId: schema.students.id,
        bilsemNo: schema.students.bilsemNo,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        academicYearId: schema.studentEnrollments.academicYearId,
        schoolName: schema.studentEnrollments.schoolName,
        gradeLevel: schema.studentEnrollments.gradeLevel,
        className: schema.studentEnrollments.className,
        advisorName: schema.studentEnrollments.advisorName,
        advisorUserId: schema.studentEnrollments.advisorUserId,
        talentArea: schema.studentEnrollments.talentArea,
        isActive: schema.studentEnrollments.isActive,
      })
      .from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(whereClause)
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName), asc(schema.students.bilsemNo))
      .limit(pageSize)
      .offset(offset)

    return {
      students: rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    }
  }

  async getStudentProfile(user: AuthenticatedUser, studentId: string) {
    if (!canViewStudents(user)) throw new AuthorizationError()

    const studentRow = await this.database
      .select({
        id: schema.students.id,
        bilsemNo: schema.students.bilsemNo,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        createdAt: schema.students.createdAt,
      })
      .from(schema.students)
      .where(and(eq(schema.students.id, studentId), isNull(schema.students.deletedAt)))
      .limit(1)

    if (!studentRow[0]) throw new ResourceNotFoundError('Öğrenci bulunamadı.')

    // Get all enrollments across academic years for multi-year view
    const enrollments = await this.database
      .select({
        enrollmentId: schema.studentEnrollments.id,
        academicYearId: schema.studentEnrollments.academicYearId,
        academicYearName: schema.academicYears.name,
        isCurrentAcademicYear: schema.academicYears.isCurrent,
        schoolName: schema.studentEnrollments.schoolName,
        gradeLevel: schema.studentEnrollments.gradeLevel,
        className: schema.studentEnrollments.className,
        advisorName: schema.studentEnrollments.advisorName,
        advisorUserId: schema.studentEnrollments.advisorUserId,
        talentArea: schema.studentEnrollments.talentArea,
        isActive: schema.studentEnrollments.isActive,
      })
      .from(schema.studentEnrollments)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.studentEnrollments.academicYearId))
      .where(and(
        eq(schema.studentEnrollments.studentId, studentId),
        isNull(schema.studentEnrollments.deletedAt),
      ))
      .orderBy(desc(schema.academicYears.startsOn))

    return {
      student: studentRow[0],
      enrollments,
    }
  }

  async getProjectHistory(user: AuthenticatedUser, studentId: string) {
    if (!canViewStudents(user)) throw new AuthorizationError()
    const student = await this.database.select({ id: schema.students.id }).from(schema.students)
      .where(and(eq(schema.students.id, studentId), isNull(schema.students.deletedAt))).limit(1)
    if (!student[0]) throw new ResourceNotFoundError('Öğrenci bulunamadı.')
    const projects = await this.database.select({
      projectId: schema.projects.id,
      title: schema.projects.title,
      academicYear: schema.academicYears.name,
      category: schema.projectCategories.name,
      status: schema.projectStatuses.name,
      createdBy: schema.users.name,
      participationType: schema.projects.participationType,
      teamName: schema.projects.teamName,
    }).from(schema.projectStudents)
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectStudents.projectId))
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
      .where(and(
        eq(schema.studentEnrollments.studentId, studentId),
        isNull(schema.projectStudents.deletedAt),
        isNull(schema.projects.deletedAt),
      ))
      .orderBy(desc(schema.academicYears.startsOn), asc(schema.projects.title))
    if (projects.length === 0) return []
    const projectIds = projects.map((project) => project.projectId)
    const advisorRows = await this.database.select({
      projectId: schema.projectAdvisors.projectId,
      userId: schema.users.id,
      name: schema.users.name,
    }).from(schema.projectAdvisors)
      .innerJoin(schema.users, eq(schema.users.id, schema.projectAdvisors.userId))
      .where(and(inArray(schema.projectAdvisors.projectId, projectIds), isNull(schema.projectAdvisors.deletedAt)))
    return projects.map((project) => ({
      ...project,
      advisors: advisorRows.filter((advisor) => advisor.projectId === project.projectId),
    }))
  }
}

export function buildTurkishSearchConditions(searchQuery: string) {
  const term = searchQuery.trim()
  if (!term) return undefined

  const normalizedTerm = term.toLocaleLowerCase('tr-TR')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/i/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')

  const pattern = `%${normalizedTerm}%`

  const firstNameNorm = sql`lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(${schema.students.firstName}, 'Ç', 'c'), 'ç', 'c'), 'Ğ', 'g'), 'ğ', 'g'), 'İ', 'i'), 'I', 'i'), 'ı', 'i'), 'Ö', 'o'), 'ö', 'o'), 'Ş', 's'), 'ş', 's'), 'Ü', 'u'), 'ü', 'u'))`
  const lastNameNorm = sql`lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(${schema.students.lastName}, 'Ç', 'c'), 'ç', 'c'), 'Ğ', 'g'), 'ğ', 'g'), 'İ', 'i'), 'I', 'i'), 'ı', 'i'), 'Ö', 'o'), 'ö', 'o'), 'Ş', 's'), 'ş', 's'), 'Ü', 'u'), 'ü', 'u'))`
  const fullNameNorm = sql`lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(${schema.students.firstName} || ' ' || ${schema.students.lastName}, 'Ç', 'c'), 'ç', 'c'), 'Ğ', 'g'), 'ğ', 'g'), 'İ', 'i'), 'I', 'i'), 'ı', 'i'), 'Ö', 'o'), 'ö', 'o'), 'Ş', 's'), 'ş', 's'), 'Ü', 'u'), 'ü', 'u'))`

  return or(
    like(firstNameNorm, pattern),
    like(lastNameNorm, pattern),
    like(schema.students.bilsemNo, pattern),
    like(fullNameNorm, pattern),
  )
}
