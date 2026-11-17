import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, like, ne, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { assertCanCreateProject, assertCanModifyProject, canArchiveProject, canRestoreProject, type AuthenticatedUser, AuthorizationError, ResourceNotFoundError } from '../authorization.js'
import * as schema from '../db/schema.js'

export type AppDatabase = LibSQLDatabase<typeof schema>

export type ProjectConflict = {
  studentId: string
  bilsemNo: string
  projectId: string
  title: string
  status: string
  ownerId: string
  ownerName: string
}

export type CreateProjectInput = {
  title: string
  description?: string | null
  academicYearId: string
  categoryId: string
  statusId: string
  projectType?: schema.ProjectType
  participationType: schema.ParticipationType
  teamName?: string | null
  enrollmentIds?: string[]
  advisorUserIds?: string[]
}

export type ListProjectsFilters = {
  academicYearId?: string
  categoryId?: string
  statusId?: string
  projectType?: schema.ProjectType
  studentId?: string
  advisorUserId?: string
  includeArchived?: boolean
  search?: string
}

export type UpdateProjectAdvisorsInput = {
  addUserIds?: string[]
  removeUserIds?: string[]
}

export class ProjectRuleError extends Error {
  readonly statusCode = 422

  constructor(message: string) {
    super(message)
    this.name = 'ProjectRuleError'
  }
}

export class ProjectService {
  constructor(private readonly database: AppDatabase) {}

  async listProjectOptions(actor: AuthenticatedUser) {
    if (!actor?.isActive || !['ADMIN', 'TEACHER'].includes(actor.role)) throw new AuthorizationError()
    const [categories, statuses, teacherRows] = await Promise.all([
      this.database.select({
        id: schema.projectCategories.id,
        code: schema.projectCategories.code,
        name: schema.projectCategories.name,
        duplicateCheckEnabled: schema.projectCategories.duplicateCheckEnabled,
      }).from(schema.projectCategories)
        .where(and(eq(schema.projectCategories.isActive, true), isNull(schema.projectCategories.deletedAt)))
        .orderBy(schema.projectCategories.name),
      this.database.select({
        id: schema.projectStatuses.id,
        code: schema.projectStatuses.code,
        name: schema.projectStatuses.name,
        isTerminal: schema.projectStatuses.isTerminal,
      }).from(schema.projectStatuses)
        .where(isNull(schema.projectStatuses.deletedAt))
        .orderBy(schema.projectStatuses.sortOrder),
      this.database.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
        .where(and(eq(schema.users.role, 'TEACHER'), eq(schema.users.isActive, true), isNull(schema.users.deletedAt)))
        .orderBy(schema.users.name),
    ])

    let teachers = teacherRows
    if (actor.role === 'ADMIN' && !teachers.some((t) => t.id === actor.id)) {
      const adminUser = await this.database.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
        .where(and(eq(schema.users.id, actor.id), eq(schema.users.isActive, true), isNull(schema.users.deletedAt)))
        .limit(1)
      if (adminUser[0]) {
        teachers = [...teachers, { id: adminUser[0].id, name: `${adminUser[0].name} (Yönetici)` }].sort((a, b) => a.name.localeCompare(b.name, 'tr-TR'))
      }
    }

    return { categories, statuses, teachers }
  }

  async listProjects(actor: AuthenticatedUser, filters: ListProjectsFilters = {}) {
    if (!actor || !actor.isActive) throw new AuthorizationError()
    if (actor.role !== 'ADMIN' && actor.role !== 'TEACHER') throw new AuthorizationError()

    const conditions = []

    if (actor.role !== 'ADMIN' || !filters.includeArchived) {
      conditions.push(isNull(schema.projects.deletedAt))
    }

    if (filters.academicYearId) {
      conditions.push(eq(schema.projects.academicYearId, filters.academicYearId))
    }

    if (filters.categoryId) {
      conditions.push(eq(schema.projects.categoryId, filters.categoryId))
    }

    if (filters.statusId) {
      conditions.push(eq(schema.projects.statusId, filters.statusId))
    }

    if (filters.projectType) {
      conditions.push(eq(schema.projects.projectType, filters.projectType))
    }

    if (filters.search?.trim()) conditions.push(like(schema.projects.title, `%${filters.search.trim()}%`))

    if (filters.studentId) {
      const studentProjectRows = await this.database
        .select({ projectId: schema.projectStudents.projectId })
        .from(schema.projectStudents)
        .innerJoin(
          schema.studentEnrollments,
          eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId)
        )
        .where(and(
          eq(schema.studentEnrollments.studentId, filters.studentId),
          isNull(schema.projectStudents.deletedAt)
        ))

      const projectIds = studentProjectRows.map((r) => r.projectId)
      if (projectIds.length === 0) return []
      conditions.push(inArray(schema.projects.id, projectIds))
    }

    if (filters.advisorUserId) {
      // 1. Projects where user is an active explicit advisor
      const explicitAdvisorRows = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(and(
          eq(schema.projectAdvisors.userId, filters.advisorUserId),
          isNull(schema.projectAdvisors.deletedAt)
        ))

      // 2. Projects where user is an active enrollment advisor and project has ZERO project_advisors rows at all
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

      const projectsWithAnyAdvisors = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)

      const excludedProjectIds = new Set(projectsWithAnyAdvisors.map((r) => r.projectId))
      const validEnrollmentProjectIds = enrollmentAdvisorProjects
        .map((r) => r.projectId)
        .filter((pid) => !excludedProjectIds.has(pid))

      const projectIds = [...new Set([
        ...explicitAdvisorRows.map((r) => r.projectId),
        ...validEnrollmentProjectIds,
      ])]

