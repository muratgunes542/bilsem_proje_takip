import { and, count, desc, eq, isNull, like, or } from 'drizzle-orm'
import { AuthorizationError, canViewStudents, ResourceNotFoundError, type AuthenticatedUser } from '../authorization'
import * as schema from '../db/schema'
import type { AppDatabase } from './project-service'

export type ListStudentsOptions = {
  page?: number
  pageSize?: number
  search?: string
  academicYearId?: string
  talentArea?: string
  advisorName?: string
}

export class StudentService {
  constructor(private readonly database: AppDatabase) {}

  async listStudents(user: AuthenticatedUser, options: ListStudentsOptions = {}) {
    if (!canViewStudents(user)) throw new AuthorizationError()

    const page = Math.max(1, options.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20))
    const offset = (page - 1) * pageSize

    let activeYearId = options.academicYearId
    if (!activeYearId) {
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
      const term = `%${options.search.trim()}%`
      conditions.push(or(
        like(schema.students.firstName, term),
        like(schema.students.lastName, term),
        like(schema.students.bilsemNo, term),
      )!)
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
        talentArea: schema.studentEnrollments.talentArea,
        isActive: schema.studentEnrollments.isActive,
      })
      .from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(whereClause)
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
        schoolName: schema.studentEnrollments.schoolName,
        gradeLevel: schema.studentEnrollments.gradeLevel,
        className: schema.studentEnrollments.className,
        advisorName: schema.studentEnrollments.advisorName,
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
    return this.database.select({
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
  }
}
