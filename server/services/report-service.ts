import { and, count, countDistinct, desc, eq, inArray, isNull, like, notInArray, or, sql } from 'drizzle-orm'
import { AuthorizationError, type AuthenticatedUser } from '../authorization.js'
import * as schema from '../db/schema.js'
import { ProjectService, type AppDatabase } from './project-service.js'

type ReportFilters = { academicYearId?: string; includeArchived?: boolean }
type PageFilters = ReportFilters & { page?: number; pageSize?: number; search?: string; talentArea?: string; advisorUserId?: string; classAdvisorUserId?: string; classAdvisorName?: string; advisorName?: string; withoutProjects?: boolean; categoryId?: string; statusId?: string; participationType?: 'INDIVIDUAL' | 'TEAM'; studentId?: string }

export class ReportService {
  constructor(private readonly database: AppDatabase) {}

  private authorize(actor: AuthenticatedUser) {
    if (!actor?.isActive || !['ADMIN', 'TEACHER'].includes(actor.role)) throw new AuthorizationError()
  }

  private projectConditions(actor: AuthenticatedUser, filters: ReportFilters) {
    const conditions = []
    if (actor.role !== 'ADMIN' || !filters.includeArchived) conditions.push(isNull(schema.projects.deletedAt))
    if (filters.academicYearId) conditions.push(eq(schema.projects.academicYearId, filters.academicYearId))
    return conditions
  }

