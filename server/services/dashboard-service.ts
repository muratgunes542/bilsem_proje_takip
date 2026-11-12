import { and, count, countDistinct, desc, eq, isNull } from 'drizzle-orm'
import { AuthorizationError, type AuthenticatedUser } from '../authorization.js'
import * as schema from '../db/schema.js'
import type { AppDatabase } from './project-service.js'

export class DashboardService {
  constructor(private readonly database: AppDatabase) {}

  async getSummary(actor: AuthenticatedUser) {
    if (!actor?.isActive || !['ADMIN', 'TEACHER'].includes(actor.role)) throw new AuthorizationError()

    const [currentYear] = await this.database.select({
      id: schema.academicYears.id,
      name: schema.academicYears.name,
      startsOn: schema.academicYears.startsOn,
      endsOn: schema.academicYears.endsOn,
    }).from(schema.academicYears)
      .where(and(eq(schema.academicYears.isCurrent, true), isNull(schema.academicYears.deletedAt)))
      .limit(1)

    const [studentsRow] = currentYear
      ? await this.database.select({ total: countDistinct(schema.studentEnrollments.studentId) })
        .from(schema.studentEnrollments)
        .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
        .where(and(
          eq(schema.studentEnrollments.academicYearId, currentYear.id),
          eq(schema.studentEnrollments.isActive, true),
          isNull(schema.studentEnrollments.deletedAt),
          isNull(schema.students.deletedAt),
        ))
      : [{ total: 0 }]

    const [teachersRow] = await this.database.select({ total: count() }).from(schema.users)
      .where(and(eq(schema.users.role, 'TEACHER'), eq(schema.users.isActive, true), isNull(schema.users.deletedAt)))
    const [projectsRow] = await this.database.select({ total: count() }).from(schema.projects)
      .where(isNull(schema.projects.deletedAt))
    const [unreadRow] = await this.database.select({ total: count() }).from(schema.notifications)
      .where(and(eq(schema.notifications.recipientId, actor.id), eq(schema.notifications.isRead, false)))

    const categoryDistribution = await this.database.select({
      categoryId: schema.projectCategories.id,
      categoryName: schema.projectCategories.name,
      total: count(schema.projects.id),
    }).from(schema.projectCategories)
      .leftJoin(schema.projects, and(
        eq(schema.projects.categoryId, schema.projectCategories.id),
        isNull(schema.projects.deletedAt),
      ))
      .where(and(isNull(schema.projectCategories.deletedAt), eq(schema.projectCategories.isActive, true)))
      .groupBy(schema.projectCategories.id, schema.projectCategories.name)
      .orderBy(desc(count(schema.projects.id)))

    const recentProjects = await this.database.select({
      id: schema.projects.id,
      title: schema.projects.title,
      academicYearName: schema.academicYears.name,
      categoryName: schema.projectCategories.name,
      statusName: schema.projectStatuses.name,
      creatorName: schema.users.name,
      createdAt: schema.projects.createdAt,
    }).from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
      .where(isNull(schema.projects.deletedAt))
      .orderBy(desc(schema.projects.createdAt))
      .limit(5)

    return {
      activeStudentCount: studentsRow?.total ?? 0,
      activeTeacherCount: teachersRow?.total ?? 0,
      activeProjectCount: projectsRow?.total ?? 0,
      unreadNotificationCount: unreadRow?.total ?? 0,
      currentAcademicYear: currentYear ?? null,
      categoryDistribution,
      recentProjects,
    }
  }
}
