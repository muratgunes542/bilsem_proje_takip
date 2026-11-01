import { and, eq, isNull } from 'drizzle-orm'
import { AuthorizationError, canViewStudents, type AuthenticatedUser } from '../authorization'
import * as schema from '../db/schema'
import type { AppDatabase } from './project-service'

export class StudentService {
  constructor(private readonly database: AppDatabase) {}

  async getProjectHistory(user: AuthenticatedUser, studentId: string) {
    if (!canViewStudents(user)) throw new AuthorizationError()
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