  async getOverview(actor: AuthenticatedUser, filters: ReportFilters) {
    this.authorize(actor)
    const projectConditions = this.projectConditions(actor, filters)
    const enrollmentConditions = [eq(schema.studentEnrollments.isActive, true), isNull(schema.studentEnrollments.deletedAt), isNull(schema.students.deletedAt)]
    if (filters.academicYearId) enrollmentConditions.push(eq(schema.studentEnrollments.academicYearId, filters.academicYearId))

    const [totalStudents] = await this.database.select({ total: countDistinct(schema.students.id) }).from(schema.students).where(isNull(schema.students.deletedAt))
    const [activeStudents] = await this.database.select({ total: countDistinct(schema.students.id) }).from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId)).where(and(...enrollmentConditions))
    const [projects] = await this.database.select({ total: countDistinct(schema.projects.id) }).from(schema.projects).where(projectConditions.length ? and(...projectConditions) : undefined)
    const [participants] = await this.database.select({ total: countDistinct(schema.studentEnrollments.studentId) }).from(schema.projectStudents)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectStudents.projectId))
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(and(...projectConditions, isNull(schema.projectStudents.deletedAt), eq(schema.studentEnrollments.isActive, true), isNull(schema.studentEnrollments.deletedAt), isNull(schema.students.deletedAt)))

    const participantIds = this.database.selectDistinct({ studentId: schema.studentEnrollments.studentId }).from(schema.projectStudents)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectStudents.projectId))
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .where(and(...projectConditions, isNull(schema.projectStudents.deletedAt), eq(schema.studentEnrollments.isActive, true), isNull(schema.studentEnrollments.deletedAt)))

    const nonParticipants = await this.database.select({ total: countDistinct(schema.students.id) }).from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(and(...enrollmentConditions, notInArray(schema.studentEnrollments.studentId, participantIds)))

    const [creators] = await this.database.select({ total: countDistinct(schema.projects.createdBy) }).from(schema.projects)
      .where(projectConditions.length ? and(...projectConditions) : undefined)
    const [activeTeachers] = await this.database.select({ total: count() }).from(schema.users)
      .where(and(eq(schema.users.role, 'TEACHER' as const), eq(schema.users.isActive, true), isNull(schema.users.deletedAt)))

    const categoryDistribution = await this.database.select({ categoryId: schema.projectCategories.id, categoryName: schema.projectCategories.name, total: countDistinct(schema.projects.id) })
      .from(schema.projects).innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .where(projectConditions.length ? and(...projectConditions) : undefined)
      .groupBy(schema.projectCategories.id, schema.projectCategories.name)

    const participationDistribution = await this.database.select({ participationType: schema.projects.participationType, total: countDistinct(schema.projects.id) })
      .from(schema.projects).where(projectConditions.length ? and(...projectConditions) : undefined)
      .groupBy(schema.projects.participationType)

    const statusDistribution = await this.database.select({ statusId: schema.projectStatuses.id, statusName: schema.projectStatuses.name, total: countDistinct(schema.projects.id) })
      .from(schema.projects).innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .where(projectConditions.length ? and(...projectConditions) : undefined)
      .groupBy(schema.projectStatuses.id, schema.projectStatuses.name)

    const yearStudents = await this.database.select({ id: schema.academicYears.id, name: schema.academicYears.name, total: countDistinct(schema.studentEnrollments.studentId) })
      .from(schema.studentEnrollments).innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.studentEnrollments.academicYearId))
      .where(and(eq(schema.studentEnrollments.isActive, true), isNull(schema.studentEnrollments.deletedAt), isNull(schema.students.deletedAt), isNull(schema.academicYears.deletedAt)))
      .groupBy(schema.academicYears.id, schema.academicYears.name).orderBy(schema.academicYears.startsOn)

    const projectsByYearRows = await this.database.select({ academicYearId: schema.projects.academicYearId, total: countDistinct(schema.projects.id), creators: countDistinct(schema.projects.createdBy) })
      .from(schema.projects).where(actor.role !== 'ADMIN' || !filters.includeArchived ? isNull(schema.projects.deletedAt) : undefined)
      .groupBy(schema.projects.academicYearId)
    const projectsByYear = new Map(projectsByYearRows.map((r) => [r.academicYearId, r]))

    const participantByYearRows = await this.database.select({ academicYearId: schema.projects.academicYearId, total: countDistinct(schema.studentEnrollments.studentId) })
      .from(schema.projectStudents).innerJoin(schema.projects, eq(schema.projects.id, schema.projectStudents.projectId))
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .where(and(actor.role !== 'ADMIN' || !filters.includeArchived ? isNull(schema.projects.deletedAt) : undefined, isNull(schema.projectStudents.deletedAt), eq(schema.studentEnrollments.isActive, true)))
      .groupBy(schema.projects.academicYearId)
    const participantByYear = new Map(participantByYearRows.map((r) => [r.academicYearId, r.total]))

    return {
      academicYearId: filters.academicYearId ?? null,
      totalStudentCount: totalStudents?.total ?? 0,
      activeStudentCount: activeStudents?.total ?? 0,
      projectCount: projects?.total ?? 0,
      participatingStudentCount: participants?.total ?? 0,
      nonParticipatingStudentCount: nonParticipants[0]?.total ?? 0,
      projectCreatorCount: creators?.total ?? 0,
      activeTeacherCount: activeTeachers?.total ?? 0,
      categoryDistribution,
      participationDistribution,
      statusDistribution,
      yearComparisons: yearStudents.map((row) => {
        const p = projectsByYear.get(row.id)
        const participantCount = participantByYear.get(row.id) ?? 0
        return { academicYearId: row.id, academicYearName: row.name, activeStudentCount: row.total, projectCount: p?.total ?? 0, participatingStudentCount: participantCount, projectCreatorCount: p?.creators ?? 0, participationRate: row.total ? Math.round((participantCount / row.total) * 1000) / 10 : 0 }
      }),
    }
  }

  async listStudents(actor: AuthenticatedUser, filters: PageFilters) {
    this.authorize(actor)
    const where: Array<ReturnType<typeof eq> | ReturnType<typeof like>> = [eq(schema.studentEnrollments.isActive, true), isNull(schema.studentEnrollments.deletedAt), isNull(schema.students.deletedAt)]
    if (filters.academicYearId) where.push(eq(schema.studentEnrollments.academicYearId, filters.academicYearId))
    if (filters.talentArea) where.push(like(schema.studentEnrollments.talentArea, `%${filters.talentArea.trim()}%`))
    if (filters.classAdvisorUserId) where.push(eq(schema.studentEnrollments.advisorUserId, filters.classAdvisorUserId))
    if (filters.classAdvisorName) where.push(like(schema.studentEnrollments.advisorName, `%${filters.classAdvisorName.trim()}%`))
    if (filters.search?.trim()) {
      const term = `%${filters.search.trim()}%`
      where.push(or(like(schema.students.firstName, term), like(schema.students.lastName, term), like(schema.students.bilsemNo, term), sql`(${schema.students.firstName} || ' ' || ${schema.students.lastName}) like ${term}`)!)
    }
    const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 20
    const participationConditions = [eq(schema.projectStudents.enrollmentId, schema.studentEnrollments.id), isNull(schema.projectStudents.deletedAt)]
    const projectsConditions = [eq(schema.projects.id, schema.projectStudents.projectId), isNull(schema.projects.deletedAt)]
    if (filters.includeArchived && actor.role === 'ADMIN') projectsConditions.splice(1, 1)
    if (filters.categoryId) {
      projectsConditions.push(eq(schema.projects.categoryId, filters.categoryId))
    }
    if (filters.advisorUserId) {
      const explicitAdvisorRows = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(and(
          eq(schema.projectAdvisors.userId, filters.advisorUserId),
          isNull(schema.projectAdvisors.deletedAt)
        ))
      const enrollmentAdvisorProjects = await this.database
        .select({ projectId: schema.projectStudents.projectId })
        .from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .where(and(
          eq(schema.studentEnrollments.advisorUserId, filters.advisorUserId),
          eq(schema.studentEnrollments.isActive, true),
          isNull(schema.projectStudents.deletedAt),
          isNull(schema.studentEnrollments.deletedAt)
        ))
      const anyUserAdvisorRows = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(eq(schema.projectAdvisors.userId, filters.advisorUserId))
      const excludedProjectIds = new Set(anyUserAdvisorRows.map((r) => r.projectId))
      const validEnrollmentProjectIds = enrollmentAdvisorProjects
        .map((r) => r.projectId)
        .filter((pid) => !excludedProjectIds.has(pid))
      const advisedProjectIds = [...new Set([
        ...explicitAdvisorRows.map((r) => r.projectId),
        ...validEnrollmentProjectIds,
      ])]
      if (advisedProjectIds.length === 0) {
        return { students: [], total: 0 }
      }
      projectsConditions.push(inArray(schema.projects.id, advisedProjectIds))
    }

    const hasProjectFilter = Boolean(filters.categoryId || filters.advisorUserId)

    const noProjectEnrollments = this.database.select({ id: schema.studentEnrollments.id })
      .from(schema.studentEnrollments).innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.studentEnrollments.academicYearId))
      .leftJoin(schema.projectStudents, and(...participationConditions)).leftJoin(schema.projects, and(eq(schema.projects.id, schema.projectStudents.projectId), isNull(schema.projects.deletedAt)))
      .where(and(...where)).groupBy(schema.studentEnrollments.id).having(sql`count(distinct ${schema.projects.id}) = 0`)

    const countQueryBase = this.database.select({ total: countDistinct(schema.studentEnrollments.id) }).from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.studentEnrollments.academicYearId))

    const countQuery = hasProjectFilter
      ? countQueryBase
          .innerJoin(schema.projectStudents, and(...participationConditions))
          .innerJoin(schema.projects, eq(schema.projects.id, schema.projectStudents.projectId))
          .where(and(...where, ...projectsConditions))
      : countQueryBase.where(filters.withoutProjects ? and(...where, inArray(schema.studentEnrollments.id, noProjectEnrollments)) : and(...where))

    const [totalRow] = await countQuery

    const baseQuery = this.database.select({
      enrollmentId: schema.studentEnrollments.id,
      studentId: schema.students.id,
      bilsemNo: schema.students.bilsemNo,
      firstName: schema.students.firstName,
      lastName: schema.students.lastName,
      academicYearId: schema.academicYears.id,
      academicYearName: schema.academicYears.name,
      talentArea: schema.studentEnrollments.talentArea,
      advisorUserId: schema.studentEnrollments.advisorUserId,
      advisorName: sql<string>`coalesce(${schema.users.name}, ${schema.studentEnrollments.advisorName}, 'Bilinmeyen Danışman')`,
      projectCount: countDistinct(schema.projects.id),
      individualProjectCount: sql<number>`count(distinct case when ${schema.projects.participationType} = 'INDIVIDUAL' then ${schema.projects.id} end)`,
      teamProjectCount: sql<number>`count(distinct case when ${schema.projects.participationType} = 'TEAM' then ${schema.projects.id} end)`,
    })
      .from(schema.studentEnrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.studentEnrollments.academicYearId))
      .leftJoin(schema.users, eq(schema.users.id, schema.studentEnrollments.advisorUserId))

    const query = hasProjectFilter
      ? baseQuery
          .innerJoin(schema.projectStudents, and(...participationConditions))
          .innerJoin(schema.projects, eq(schema.projects.id, schema.projectStudents.projectId))
          .where(and(...where, ...projectsConditions))
          .groupBy(schema.studentEnrollments.id, schema.students.id, schema.academicYears.id, schema.users.name, schema.studentEnrollments.advisorName)
      : baseQuery
          .leftJoin(schema.projectStudents, and(...participationConditions))
          .leftJoin(schema.projects, and(eq(schema.projects.id, schema.projectStudents.projectId), isNull(schema.projects.deletedAt)))
          .where(and(...where))
          .groupBy(schema.studentEnrollments.id, schema.students.id, schema.academicYears.id, schema.users.name, schema.studentEnrollments.advisorName)

    const rows = await query.orderBy(schema.students.lastName, schema.students.firstName).limit(pageSize).offset((page - 1) * pageSize)
    const resultRows = filters.withoutProjects && !hasProjectFilter ? await query.having(sql`count(distinct ${schema.projects.id}) = 0`).orderBy(schema.students.lastName, schema.students.firstName).limit(pageSize).offset((page - 1) * pageSize) : rows
    return { students: resultRows, total: totalRow?.total ?? 0 }
  }

  async listTeachers(actor: AuthenticatedUser, filters: PageFilters) {
    this.authorize(actor)
    const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 20
    const where = [eq(schema.users.role, 'TEACHER' as const), isNull(schema.users.deletedAt)]
    if (filters.search?.trim()) { const term = `%${filters.search.trim()}%`; where.push(or(like(schema.users.name, term), like(schema.users.email, term))!) }
    const [totalRow] = await this.database.select({ total: count() }).from(schema.users).where(and(...where))
    const teachers = await this.database.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, isActive: schema.users.isActive }).from(schema.users)
      .where(and(...where)).orderBy(schema.users.name).limit(pageSize).offset((page - 1) * pageSize)
    if (!teachers.length) return { teachers: [], total: totalRow?.total ?? 0 }

    const teacherIds = teachers.map((t) => t.id)
    const projectConditionsList = this.projectConditions(actor, filters)
    const allProjectsForReport = await this.database.select({
      id: schema.projects.id,
      academicYearName: schema.academicYears.name,
      categoryName: schema.projectCategories.name,
      participationType: schema.projects.participationType,
      createdBy: schema.projects.createdBy,
    }).from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .where(projectConditionsList.length ? and(...projectConditionsList) : undefined)

    const allProjectIds = allProjectsForReport.map((p) => p.id)
    const projectService = new ProjectService(this.database)
    const advisorsMap = allProjectIds.length > 0 ? (await projectService.resolveProjectAdvisors(this.database, allProjectIds)) as Map<string, Array<{ userId: string; name: string; source?: string }>> : new Map()

    const allProjectStudents = allProjectIds.length > 0 ? await this.database.select({ projectId: schema.projectStudents.projectId, studentId: schema.studentEnrollments.studentId })
      .from(schema.projectStudents)
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(and(
        inArray(schema.projectStudents.projectId, allProjectIds),
        isNull(schema.projectStudents.deletedAt),
        eq(schema.studentEnrollments.isActive, true),
        isNull(schema.studentEnrollments.deletedAt),
        isNull(schema.students.deletedAt),
      )) : []

    const projectStudentsMap = new Map<string, Set<string>>()
    for (const s of allProjectStudents) {
      if (!projectStudentsMap.has(s.projectId)) {
        projectStudentsMap.set(s.projectId, new Set())
      }
      projectStudentsMap.get(s.projectId)!.add(s.studentId)
    }

    const teacherAdvisedProjectsMap = new Map<string, Set<string>>()
    const teacherAdvisedStudentsMap = new Map<string, Set<string>>()
    const teacherAdvisedCategoriesMap = new Map<string, Map<string, number>>()
    const teacherAdvisedTypesMap = new Map<string, Map<string, number>>()
    const teacherAdvisedYearsMap = new Map<string, Map<string, number>>()

    for (const p of allProjectsForReport) {
      const advs = (advisorsMap.get(p.id) ?? []) as Array<{ userId: string; name: string; source?: string }>
      const uniqueTeacherIdsInProj = new Set(advs.map((a: any) => a.userId).filter(Boolean))
      const studentsInProj = projectStudentsMap.get(p.id) ?? new Set<string>()

      for (const tId of uniqueTeacherIdsInProj) {
        if (!teacherAdvisedProjectsMap.has(tId)) teacherAdvisedProjectsMap.set(tId, new Set())
        teacherAdvisedProjectsMap.get(tId)!.add(p.id)

        if (!teacherAdvisedCategoriesMap.has(tId)) teacherAdvisedCategoriesMap.set(tId, new Map())
        const catMap = teacherAdvisedCategoriesMap.get(tId)!
        catMap.set(p.categoryName, (catMap.get(p.categoryName) ?? 0) + 1)

        if (!teacherAdvisedTypesMap.has(tId)) teacherAdvisedTypesMap.set(tId, new Map())
        const typeMap = teacherAdvisedTypesMap.get(tId)!
        typeMap.set(p.participationType, (typeMap.get(p.participationType) ?? 0) + 1)

        if (!teacherAdvisedYearsMap.has(tId)) teacherAdvisedYearsMap.set(tId, new Map())
        const yearMap = teacherAdvisedYearsMap.get(tId)!
        yearMap.set(p.academicYearName, (yearMap.get(p.academicYearName) ?? 0) + 1)

        if (!teacherAdvisedStudentsMap.has(tId)) teacherAdvisedStudentsMap.set(tId, new Set())
        for (const stuId of studentsInProj) {
          teacherAdvisedStudentsMap.get(tId)!.add(stuId)
        }
      }
    }

    const projectWhere = [inArray(schema.projects.createdBy, teacherIds), ...this.projectConditions(actor, filters)]
    const created = await this.database.select({ userId: schema.projects.createdBy, projectCount: countDistinct(schema.projects.id) }).from(schema.projects)
      .where(and(...projectWhere)).groupBy(schema.projects.createdBy)
    const createdCategories = await this.database.select({ userId: schema.projects.createdBy, categoryName: schema.projectCategories.name, total: countDistinct(schema.projects.id) })
      .from(schema.projects).innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .where(and(...projectWhere)).groupBy(schema.projects.createdBy, schema.projectCategories.name)
    const createdTypes = await this.database.select({ userId: schema.projects.createdBy, participationType: schema.projects.participationType, total: countDistinct(schema.projects.id) }).from(schema.projects).where(and(...projectWhere)).groupBy(schema.projects.createdBy, schema.projects.participationType)
    const createdYears = await this.database.select({ userId: schema.projects.createdBy, yearName: schema.academicYears.name, total: countDistinct(schema.projects.id) }).from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId)).where(and(...projectWhere)).groupBy(schema.projects.createdBy, schema.academicYears.name)

    return { teachers: teachers.map((teacher) => {
      const advisedProjSet = teacherAdvisedProjectsMap.get(teacher.id) ?? new Set()
      const advisedStuSet = teacherAdvisedStudentsMap.get(teacher.id) ?? new Set()
      const catMap = teacherAdvisedCategoriesMap.get(teacher.id) ?? new Map()
      const typeMap = teacherAdvisedTypesMap.get(teacher.id) ?? new Map()
      const yearMap = teacherAdvisedYearsMap.get(teacher.id) ?? new Map()

      return {
        ...teacher,
        createdProjectCount: created.find((x) => x.userId === teacher.id)?.projectCount ?? 0,
        advisedProjectCount: advisedProjSet.size,
        advisedStudentCount: advisedStuSet.size,
        createdCategories: createdCategories.filter((x) => x.userId === teacher.id).map(({ categoryName, total }) => ({ categoryName, total })),
        advisedCategories: [...catMap.entries()].map(([categoryName, total]) => ({ categoryName, total })),
        createdTypes: createdTypes.filter((x) => x.userId === teacher.id).map(({ participationType, total }) => ({ participationType, total })),
        advisedTypes: [...typeMap.entries()].map(([participationType, total]) => ({ participationType, total })),
        createdYears: createdYears.filter((x) => x.userId === teacher.id).map(({ yearName, total }) => ({ yearName, total })),
        advisedYears: [...yearMap.entries()].map(([yearName, total]) => ({ yearName, total })),
      }
    }), total: totalRow?.total ?? 0 }
  }

  async listTeacherProjects(actor: AuthenticatedUser, teacherId: string, type: 'created' | 'advised', filters: PageFilters) {
    this.authorize(actor)
    const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 20
    const conditions = [...this.projectConditions(actor, filters)]
    if (type === 'created') {
      conditions.push(eq(schema.projects.createdBy, teacherId))
    } else {
      const allProjects = await this.database.select({ id: schema.projects.id }).from(schema.projects).where(and(...conditions))
      const allProjectIds = allProjects.map((p) => p.id)
      const projectService = new ProjectService(this.database)
      const advisorsMap = allProjectIds.length > 0 ? (await projectService.resolveProjectAdvisors(this.database, allProjectIds)) as Map<string, Array<{ userId: string; name: string; source?: string }>> : new Map()
      const advisedProjectIds: string[] = []
      for (const [pid, advs] of advisorsMap.entries()) {
        if (advs.some((a: any) => a.userId === teacherId)) {
          advisedProjectIds.push(pid)
        }
      }
      if (advisedProjectIds.length === 0) return { projects: [], total: 0 }
      conditions.push(inArray(schema.projects.id, advisedProjectIds))
    }
    const [totalRow] = await this.database.select({ total: countDistinct(schema.projects.id) }).from(schema.projects).where(and(...conditions))
    const projects = await this.database.select({
      id: schema.projects.id,
      title: schema.projects.title,
      academicYearName: schema.academicYears.name,
      categoryName: schema.projectCategories.name,
      statusName: schema.projectStatuses.name,
      participationType: schema.projects.participationType,
    }).from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .where(and(...conditions))
      .orderBy(desc(schema.projects.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return { projects, total: totalRow?.total ?? 0 }
  }

  async listProjects(actor: AuthenticatedUser, filters: PageFilters) {
    this.authorize(actor)
    const where = this.projectConditions(actor, filters)
    if (filters.categoryId) where.push(eq(schema.projects.categoryId, filters.categoryId))
    if (filters.statusId) where.push(eq(schema.projects.statusId, filters.statusId))
    if (filters.participationType) where.push(eq(schema.projects.participationType, filters.participationType))
    if (filters.search?.trim()) where.push(like(schema.projects.title, `%${filters.search.trim()}%`))
    if (filters.advisorUserId) {
      const explicitAdvisorRows = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(and(
          eq(schema.projectAdvisors.userId, filters.advisorUserId),
          isNull(schema.projectAdvisors.deletedAt)
        ))
      const enrollmentAdvisorProjects = await this.database
        .select({ projectId: schema.projectStudents.projectId })
        .from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .where(and(
          eq(schema.studentEnrollments.advisorUserId, filters.advisorUserId),
          eq(schema.studentEnrollments.isActive, true),
          isNull(schema.projectStudents.deletedAt),
          isNull(schema.studentEnrollments.deletedAt)
        ))
      const anyUserAdvisorRows = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(eq(schema.projectAdvisors.userId, filters.advisorUserId))
      const excludedProjectIds = new Set(anyUserAdvisorRows.map((r) => r.projectId))
      const validEnrollmentProjectIds = enrollmentAdvisorProjects
        .map((r) => r.projectId)
        .filter((pid) => !excludedProjectIds.has(pid))
      const advisedProjectIds = [...new Set([
        ...explicitAdvisorRows.map((r) => r.projectId),
        ...validEnrollmentProjectIds,
      ])]
      if (advisedProjectIds.length === 0) return { projects: [], total: 0 }
      where.push(inArray(schema.projects.id, advisedProjectIds))
    }
    if (filters.studentId) {
      const studentProjectIds = this.database.select({ projectId: schema.projectStudents.projectId }).from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .where(and(eq(schema.studentEnrollments.studentId, filters.studentId), isNull(schema.projectStudents.deletedAt)))
      where.push(inArray(schema.projects.id, studentProjectIds))
    }
    const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 20
    const [totalRow] = await this.database.select({ total: countDistinct(schema.projects.id) }).from(schema.projects).where(where.length ? and(...where) : undefined)
    const rows = await this.database.select({
      id: schema.projects.id,
      title: schema.projects.title,
      academicYearId: schema.projects.academicYearId,
      academicYearName: schema.academicYears.name,
      categoryId: schema.projects.categoryId,
      categoryName: schema.projectCategories.name,
      statusId: schema.projects.statusId,
      statusName: schema.projectStatuses.name,
      participationType: schema.projects.participationType,
      teamName: schema.projects.teamName,
      createdBy: schema.projects.createdBy,
      creatorName: schema.users.name,
      createdAt: schema.projects.createdAt,
      studentCount: countDistinct(schema.projectStudents.enrollmentId),
    }).from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
      .leftJoin(schema.projectStudents, and(eq(schema.projectStudents.projectId, schema.projects.id), isNull(schema.projectStudents.deletedAt)))
      .where(where.length ? and(...where) : undefined)
      .groupBy(schema.projects.id, schema.academicYears.name, schema.projectCategories.name, schema.projectStatuses.name, schema.users.name)
      .orderBy(desc(schema.projects.createdAt)).limit(pageSize).offset((page - 1) * pageSize)

    const projectIds = rows.map((r) => r.id)
    const projectService = new ProjectService(this.database)
    const advisorsMap = projectIds.length > 0 ? await projectService.resolveProjectAdvisors(this.database, projectIds) : new Map()

    const projects = rows.map((r) => {
      const projectAdvisors = advisorsMap.get(r.id) ?? []
      const names = new Set<string>()
      for (const adv of projectAdvisors) {
        if (adv.name) {
          names.add(adv.name)
        }
      }
      return {
        ...r,
        advisors: [...names],
      }
    })

    return { projects, total: totalRow?.total ?? 0 }
  }
}