      if (projectIds.length === 0) return []
      conditions.push(inArray(schema.projects.id, projectIds))
    }

    const baseQuery = this.database
      .select({
        id: schema.projects.id,
        title: schema.projects.title,
        description: schema.projects.description,
        academicYearId: schema.projects.academicYearId,
        academicYearName: schema.academicYears.name,
        categoryId: schema.projects.categoryId,
        categoryName: schema.projectCategories.name,
        statusId: schema.projects.statusId,
        statusName: schema.projectStatuses.name,
        createdBy: schema.projects.createdBy,
        creatorName: schema.users.name,
        projectType: schema.projects.projectType,
        participationType: schema.projects.participationType,
        teamName: schema.projects.teamName,
        createdAt: schema.projects.createdAt,
        updatedAt: schema.projects.updatedAt,
        deletedAt: schema.projects.deletedAt,
      })
      .from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))

    const projects = conditions.length > 0 ? await baseQuery.where(and(...conditions)) : await baseQuery
    if (!projects.length) return []
    const ids = projects.map((project) => project.id)
    const [members, advisorsMap] = await Promise.all([
      this.database.select({ projectId: schema.projectStudents.projectId, name: schema.students.firstName, surname: schema.students.lastName })
        .from(schema.projectStudents).innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
        .where(and(inArray(schema.projectStudents.projectId, ids), isNull(schema.projectStudents.deletedAt))),
      this.resolveProjectAdvisors(this.database, ids),
    ])

    return projects.map((project) => {
      const projectAdvisors = advisorsMap.get(project.id) ?? []
      const names = new Set<string>()

      for (const adv of projectAdvisors) {
        if (adv.name) {
          names.add(adv.name)
        }
      }

      return {
        ...project,
        students: members.filter((member) => member.projectId === project.id).map((member) => `${member.name} ${member.surname}`),
        advisors: [...names],
      }
    })
  }

  async getProjectDetail(actor: AuthenticatedUser, projectId: string) {
    if (!actor || !actor.isActive) throw new AuthorizationError()

    const projectRows = await this.database
      .select({
        id: schema.projects.id,
        title: schema.projects.title,
        description: schema.projects.description,
        academicYearId: schema.projects.academicYearId,
        academicYearName: schema.academicYears.name,
        categoryId: schema.projects.categoryId,
        categoryName: schema.projectCategories.name,
        statusId: schema.projects.statusId,
        statusName: schema.projectStatuses.name,
        createdBy: schema.projects.createdBy,
        creatorName: schema.users.name,
        projectType: schema.projects.projectType,
        participationType: schema.projects.participationType,
        teamName: schema.projects.teamName,
        createdAt: schema.projects.createdAt,
        updatedAt: schema.projects.updatedAt,
        deletedAt: schema.projects.deletedAt,
      })
      .from(schema.projects)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.projects.academicYearId))
      .innerJoin(schema.projectCategories, eq(schema.projectCategories.id, schema.projects.categoryId))
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
      .where(eq(schema.projects.id, projectId))
      .limit(1)

    const project = projectRows[0]
    if (!project || (project.deletedAt !== null && actor.role !== 'ADMIN')) throw new ResourceNotFoundError('Proje bulunamadı.')

    const students = await this.getProjectMembers(actor, projectId)
    const advisorsMap = await this.resolveProjectAdvisors(this.database, [projectId])
    const advisors = advisorsMap.get(projectId) ?? []

    return {
      project,
      students,
      advisors,
    }
  }

  async resolveProjectAdvisors(
    transactionOrDb: AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0],
    projectIds: string[],
  ) {
    if (projectIds.length === 0) return new Map()

    const [explicitActive, allAdvisorRows, enrollmentAdvisorRows] = await Promise.all([
      transactionOrDb.select({
        projectId: schema.projectAdvisors.projectId,
        userId: schema.projectAdvisors.userId,
        name: sql<string>`coalesce(${schema.users.name}, 'Bilinmeyen Danışman')`,
        email: sql<string>`coalesce(${schema.users.email}, '')`,
        isPrimary: schema.projectAdvisors.isPrimary,
      })
        .from(schema.projectAdvisors)
        .leftJoin(schema.users, eq(schema.users.id, schema.projectAdvisors.userId))
        .where(and(inArray(schema.projectAdvisors.projectId, projectIds), isNull(schema.projectAdvisors.deletedAt))),

      transactionOrDb.select({
        projectId: schema.projectAdvisors.projectId,
        userId: schema.projectAdvisors.userId,
        deletedAt: schema.projectAdvisors.deletedAt,
      })
        .from(schema.projectAdvisors)
        .where(inArray(schema.projectAdvisors.projectId, projectIds)),

      transactionOrDb.select({
        projectId: schema.projectStudents.projectId,
        userId: schema.studentEnrollments.advisorUserId,
        advisorName: schema.studentEnrollments.advisorName,
        name: sql<string>`coalesce(${schema.users.name}, ${schema.studentEnrollments.advisorName}, 'Bilinmeyen Danışman')`,
        email: sql<string>`coalesce(${schema.users.email}, '')`,
      })
        .from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .leftJoin(schema.users, eq(schema.users.id, schema.studentEnrollments.advisorUserId))
        .where(and(
          inArray(schema.projectStudents.projectId, projectIds),
          isNull(schema.projectStudents.deletedAt),
          isNull(schema.studentEnrollments.deletedAt),
          eq(schema.studentEnrollments.isActive, true),
        )),
    ])

    const explicitActiveMap = new Map<string, Array<{ userId: string; name: string; email: string; isPrimary: boolean; source: 'EXPLICIT' | 'ENROLLMENT' }>>()
    for (const row of explicitActive) {
      if (!explicitActiveMap.has(row.projectId)) {
        explicitActiveMap.set(row.projectId, [])
      }
      explicitActiveMap.get(row.projectId)!.push({
        userId: row.userId ?? '',
        name: row.name,
        email: row.email ?? '',
        isPrimary: row.isPrimary,
        source: 'EXPLICIT',
      })
    }

    const allKnownUserMap = new Map<string, Set<string>>()
    for (const row of allAdvisorRows) {
      if (!allKnownUserMap.has(row.projectId)) {
        allKnownUserMap.set(row.projectId, new Set())
      }
      allKnownUserMap.get(row.projectId)!.add(row.userId)
    }

    const result = new Map<string, Array<{ userId: string; name: string; email: string; isPrimary: boolean; source: 'EXPLICIT' | 'ENROLLMENT' }>>()

    for (const pid of projectIds) {
      const projectExplicit = explicitActiveMap.get(pid) ?? []
      const projectAllKnown = allKnownUserMap.get(pid) ?? new Set()

      if (projectAllKnown.size > 0) {
        // Modern/decoupled project (has explicit project advisor records): use explicit active advisors only
        result.set(pid, projectExplicit)
      } else {
        // Truly old legacy project (zero project_advisors records in total): fallback to student enrollments
        const projectEnrollmentAdvisors = enrollmentAdvisorRows.filter((e) => e.projectId === pid)
        const legacyList: Array<{ userId: string; name: string; email: string; isPrimary: boolean; source: 'EXPLICIT' | 'ENROLLMENT' }> = []
        const seenUserIds = new Set<string>()

        for (const ea of projectEnrollmentAdvisors) {
          const uId = ea.userId ?? (ea.advisorName ? (ea.advisorName.startsWith('legacy:') ? ea.advisorName : `legacy:${ea.advisorName}`) : null)
          const advName = ea.name !== 'Bilinmeyen Danışman' ? ea.name : (ea.advisorName ?? 'Bilinmeyen Danışman')

          if (
            uId &&
            !seenUserIds.has(uId)
          ) {
            seenUserIds.add(uId)
            legacyList.push({
              userId: uId,
              name: advName,
              email: ea.email ?? '',
              isPrimary: false,
              source: 'ENROLLMENT',
            })
          }
        }
        result.set(pid, legacyList)
      }
    }

    return result
  }

  async getProjectMembers(actor: AuthenticatedUser, projectId: string) {
    if (!actor || !actor.isActive) throw new AuthorizationError()
    await this.getProject(this.database, projectId, actor.role === 'ADMIN')

    return this.database
      .select({
        enrollmentId: schema.studentEnrollments.id,
        studentId: schema.students.id,
        bilsemNo: schema.students.bilsemNo,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        gradeLevel: schema.studentEnrollments.gradeLevel,
        className: schema.studentEnrollments.className,
      })
      .from(schema.projectStudents)
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
      .where(and(
        eq(schema.projectStudents.projectId, projectId),
        isNull(schema.projectStudents.deletedAt),
      ))
  }

  async createProject(actor: AuthenticatedUser, input: CreateProjectInput) {
    if (!actor.isActive || !['ADMIN', 'TEACHER'].includes(actor.role)) throw new AuthorizationError()
    const effectiveProjectType = input.projectType ?? 'STUDENT'
    assertCanCreateProject(actor, effectiveProjectType)

    const enrollmentIds = input.enrollmentIds ?? []
    this.validateParticipation(input.participationType, enrollmentIds, effectiveProjectType)

    return this.database.transaction(async (transaction) => {
      const uniqueEnrollmentIds = [...new Set(enrollmentIds)]
      if (uniqueEnrollmentIds.length !== enrollmentIds.length) {
        throw new ProjectRuleError('Aynı öğrenci aynı projeye birden fazla eklenemez.')
      }

      let selectedEnrollments: Array<{ enrollmentId: string; academicYearId: string; isActive: boolean; studentId: string; bilsemNo: string }> = []
      if (uniqueEnrollmentIds.length > 0) {
        const enrollmentRows = await transaction
          .select({
            enrollmentId: schema.studentEnrollments.id,
            academicYearId: schema.studentEnrollments.academicYearId,
            isActive: schema.studentEnrollments.isActive,
            studentId: schema.students.id,
            bilsemNo: schema.students.bilsemNo,
          })
          .from(schema.studentEnrollments)
          .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
          .where(and(inArray(schema.studentEnrollments.id, uniqueEnrollmentIds), isNull(schema.studentEnrollments.deletedAt)))

        selectedEnrollments = enrollmentRows.filter((row) => uniqueEnrollmentIds.includes(row.enrollmentId))
        if (selectedEnrollments.length !== uniqueEnrollmentIds.length) {
          throw new ProjectRuleError('Bir veya daha fazla öğrenci kaydı bulunamadı.')
        }
        if (selectedEnrollments.some((row) => !row.isActive || row.academicYearId !== input.academicYearId)) {
          throw new ProjectRuleError('Öğrenciler yalnızca projenin akademik yılındaki aktif kayıtlardan seçilebilir.')
        }
      }

      const projectId = randomUUID()
      await transaction.insert(schema.projects).values({
        id: projectId,
        title: input.title,
        description: input.description,
        academicYearId: input.academicYearId,
        categoryId: input.categoryId,
        statusId: input.statusId,
        createdBy: actor.id,
        projectType: effectiveProjectType,
        participationType: input.participationType,
        teamName: input.participationType === 'TEAM' ? input.teamName : null,
      })

      if (uniqueEnrollmentIds.length > 0) {
        await transaction.insert(schema.projectStudents).values(uniqueEnrollmentIds.map((enrollmentId) => ({
          projectId,
          enrollmentId,
        })))
      }

      if (actor.role === 'TEACHER') {
        if (input.advisorUserIds !== undefined && input.advisorUserIds !== null) {
          throw new ProjectRuleError('Öğretmenler danışman seçimi yapamaz.')
        }
        await transaction.insert(schema.projectAdvisors).values({
          projectId,
          userId: actor.id,
          isPrimary: true,
        }).onConflictDoNothing()
      } else {
        if (input.advisorUserIds !== undefined && input.advisorUserIds !== null && input.advisorUserIds.length > 0) {
          const uniqueAdvisorIds = [...new Set(input.advisorUserIds)]

          for (const userId of uniqueAdvisorIds) {
            if (userId === actor.id) {
              const activeUser = await transaction
                .select({ id: schema.users.id })
                .from(schema.users)
                .where(and(
                  eq(schema.users.id, userId),
                  eq(schema.users.isActive, true),
                  isNull(schema.users.deletedAt),
                ))
                .limit(1)
              if (!activeUser[0]) {
                throw new ProjectRuleError('Seçilen danışman aktif bir kullanıcı olmalıdır.')
              }
            } else {
              const validTeacher = await transaction
                .select({ id: schema.users.id })
                .from(schema.users)
                .where(and(
                  eq(schema.users.id, userId),
                  eq(schema.users.role, 'TEACHER'),
                  eq(schema.users.isActive, true),
                  isNull(schema.users.deletedAt),
                ))
                .limit(1)
              if (!validTeacher[0]) {
                throw new ProjectRuleError('Seçilen danışman aktif bir öğretmen olmalıdır.')
              }
            }
          }

          await transaction.insert(schema.projectAdvisors).values(
            uniqueAdvisorIds.map((userId, index) => ({
              projectId,
              userId,
              isPrimary: index === 0,
            }))
          ).onConflictDoNothing()
        } else if (effectiveProjectType !== 'INSTITUTION') {
          // ADMIN did not select advisors for STUDENT / TEACHER project -> ADMIN creator (actor.id) is default primary advisor
          const activeUser = await transaction
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(
              eq(schema.users.id, actor.id),
              eq(schema.users.isActive, true),
              isNull(schema.users.deletedAt),
            ))
            .limit(1)

          if (!activeUser[0]) {
            throw new ProjectRuleError('Proje sahibi aktif bir kullanıcı olmalıdır.')
          }

          await transaction.insert(schema.projectAdvisors).values({
            projectId,
            userId: actor.id,
            isPrimary: true,
          }).onConflictDoNothing()
        }
        // For INSTITUTION projects, if ADMIN does not specify advisors, 0 advisors are assigned upon creation.
      }

      const category = await transaction
        .select({
          duplicateCheckEnabled: schema.projectCategories.duplicateCheckEnabled,
          duplicateRule: schema.projectCategories.duplicateRule,
        })
        .from(schema.projectCategories)
        .where(eq(schema.projectCategories.id, input.categoryId))
        .limit(1)

      const conflicts: ProjectConflict[] = []
      if (category[0]?.duplicateCheckEnabled && category[0].duplicateRule === 'ACADEMIC_YEAR_STUDENT_CATEGORY' && selectedEnrollments.length > 0) {
        for (const enrollment of selectedEnrollments) {
          await transaction.insert(schema.projectDuplicateClaims).values({
            academicYearId: input.academicYearId,
            studentId: enrollment.studentId,
            categoryId: input.categoryId,
            projectId,
          }).onConflictDoNothing()

          const claim = await transaction
            .select({
              projectId: schema.projects.id,
              title: schema.projects.title,
              status: schema.projectStatuses.name,
              ownerId: schema.users.id,
              ownerName: schema.users.name,
            })
            .from(schema.projectDuplicateClaims)
            .innerJoin(schema.projects, eq(schema.projects.id, schema.projectDuplicateClaims.projectId))
            .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
            .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
            .where(and(
              eq(schema.projectDuplicateClaims.academicYearId, input.academicYearId),
              eq(schema.projectDuplicateClaims.studentId, enrollment.studentId),
              eq(schema.projectDuplicateClaims.categoryId, input.categoryId),
              ne(schema.projectDuplicateClaims.projectId, projectId),
            ))
            .limit(1)

          if (claim[0]) {
            conflicts.push({
              studentId: enrollment.studentId,
              bilsemNo: enrollment.bilsemNo,
              ...claim[0],
            })
          }
        }
      }

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'PROJECT_CREATED',
        entityType: 'PROJECT',
        entityId: projectId,
        afterJson: JSON.stringify({ ...input, projectType: effectiveProjectType, enrollmentIds: uniqueEnrollmentIds }),
      })

      if (conflicts.length > 0) {
        const recipients = new Set<string>([actor.id, ...conflicts.map((conflict) => conflict.ownerId)])
        await transaction.insert(schema.notifications).values([...recipients].map((recipientId) => ({
          id: randomUUID(),
          recipientId,
          projectId,
          type: 'DUPLICATE_PROJECT_WARNING' as const,
          title: 'Mükerrer TÜBİTAK proje uyarısı',
          message: this.buildConflictMessage(conflicts),
        })))
        await transaction.insert(schema.auditLogs).values({
          id: randomUUID(),
          actorUserId: actor.id,
          action: 'DUPLICATE_PROJECT_WARNING',
          entityType: 'PROJECT',
          entityId: projectId,
          afterJson: JSON.stringify(conflicts),
        })
      }

      return { projectId, conflicts }
    })
  }

  async updateProject(actor: AuthenticatedUser, projectId: string, changes: { title?: string; description?: string | null; statusId?: string; teamName?: string | null }) {
    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId)
      assertCanModifyProject(actor, project)

      await transaction.update(schema.projects).set({ ...changes, updatedAt: new Date() }).where(eq(schema.projects.id, projectId))
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: changes.statusId ? 'PROJECT_STATUS_UPDATED' : 'PROJECT_UPDATED',
        entityType: 'PROJECT',
        entityId: projectId,
        beforeJson: JSON.stringify(project),
        afterJson: JSON.stringify(changes),
      })

      if (changes.statusId) {
        const advisorRows = await transaction.select({ userId: schema.projectAdvisors.userId })
          .from(schema.projectAdvisors)
          .where(and(eq(schema.projectAdvisors.projectId, projectId), isNull(schema.projectAdvisors.deletedAt)))
        const recipients = new Set([project.createdBy, ...advisorRows.map((row) => row.userId)])
        await transaction.insert(schema.notifications).values([...recipients].map((recipientId) => ({
          id: randomUUID(), recipientId, projectId, type: 'PROJECT_STATUS_UPDATED' as const,
          title: 'Proje durumu güncellendi', message: `“${project.title}” projesinin durumu güncellendi.`,
        })))
      }
    })
  }

  async archiveProject(actor: AuthenticatedUser, projectId: string) {
    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId)
      if (!canArchiveProject(actor, project)) throw new AuthorizationError()
      const archivedAt = new Date()
      await transaction.update(schema.projects).set({ deletedAt: archivedAt, deletedBy: actor.id, updatedAt: archivedAt })
        .where(eq(schema.projects.id, projectId))
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: actor.id, action: 'PROJECT_ARCHIVED', entityType: 'PROJECT', entityId: projectId,
        beforeJson: JSON.stringify(project), afterJson: JSON.stringify({ deletedAt: archivedAt, deletedBy: actor.id }),
      })
    })
  }

  async restoreProject(actor: AuthenticatedUser, projectId: string) {
    if (!canRestoreProject(actor)) throw new AuthorizationError()
    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId, true)
      await transaction.update(schema.projects).set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId))
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: actor.id, action: 'PROJECT_RESTORED', entityType: 'PROJECT', entityId: projectId,
        beforeJson: JSON.stringify(project), afterJson: JSON.stringify({ deletedAt: null, deletedBy: null }),
      })
    })
  }

  async deleteProject(actor: AuthenticatedUser, projectId: string) {
    if (!actor || !actor.isActive) throw new AuthorizationError()
    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId, true)
      if (actor.role !== 'ADMIN' && project.createdBy !== actor.id) {
        throw new AuthorizationError('Bu projeyi silme yetkiniz yok.', 403)
      }

      await transaction.delete(schema.projectStudents).where(eq(schema.projectStudents.projectId, projectId))
      await transaction.delete(schema.projectAdvisors).where(eq(schema.projectAdvisors.projectId, projectId))
      await transaction.delete(schema.projectStatusHistory).where(eq(schema.projectStatusHistory.projectId, projectId))
      await transaction.delete(schema.projectDuplicateClaims).where(eq(schema.projectDuplicateClaims.projectId, projectId))
      await transaction.delete(schema.projectAttachments).where(eq(schema.projectAttachments.projectId, projectId))
      await transaction.delete(schema.notifications).where(eq(schema.notifications.projectId, projectId))
      await transaction.delete(schema.projects).where(eq(schema.projects.id, projectId))

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'PROJECT_DELETE',
        entityType: 'PROJECT',
        entityId: projectId,
        beforeJson: JSON.stringify(project),
      })
    })
  }

  async addTeamMember(actor: AuthenticatedUser, projectId: string, enrollmentId: string) {
    return this.changeTeamMember(actor, projectId, enrollmentId, 'ADD')
  }

  async removeTeamMember(actor: AuthenticatedUser, projectId: string, enrollmentId: string) {
    return this.changeTeamMember(actor, projectId, enrollmentId, 'REMOVE')
  }

  private async changeTeamMember(actor: AuthenticatedUser, projectId: string, enrollmentId: string, operation: 'ADD' | 'REMOVE') {
    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId)
      assertCanModifyProject(actor, project)
      if (project.participationType !== 'TEAM') throw new ProjectRuleError('Üyelik yalnızca takım projelerinde değiştirilebilir.')

      const enrollment = await transaction.select({
        id: schema.studentEnrollments.id,
        studentId: schema.studentEnrollments.studentId,
        academicYearId: schema.studentEnrollments.academicYearId,
        isActive: schema.studentEnrollments.isActive,
        advisorUserId: schema.studentEnrollments.advisorUserId,
      }).from(schema.studentEnrollments).where(and(
        eq(schema.studentEnrollments.id, enrollmentId),
        isNull(schema.studentEnrollments.deletedAt),
      )).limit(1)
      if (!enrollment[0] || !enrollment[0].isActive || enrollment[0].academicYearId !== project.academicYearId) {
        throw new ProjectRuleError('Öğrenci aktif ve proje akademik yılına kayıtlı olmalıdır.')
      }

      const members = await transaction.select({ enrollmentId: schema.projectStudents.enrollmentId })
        .from(schema.projectStudents)
        .where(and(eq(schema.projectStudents.projectId, projectId), isNull(schema.projectStudents.deletedAt)))

      if (operation === 'ADD') {
        if (members.some((member) => member.enrollmentId === enrollmentId)) throw new ProjectRuleError('Öğrenci zaten takım üyesi.')
        await transaction.insert(schema.projectStudents).values({ projectId, enrollmentId }).onConflictDoUpdate({
          target: [schema.projectStudents.projectId, schema.projectStudents.enrollmentId],
          set: { deletedAt: null, deletedBy: null, updatedAt: new Date() },
        })
      } else {
        if (members.length <= 2) throw new ProjectRuleError('Takım projesinde en az iki öğrenci bulunmalıdır.')
        if (!members.some((member) => member.enrollmentId === enrollmentId)) {
          throw new ProjectRuleError('Öğrenci bu takım projesinin üyesi değil.')
        }
        await transaction.update(schema.projectStudents).set({ deletedAt: new Date(), deletedBy: actor.id, updatedAt: new Date() })
          .where(and(eq(schema.projectStudents.projectId, projectId), eq(schema.projectStudents.enrollmentId, enrollmentId)))

        await transaction.delete(schema.projectDuplicateClaims)
          .where(and(
            eq(schema.projectDuplicateClaims.projectId, projectId),
            eq(schema.projectDuplicateClaims.studentId, enrollment[0].studentId),
            eq(schema.projectDuplicateClaims.academicYearId, project.academicYearId),
            eq(schema.projectDuplicateClaims.categoryId, project.categoryId),
          ))
      }

      let memberConflict: { projectId: string; title: string; ownerId: string; ownerName: string } | undefined
      if (operation === 'ADD') {
        const category = await transaction.select({
          enabled: schema.projectCategories.duplicateCheckEnabled,
          duplicateRule: schema.projectCategories.duplicateRule,
        })
          .from(schema.projectCategories).where(eq(schema.projectCategories.id, project.categoryId)).limit(1)
        if (category[0]?.enabled && category[0].duplicateRule === 'ACADEMIC_YEAR_STUDENT_CATEGORY') {
          await transaction.insert(schema.projectDuplicateClaims).values({
            academicYearId: project.academicYearId,
            studentId: enrollment[0].studentId,
            categoryId: project.categoryId,
            projectId,
          }).onConflictDoNothing()
          const conflictRows = await transaction.select({
            projectId: schema.projects.id,
            title: schema.projects.title,
            ownerId: schema.users.id,
            ownerName: schema.users.name,
          }).from(schema.projectDuplicateClaims)
            .innerJoin(schema.projects, eq(schema.projects.id, schema.projectDuplicateClaims.projectId))
            .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
            .where(and(
              eq(schema.projectDuplicateClaims.academicYearId, project.academicYearId),
              eq(schema.projectDuplicateClaims.studentId, enrollment[0].studentId),
              eq(schema.projectDuplicateClaims.categoryId, project.categoryId),
              ne(schema.projectDuplicateClaims.projectId, projectId),
            )).limit(1)
          memberConflict = conflictRows[0]
        }
      }

      const submitted = project.statusCode !== 'DRAFT'
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(), actorUserId: actor.id,
        action: submitted ? `SUBMITTED_TEAM_MEMBER_${operation}_WARNING` : `TEAM_MEMBER_${operation}`,
        entityType: 'PROJECT_STUDENT', entityId: `${projectId}:${enrollmentId}`,
        afterJson: JSON.stringify({ projectId, enrollmentId, submitted }),
      })

      if (operation === 'ADD') {
        const recipients = new Set([project.createdBy])
        await transaction.insert(schema.notifications).values([...recipients].map((recipientId) => ({
          id: randomUUID(), recipientId, projectId, type: 'TEAM_MEMBER_ADDED' as const,
          title: 'Takım üyesi eklendi',
          message: submitted ? 'Başvurusu yapılmış projeye takım üyesi eklendi; kayıt incelemelidir.' : 'Projeye yeni takım üyesi eklendi.',
        })))
        if (memberConflict) {
          const conflictRecipients = new Set([actor.id, memberConflict.ownerId])
          await transaction.insert(schema.notifications).values([...conflictRecipients].map((recipientId) => ({
            id: randomUUID(), recipientId, projectId, type: 'TEAM_MEMBER_PROJECT_CONFLICT' as const,
            title: 'Takım üyesi proje çakışması',
            message: `Eklenen öğrencinin “${memberConflict.title}” projesinde aynı kategori kaydı bulunuyor (${memberConflict.ownerName}).`,
          })))
          await transaction.insert(schema.auditLogs).values({
            id: randomUUID(), actorUserId: actor.id, action: 'TEAM_MEMBER_PROJECT_CONFLICT',
            entityType: 'PROJECT_STUDENT', entityId: `${projectId}:${enrollmentId}`,
            afterJson: JSON.stringify(memberConflict),
          })
        }
      }

      return { warning: submitted, conflict: memberConflict }
    })
  }

  async convertToTeam(actor: AuthenticatedUser, projectId: string, input: { teamName?: string | null; additionalEnrollmentIds: string[] }) {
    if (!actor || !actor.isActive) throw new AuthorizationError()

    const trimmedIds = input.additionalEnrollmentIds.map((id) => id.trim()).filter(Boolean)
    if (trimmedIds.length === 0) {
      throw new ProjectRuleError('En az bir ek öğrenci seçilmelidir.')
    }
    const uniqueAdditionalIds = [...new Set(trimmedIds)]
    if (uniqueAdditionalIds.length !== input.additionalEnrollmentIds.length) {
      throw new ProjectRuleError('Tekrar eden öğrenci seçimi yapılamaz.')
    }

    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId)
      assertCanModifyProject(actor, project)

      if (project.participationType === 'TEAM') {
        throw new ProjectRuleError('Proje zaten takım projesidir.')
      }

      const currentMembers = await transaction.select({ enrollmentId: schema.projectStudents.enrollmentId })
        .from(schema.projectStudents)
        .where(and(eq(schema.projectStudents.projectId, projectId), isNull(schema.projectStudents.deletedAt)))

      const existingEnrollmentIds = new Set(currentMembers.map((m) => m.enrollmentId))
      for (const id of uniqueAdditionalIds) {
        if (existingEnrollmentIds.has(id)) {
          throw new ProjectRuleError('Aynı öğrenci projeye ikinci kez eklenemez.')
        }
      }

      const totalMembersCount = currentMembers.length + uniqueAdditionalIds.length
      if (totalMembersCount < 2) {
        throw new ProjectRuleError('Takım projesine dönüştürmek için en az bir ek öğrenci seçilmelidir (toplam en az iki öğrenci).')
      }

      const enrollmentRows = await transaction
        .select({
          enrollmentId: schema.studentEnrollments.id,
          academicYearId: schema.studentEnrollments.academicYearId,
          isActive: schema.studentEnrollments.isActive,
          studentId: schema.students.id,
          bilsemNo: schema.students.bilsemNo,
        })
        .from(schema.studentEnrollments)
        .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
        .where(and(inArray(schema.studentEnrollments.id, uniqueAdditionalIds), isNull(schema.studentEnrollments.deletedAt)))

      if (enrollmentRows.length !== uniqueAdditionalIds.length) {
        throw new ProjectRuleError('Bir veya daha fazla öğrenci kaydı bulunamadı.')
      }

      if (enrollmentRows.some((row) => !row.isActive || row.academicYearId !== project.academicYearId)) {
        throw new ProjectRuleError('Öğrenciler yalnızca projenin akademik yılındaki aktif kayıtlardan seçilebilir.')
      }

      const teamName = input.teamName?.trim() || null
      await transaction.update(schema.projects).set({
        participationType: 'TEAM',
        teamName,
        updatedAt: new Date(),
      }).where(eq(schema.projects.id, projectId))

      for (const enrollmentId of uniqueAdditionalIds) {
        await transaction.insert(schema.projectStudents).values({ projectId, enrollmentId }).onConflictDoUpdate({
          target: [schema.projectStudents.projectId, schema.projectStudents.enrollmentId],
          set: { deletedAt: null, deletedBy: null, updatedAt: new Date() },
        })
      }

      const conflicts: ProjectConflict[] = []
      const category = await transaction.select({
        enabled: schema.projectCategories.duplicateCheckEnabled,
        duplicateRule: schema.projectCategories.duplicateRule,
      }).from(schema.projectCategories).where(eq(schema.projectCategories.id, project.categoryId)).limit(1)

      if (category[0]?.enabled && category[0].duplicateRule === 'ACADEMIC_YEAR_STUDENT_CATEGORY') {
        for (const enrollment of enrollmentRows) {
          await transaction.insert(schema.projectDuplicateClaims).values({
            academicYearId: project.academicYearId,
            studentId: enrollment.studentId,
            categoryId: project.categoryId,
            projectId,
          }).onConflictDoNothing()

          const conflictRows = await transaction.select({
            projectId: schema.projects.id,
            title: schema.projects.title,
            status: schema.projectStatuses.name,
            ownerId: schema.users.id,
            ownerName: schema.users.name,
          }).from(schema.projectDuplicateClaims)
            .innerJoin(schema.projects, eq(schema.projects.id, schema.projectDuplicateClaims.projectId))
            .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
            .innerJoin(schema.users, eq(schema.users.id, schema.projects.createdBy))
            .where(and(
              eq(schema.projectDuplicateClaims.academicYearId, project.academicYearId),
              eq(schema.projectDuplicateClaims.studentId, enrollment.studentId),
              eq(schema.projectDuplicateClaims.categoryId, project.categoryId),
              ne(schema.projectDuplicateClaims.projectId, projectId),
            )).limit(1)

          if (conflictRows[0]) {
            conflicts.push({
              studentId: enrollment.studentId,
              bilsemNo: enrollment.bilsemNo,
              ...conflictRows[0],
            })
          }
        }
      }

      const submitted = project.statusCode !== 'DRAFT'
      const addedRecipients = new Set([project.createdBy])
      await transaction.insert(schema.notifications).values([...addedRecipients].map((recipientId) => ({
        id: randomUUID(),
        recipientId,
        projectId,
        type: 'TEAM_MEMBER_ADDED' as const,
        title: 'Takım üyeleri eklendi',
        message: submitted
          ? 'Başvurusu yapılmış proje takım çalışmasına dönüştürüldü ve yeni üyeler eklendi; kayıt incelemelidir.'
          : 'Proje takım çalışmasına dönüştürüldü ve yeni üyeler eklendi.',
      })))

      for (const conflict of conflicts) {
        const conflictRecipients = new Set([actor.id, conflict.ownerId])
        await transaction.insert(schema.notifications).values([...conflictRecipients].map((recipientId) => ({
          id: randomUUID(),
          recipientId,
          projectId,
          type: 'TEAM_MEMBER_PROJECT_CONFLICT' as const,
          title: 'Takım üyesi proje çakışması',
          message: `Eklenen öğrencinin “${conflict.title}” projesinde aynı kategori kaydı bulunuyor (${conflict.ownerName}).`,
        })))
        await transaction.insert(schema.auditLogs).values({
          id: randomUUID(),
          actorUserId: actor.id,
          action: 'TEAM_MEMBER_PROJECT_CONFLICT',
          entityType: 'PROJECT_STUDENT',
          entityId: `${projectId}:${conflict.studentId}`,
          afterJson: JSON.stringify(conflict),
        })
      }

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'PROJECT_CONVERTED_TO_TEAM',
        entityType: 'PROJECT',
        entityId: projectId,
        beforeJson: JSON.stringify({ participationType: 'INDIVIDUAL', teamName: project.teamName, members: currentMembers.map((m) => m.enrollmentId) }),
        afterJson: JSON.stringify({ participationType: 'TEAM', teamName, members: [...currentMembers.map((m) => m.enrollmentId), ...uniqueAdditionalIds], addedMembers: uniqueAdditionalIds, conflicts }),
      })

      return { projectId, conflicts }
    })
  }

  async convertToIndividual(actor: AuthenticatedUser, projectId: string, input: { selectedEnrollmentId: string }) {
    if (!actor || !actor.isActive) throw new AuthorizationError()

    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId)
      assertCanModifyProject(actor, project)

      if (project.participationType === 'INDIVIDUAL') {
        throw new ProjectRuleError('Proje zaten bireysel projedir.')
      }

      const currentMembers = await transaction.select({
        enrollmentId: schema.projectStudents.enrollmentId,
        studentId: schema.studentEnrollments.studentId,
      }).from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .where(and(eq(schema.projectStudents.projectId, projectId), isNull(schema.projectStudents.deletedAt)))

      const selectedMember = currentMembers.find((m) => m.enrollmentId === input.selectedEnrollmentId)
      if (!selectedMember) {
        throw new ProjectRuleError('Seçilen öğrenci projenin aktif bir üyesi değil.')
      }

      const removedMembers = currentMembers.filter((m) => m.enrollmentId !== input.selectedEnrollmentId)

      for (const removed of removedMembers) {
        await transaction.update(schema.projectStudents).set({
          deletedAt: new Date(),
          deletedBy: actor.id,
          updatedAt: new Date(),
        }).where(and(
          eq(schema.projectStudents.projectId, projectId),
          eq(schema.projectStudents.enrollmentId, removed.enrollmentId),
        ))

        await transaction.delete(schema.projectDuplicateClaims).where(and(
          eq(schema.projectDuplicateClaims.projectId, projectId),
          eq(schema.projectDuplicateClaims.studentId, removed.studentId),
          eq(schema.projectDuplicateClaims.academicYearId, project.academicYearId),
          eq(schema.projectDuplicateClaims.categoryId, project.categoryId),
        ))
      }

      await transaction.update(schema.projects).set({
        participationType: 'INDIVIDUAL',
        teamName: null,
        updatedAt: new Date(),
      }).where(eq(schema.projects.id, projectId))

      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'PROJECT_CONVERTED_TO_INDIVIDUAL',
        entityType: 'PROJECT',
        entityId: projectId,
        beforeJson: JSON.stringify({ participationType: 'TEAM', teamName: project.teamName, members: currentMembers.map((m) => m.enrollmentId) }),
        afterJson: JSON.stringify({ participationType: 'INDIVIDUAL', keptEnrollmentId: input.selectedEnrollmentId, removedEnrollmentIds: removedMembers.map((m) => m.enrollmentId) }),
      })

      return { projectId }
    })
  }

  async updateProjectAdvisors(
    actor: AuthenticatedUser,
    projectId: string,
    input: UpdateProjectAdvisorsInput,
  ) {
    if (!actor || !actor.isActive || actor.role !== 'ADMIN') {
      throw new AuthorizationError('Yalnızca yöneticiler proje danışmanlarını değiştirebilir.', 403)
    }

    const toAdd = [...new Set(input.addUserIds ?? [])]
    const toRemove = [...new Set(input.removeUserIds ?? [])]

    for (const id of [...toAdd, ...toRemove]) {
      if (!id || typeof id !== 'string' || id.startsWith('legacy:')) {
        throw new ProjectRuleError('Sanal veya legacy kimlikler doğrudan değiştirilemez.')
      }
    }

    return this.database.transaction(async (transaction) => {
      const project = await this.getProject(transaction, projectId)

      // 1. Audit için gerçek önceki danışmanlar (fallback eklenmeden ÖNCE)
      const beforeAdvisors = await transaction
        .select({ userId: schema.users.id, name: schema.users.name, isPrimary: schema.projectAdvisors.isPrimary })
        .from(schema.projectAdvisors)
        .innerJoin(schema.users, eq(schema.users.id, schema.projectAdvisors.userId))
        .where(and(eq(schema.projectAdvisors.projectId, projectId), isNull(schema.projectAdvisors.deletedAt)))

      // 2. Mevcut aktif danışmanlar
      let existingActive = await transaction
        .select({
          userId: schema.projectAdvisors.userId,
          isPrimary: schema.projectAdvisors.isPrimary,
        })
        .from(schema.projectAdvisors)
        .where(and(
          eq(schema.projectAdvisors.projectId, projectId),
          isNull(schema.projectAdvisors.deletedAt),
        ))

      // Proje danışmanı bulunmayan eski projelerde, eğer yeni danışman eklenmiyorsa fallback dene
      if (existingActive.length === 0 && toAdd.length === 0) {
        if (project.projectType !== 'INSTITUTION') {
          const creatorUser = await transaction
            .select({ id: schema.users.id, role: schema.users.role }).from(schema.users)
            .where(and(
              eq(schema.users.id, project.createdBy),
              eq(schema.users.isActive, true),
              isNull(schema.users.deletedAt),
            )).limit(1)

          if (creatorUser[0] && (creatorUser[0].role === 'TEACHER' || creatorUser[0].id === actor.id)) {
            const now = new Date()
            await transaction.insert(schema.projectAdvisors)
              .values({ projectId, userId: creatorUser[0].id, isPrimary: true, createdAt: now, updatedAt: now })
              .onConflictDoUpdate({
                target: [schema.projectAdvisors.projectId, schema.projectAdvisors.userId],
                set: { deletedAt: null, deletedBy: null, isPrimary: true, updatedAt: now },
              })
          } else {
            throw new ProjectRuleError('Eski projeye ait geçerli bir proje danışmanı bulunamadı. Lütfen önce bir danışman belirleyin.')
          }
        }

        existingActive = await transaction
          .select({ userId: schema.projectAdvisors.userId, isPrimary: schema.projectAdvisors.isPrimary })
          .from(schema.projectAdvisors)
          .where(and(eq(schema.projectAdvisors.projectId, projectId), isNull(schema.projectAdvisors.deletedAt)))
      }

      const existingActiveIds = new Set(existingActive.map((a) => a.userId))

      // Validation
      for (const id of toAdd) {
        if (toRemove.includes(id)) {
          throw new ProjectRuleError('Aynı danışman hem eklenip hem çıkarılamaz.')
        }
      }
      for (const id of toAdd) {
        if (existingActiveIds.has(id)) {
          throw new ProjectRuleError('Seçilen öğretmen zaten projenin aktif danışmanıdır.')
        }
      }
      for (const id of toRemove) {
        if (!existingActiveIds.has(id)) {
          throw new ProjectRuleError('Çıkarılmak istenen öğretmen projenin aktif danışmanı değil.')
        }
      }

      // Yalnızca aktif TEACHER veya acting ADMIN kendi hesabı eklenebilsin
      if (toAdd.length > 0) {
        for (const userId of toAdd) {
          if (userId === actor.id) {
            const activeUser = await transaction
              .select({ id: schema.users.id }).from(schema.users)
              .where(and(
                eq(schema.users.id, userId),
                eq(schema.users.isActive, true),
                isNull(schema.users.deletedAt),
              )).limit(1)
            if (!activeUser[0]) {
              throw new ProjectRuleError('Yalnızca aktif kullanıcı hesapları danışman olarak eklenebilir.')
            }
          } else {
            const validTeacher = await transaction
              .select({ id: schema.users.id }).from(schema.users)
              .where(and(
                eq(schema.users.id, userId),
                eq(schema.users.role, 'TEACHER'),
                eq(schema.users.isActive, true),
                isNull(schema.users.deletedAt),
              )).limit(1)
            if (!validTeacher[0]) {
              throw new ProjectRuleError('Seçilen danışman aktif bir öğretmen olmalıdır.')
            }
          }
        }
      }

      // En az 1 aktif danışman (STUDENT / TEACHER için zorunlu, INSTITUTION için 0 mümkün)
      const remainingCount = (existingActive.length - toRemove.length) + toAdd.length
      if (remainingCount < 1 && project.projectType !== 'INSTITUTION') {
        throw new ProjectRuleError('Bir projede en az bir aktif danışman bulunmalıdır.')
      }

      const now = new Date()

      // Mevcut tum kayitlar (silinmis dahil)
      const allRows = await transaction
        .select({ userId: schema.projectAdvisors.userId, isPrimary: schema.projectAdvisors.isPrimary, deletedAt: schema.projectAdvisors.deletedAt })
        .from(schema.projectAdvisors)
        .where(eq(schema.projectAdvisors.projectId, projectId))
      const allRowsMap = new Map(allRows.map((r) => [r.userId, r]))

      // Soft-delete
      for (const userId of toRemove) {
        await transaction.update(schema.projectAdvisors)
          .set({ deletedAt: now, deletedBy: actor.id, updatedAt: now })
          .where(and(eq(schema.projectAdvisors.projectId, projectId), eq(schema.projectAdvisors.userId, userId)))
      }

      // Yeniden ekleme / reactivation
      for (const userId of toAdd) {
        const existingRow = allRowsMap.get(userId)
        if (existingRow) {
          await transaction.update(schema.projectAdvisors)
            .set({ deletedAt: null, deletedBy: null, isPrimary: false, updatedAt: now })
            .where(and(eq(schema.projectAdvisors.projectId, projectId), eq(schema.projectAdvisors.userId, userId)))
        } else {
          await transaction.insert(schema.projectAdvisors)
            .values({ projectId, userId, isPrimary: false, createdAt: now, updatedAt: now })
        }
      }

      // Rigorous Primary Advisor Reconciliation: Exactly one active primary advisor (if any advisors exist)
      const currentActive = await transaction
        .select({ userId: schema.projectAdvisors.userId, isPrimary: schema.projectAdvisors.isPrimary })
        .from(schema.projectAdvisors)
        .where(and(eq(schema.projectAdvisors.projectId, projectId), isNull(schema.projectAdvisors.deletedAt)))

      let chosenPrimaryUserId: string | null = null
      if (currentActive.length > 0) {
        const removedSet = new Set(toRemove)
        const existingPrimary = existingActive.find((a) => a.isPrimary && !removedSet.has(a.userId))

        if (existingPrimary && currentActive.some((a) => a.userId === existingPrimary.userId)) {
          chosenPrimaryUserId = existingPrimary.userId
        } else {
          const sortedActive = [...currentActive].sort((a, b) => a.userId.localeCompare(b.userId))
          chosenPrimaryUserId = sortedActive[0]!.userId
        }
      }

      for (const adv of currentActive) {
        const shouldBePrimary = adv.userId === chosenPrimaryUserId
        if (adv.isPrimary !== shouldBePrimary) {
          await transaction.update(schema.projectAdvisors)
            .set({ isPrimary: shouldBePrimary, updatedAt: now })
            .where(and(
              eq(schema.projectAdvisors.projectId, projectId),
              eq(schema.projectAdvisors.userId, adv.userId),
            ))
        }
      }

      // Final durum
      const finalAdvisors = await transaction
        .select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, isPrimary: schema.projectAdvisors.isPrimary })
        .from(schema.projectAdvisors)
        .innerJoin(schema.users, eq(schema.users.id, schema.projectAdvisors.userId))
        .where(and(eq(schema.projectAdvisors.projectId, projectId), isNull(schema.projectAdvisors.deletedAt)))

      // Audit log
      await transaction.insert(schema.auditLogs).values({
        id: randomUUID(),
        actorUserId: actor.id,
        action: 'PROJECT_ADVISORS_UPDATED',
        entityType: 'PROJECT',
        entityId: projectId,
        beforeJson: JSON.stringify({ advisors: beforeAdvisors }),
        afterJson: JSON.stringify({ advisors: finalAdvisors.map((a) => ({ userId: a.userId, name: a.name, isPrimary: a.isPrimary })) }),
      })

      return { projectId, advisors: finalAdvisors }
    })
  }

  private async getProject(database: AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0], projectId: string, includeArchived = false) {
    const rows = await database.select({
      id: schema.projects.id,
      title: schema.projects.title,
      createdBy: schema.projects.createdBy,
      academicYearId: schema.projects.academicYearId,
      categoryId: schema.projects.categoryId,
      projectType: schema.projects.projectType,
      participationType: schema.projects.participationType,
      teamName: schema.projects.teamName,
      deletedAt: schema.projects.deletedAt,
      statusCode: schema.projectStatuses.code,
    }).from(schema.projects)
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .where(eq(schema.projects.id, projectId)).limit(1)
    if (!rows[0] || (!includeArchived && rows[0].deletedAt !== null)) throw new ResourceNotFoundError('Proje bulunamadı.')
    return rows[0]
  }

  private validateParticipation(
    type: schema.ParticipationType,
    enrollmentIds: string[],
    projectType: schema.ProjectType = 'STUDENT',
  ) {
    if (projectType === 'STUDENT') {
      if (type === 'INDIVIDUAL' && enrollmentIds.length !== 1) {
        throw new ProjectRuleError('Bireysel projede tam olarak bir öğrenci olmalıdır.')
      }
      if (type === 'TEAM' && enrollmentIds.length < 2) {
        throw new ProjectRuleError('Takım projesinde en az iki öğrenci olmalıdır.')
      }
    } else {
      if (enrollmentIds.length > 0) {
        if (type === 'INDIVIDUAL' && enrollmentIds.length !== 1) {
          throw new ProjectRuleError('Bireysel projede en fazla bir öğrenci seçilebilir.')
        }
        if (type === 'TEAM' && enrollmentIds.length < 2) {
          throw new ProjectRuleError('Takım projesine en az iki öğrenci seçilmelidir.')
        }
      }
    }
  }

  private buildConflictMessage(conflicts: ProjectConflict[]) {
    return conflicts.map((conflict) => `${conflict.bilsemNo}: “${conflict.title}” (${conflict.status}) – ${conflict.ownerName}`).join('\n')
  }
}
