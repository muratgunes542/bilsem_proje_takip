import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, like, ne, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { assertCanModifyProject, canArchiveProject, canRestoreProject, type AuthenticatedUser, AuthorizationError, ResourceNotFoundError } from '../authorization.js'
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
  participationType: schema.ParticipationType
  teamName?: string | null
  enrollmentIds: string[]
  advisorUserIds?: string[]
}

export type ListProjectsFilters = {
  academicYearId?: string
  categoryId?: string
  statusId?: string
  studentId?: string
  advisorUserId?: string
  includeArchived?: boolean
  search?: string
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
    const [categories, statuses, teachers] = await Promise.all([
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
      const advisorProjectRows = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(and(
          eq(schema.projectAdvisors.userId, filters.advisorUserId),
          isNull(schema.projectAdvisors.deletedAt)
        ))

      const projectsWithActiveAdvisors = await this.database
        .select({ projectId: schema.projectAdvisors.projectId })
        .from(schema.projectAdvisors)
        .where(isNull(schema.projectAdvisors.deletedAt))
      const projectsWithActiveAdvisorsSet = new Set(projectsWithActiveAdvisors.map((r) => r.projectId))

      const legacyAdvisorProjectRows = await this.database
        .select({ projectId: schema.projectStudents.projectId })
        .from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .where(and(
          eq(schema.studentEnrollments.advisorUserId, filters.advisorUserId),
          isNull(schema.projectStudents.deletedAt)
        ))

      const matchingLegacyProjectIds = legacyAdvisorProjectRows
        .map((r) => r.projectId)
        .filter((id) => !projectsWithActiveAdvisorsSet.has(id))

      const projectIds = [...new Set([
        ...advisorProjectRows.map((r) => r.projectId),
        ...matchingLegacyProjectIds,
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
    const [members, advisors, legacyEnrollmentAdvisors] = await Promise.all([
      this.database.select({ projectId: schema.projectStudents.projectId, name: schema.students.firstName, surname: schema.students.lastName })
        .from(schema.projectStudents).innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .innerJoin(schema.students, eq(schema.students.id, schema.studentEnrollments.studentId))
        .where(and(inArray(schema.projectStudents.projectId, ids), isNull(schema.projectStudents.deletedAt))),
      this.database.select({ projectId: schema.projectAdvisors.projectId, userId: schema.projectAdvisors.userId, name: sql<string>`coalesce(${schema.users.name}, 'Bilinmeyen Danışman')` })
        .from(schema.projectAdvisors)
        .leftJoin(schema.users, eq(schema.users.id, schema.projectAdvisors.userId))
        .where(and(inArray(schema.projectAdvisors.projectId, ids), isNull(schema.projectAdvisors.deletedAt))),
      this.database.select({
        projectId: schema.projectStudents.projectId,
        advisorUserId: schema.studentEnrollments.advisorUserId,
        advisorName: schema.studentEnrollments.advisorName,
        teacherName: schema.users.name,
      })
        .from(schema.projectStudents)
        .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
        .leftJoin(schema.users, eq(schema.users.id, schema.studentEnrollments.advisorUserId))
        .where(and(inArray(schema.projectStudents.projectId, ids), isNull(schema.projectStudents.deletedAt))),
    ])
    return projects.map((project) => {
      const projectAdvisorRows = advisors.filter((advisor) => advisor.projectId === project.id)
      const names = new Set<string>()

      if (projectAdvisorRows.length > 0) {
        for (const adv of projectAdvisorRows) {
          if (adv.name) {
            names.add(adv.name)
          }
        }
      } else {
        const legacyRows = legacyEnrollmentAdvisors.filter((l) => l.projectId === project.id)
        const seenUserIds = new Set<string>()
        const seenNames = new Set<string>()
        for (const l of legacyRows) {
          const name = l.teacherName || l.advisorName
          if (!name) continue
          if (l.advisorUserId && seenUserIds.has(l.advisorUserId)) continue
          if (seenNames.has(name.toLocaleLowerCase('tr-TR'))) continue

          if (l.advisorUserId) seenUserIds.add(l.advisorUserId)
          seenNames.add(name.toLocaleLowerCase('tr-TR'))
          names.add(name)
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

    const explicitAdvisors = await this.database
      .select({
        userId: schema.users.id,
        name: sql<string>`coalesce(${schema.users.name}, 'Bilinmeyen Danışman')`,
        email: sql<string>`coalesce(${schema.users.email}, '')`,
        isPrimary: schema.projectAdvisors.isPrimary,
      })
      .from(schema.projectAdvisors)
      .leftJoin(schema.users, eq(schema.users.id, schema.projectAdvisors.userId))
      .where(and(
        eq(schema.projectAdvisors.projectId, projectId),
        isNull(schema.projectAdvisors.deletedAt),
      ))

    const enrollmentAdvisors = await this.database
      .select({
        advisorUserId: schema.studentEnrollments.advisorUserId,
        advisorName: schema.studentEnrollments.advisorName,
        teacherName: schema.users.name,
        teacherEmail: schema.users.email,
      })
      .from(schema.projectStudents)
      .innerJoin(schema.studentEnrollments, eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId))
      .leftJoin(schema.users, eq(schema.users.id, schema.studentEnrollments.advisorUserId))
      .where(and(
        eq(schema.projectStudents.projectId, projectId),
        isNull(schema.projectStudents.deletedAt),
      ))

    const seenUserIds = new Set<string>()
    const seenNames = new Set<string>()
    const combinedAdvisors: Array<{ userId: string; name: string; email: string; isPrimary: boolean }> = []

    if (explicitAdvisors.length > 0) {
      for (const adv of explicitAdvisors) {
        if (adv.userId) seenUserIds.add(adv.userId)
        if (adv.name) seenNames.add(adv.name.toLocaleLowerCase('tr-TR'))
        combinedAdvisors.push({
          userId: adv.userId ?? '',
          name: adv.name,
          email: adv.email ?? '',
          isPrimary: adv.isPrimary,
        })
      }
    } else {
      for (const l of enrollmentAdvisors) {
        const name = l.teacherName || l.advisorName
        if (!name) continue
        const userId = l.advisorUserId ?? `legacy:${name}`

        if (l.advisorUserId && seenUserIds.has(l.advisorUserId)) continue
        if (seenNames.has(name.toLocaleLowerCase('tr-TR'))) continue

        if (l.advisorUserId) seenUserIds.add(l.advisorUserId)
        seenNames.add(name.toLocaleLowerCase('tr-TR'))

        combinedAdvisors.push({
          userId,
          name,
          email: l.teacherEmail ?? '',
          isPrimary: combinedAdvisors.length === 0,
        })
      }
    }

    const advisors = combinedAdvisors

    return {
      project,
      students,
      advisors,
    }
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
    this.validateParticipation(input.participationType, input.enrollmentIds)

    return this.database.transaction(async (transaction) => {
      const uniqueEnrollmentIds = [...new Set(input.enrollmentIds)]
      if (uniqueEnrollmentIds.length !== input.enrollmentIds.length) {
        throw new ProjectRuleError('Aynı öğrenci aynı projeye birden fazla eklenemez.')
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
        .where(and(inArray(schema.studentEnrollments.id, uniqueEnrollmentIds), isNull(schema.studentEnrollments.deletedAt)))

      const selectedEnrollments = enrollmentRows.filter((row) => uniqueEnrollmentIds.includes(row.enrollmentId))
      if (selectedEnrollments.length !== uniqueEnrollmentIds.length) {
        throw new ProjectRuleError('Bir veya daha fazla öğrenci kaydı bulunamadı.')
      }
      if (selectedEnrollments.some((row) => !row.isActive || row.academicYearId !== input.academicYearId)) {
        throw new ProjectRuleError('Öğrenciler yalnızca projenin akademik yılındaki aktif kayıtlardan seçilebilir.')
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
        participationType: input.participationType,
        teamName: input.participationType === 'TEAM' ? input.teamName : null,
      })

      await transaction.insert(schema.projectStudents).values(uniqueEnrollmentIds.map((enrollmentId) => ({
        projectId,
        enrollmentId,
      })))

      if (actor.role === 'TEACHER') {
        if (input.advisorUserIds !== undefined && input.advisorUserIds !== null) {
          throw new ProjectRuleError('Öğretmenler danışman seçimi yapamaz.')
        }
        await this.syncProjectAdvisors(transaction, projectId)
      } else {
        if (input.advisorUserIds !== undefined && input.advisorUserIds !== null && input.advisorUserIds.length > 0) {
          const uniqueAdvisorIds = [...new Set(input.advisorUserIds)]
          const validTeachers = await transaction
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(
              inArray(schema.users.id, uniqueAdvisorIds),
              eq(schema.users.role, 'TEACHER'),
              eq(schema.users.isActive, true),
              isNull(schema.users.deletedAt),
            ))

          if (validTeachers.length !== uniqueAdvisorIds.length) {
            throw new ProjectRuleError('Seçilen danışman aktif bir öğretmen olmalıdır.')
          }

          await transaction.insert(schema.projectAdvisors).values(
            uniqueAdvisorIds.map((userId, index) => ({
              projectId,
              userId,
              isPrimary: index === 0,
            }))
          ).onConflictDoNothing()
        } else {
          await this.syncProjectAdvisors(transaction, projectId)
        }
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
      if (category[0]?.duplicateCheckEnabled && category[0].duplicateRule === 'ACADEMIC_YEAR_STUDENT_CATEGORY') {
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
        afterJson: JSON.stringify({ ...input, enrollmentIds: uniqueEnrollmentIds }),
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
  async syncProjectAdvisors(
    databaseOrProjectId: AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0] | string,
    projectId?: string,
    creatorId?: string,
  ) {
    const database = typeof databaseOrProjectId === 'string' ? this.database : databaseOrProjectId
    const targetProjectId = typeof databaseOrProjectId === 'string' ? databaseOrProjectId : projectId!

    const project = await this.getProject(database, targetProjectId, true)
    const effectiveCreatorId = creatorId || project.createdBy

    // Projenin aktif üyelerini ve geçerli danışmanlarını al.
    const memberAdvisors = await database
      .select({
        enrollmentId: schema.projectStudents.enrollmentId,
        advisorUserId: schema.users.id,
      })
      .from(schema.projectStudents)
      .innerJoin(
        schema.studentEnrollments,
        eq(schema.studentEnrollments.id, schema.projectStudents.enrollmentId),
      )
      .leftJoin(
        schema.users,
        and(
          eq(schema.users.id, schema.studentEnrollments.advisorUserId),
          eq(schema.users.role, 'TEACHER'),
          eq(schema.users.isActive, true),
          isNull(schema.users.deletedAt),
        ),
      )
      .where(and(
        eq(schema.projectStudents.projectId, targetProjectId),
        isNull(schema.projectStudents.deletedAt),
        isNull(schema.studentEnrollments.deletedAt),
        eq(schema.studentEnrollments.isActive, true),
      ))

    // Mevcut danışmanları koru.
    const existingRows = await database
      .select({
        userId: schema.projectAdvisors.userId,
      })
      .from(schema.projectAdvisors)
      .where(and(
        eq(schema.projectAdvisors.projectId, targetProjectId),
        isNull(schema.projectAdvisors.deletedAt),
      ))

    const existingIds = new Set(existingRows.map((row) => row.userId))
    const requiredIds = new Set<string>()

    // Danışmanı olmayan öğrenciler için proje sahibini yedek danışman olarak değerlendir.
    const hasStudentWithoutAdvisor = memberAdvisors.some(
      (row) => !row.advisorUserId,
    )

    for (const row of memberAdvisors) {
      if (row.advisorUserId) {
        requiredIds.add(row.advisorUserId)
      }
    }

    if ((hasStudentWithoutAdvisor || requiredIds.size === 0) && effectiveCreatorId) {
      const creatorTeacher = await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(
          eq(schema.users.id, effectiveCreatorId),
          eq(schema.users.role, 'TEACHER'),
          eq(schema.users.isActive, true),
          isNull(schema.users.deletedAt),
        ))
        .limit(1)

      if (creatorTeacher[0]) {
        requiredIds.add(creatorTeacher[0].id)
      }
    }

    const missingIds = [...requiredIds].filter((id) => !existingIds.has(id))

    if (missingIds.length > 0) {
      await database
        .insert(schema.projectAdvisors)
        .values(missingIds.map((userId) => ({
          projectId: targetProjectId,
          userId,
          isPrimary: existingIds.size === 0 && missingIds[0] === userId,
        })))
        .onConflictDoUpdate({
          target: [schema.projectAdvisors.projectId, schema.projectAdvisors.userId],
          set: {
            deletedAt: null,
            deletedBy: null,
            updatedAt: new Date(),
          },
        })
    }
  }

  private async attachEnrollmentAdvisors(
    database: AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0],
    projectId: string,
    enrollmentIds: string[],
    creatorId: string,
  ) {
    if (enrollmentIds.length === 0) return

    const existingAdvisors = await database
      .select({
        userId: schema.projectAdvisors.userId,
        isPrimary: schema.projectAdvisors.isPrimary,
      })
      .from(schema.projectAdvisors)
      .where(and(
        eq(schema.projectAdvisors.projectId, projectId),
        isNull(schema.projectAdvisors.deletedAt),
      ))

    const existingAdvisorIds = new Set(existingAdvisors.map((row) => row.userId))
    const advisorsToAdd = new Set<string>()

    const memberAdvisors = await database
      .select({
        enrollmentId: schema.studentEnrollments.id,
        advisorUserId: schema.users.id,
      })
      .from(schema.studentEnrollments)
      .leftJoin(
        schema.users,
        and(
          eq(schema.users.id, schema.studentEnrollments.advisorUserId),
          eq(schema.users.role, 'TEACHER'),
          eq(schema.users.isActive, true),
          isNull(schema.users.deletedAt),
        ),
      )
      .where(and(
        inArray(schema.studentEnrollments.id, enrollmentIds),
        isNull(schema.studentEnrollments.deletedAt),
        eq(schema.studentEnrollments.isActive, true),
      ))

    let hasStudentWithoutAdvisor = false

    for (const row of memberAdvisors) {
      if (row.advisorUserId) {
        if (!existingAdvisorIds.has(row.advisorUserId)) {
          advisorsToAdd.add(row.advisorUserId)
        }
      } else {
        hasStudentWithoutAdvisor = true
      }
    }

    if (hasStudentWithoutAdvisor && creatorId && !existingAdvisorIds.has(creatorId) && !advisorsToAdd.has(creatorId)) {
      const creatorTeacher = await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(
          eq(schema.users.id, creatorId),
          eq(schema.users.role, 'TEACHER'),
          eq(schema.users.isActive, true),
          isNull(schema.users.deletedAt),
        ))
        .limit(1)

      if (creatorTeacher[0]) {
        advisorsToAdd.add(creatorTeacher[0].id)
      }
    }

    let hasExistingPrimary = existingAdvisors.some((a) => a.isPrimary)
    for (const userId of advisorsToAdd) {
      const isPrimary = !hasExistingPrimary
      await database
        .insert(schema.projectAdvisors)
        .values({
          projectId,
          userId,
          isPrimary,
        })
        .onConflictDoUpdate({
          target: [schema.projectAdvisors.projectId, schema.projectAdvisors.userId],
          set: {
            deletedAt: null,
            deletedBy: null,
            updatedAt: new Date(),
          },
        })
      if (isPrimary) {
        hasExistingPrimary = true
      }
    }
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

        await this.attachEnrollmentAdvisors(transaction, projectId, [enrollmentId], project.createdBy)
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

      await this.attachEnrollmentAdvisors(transaction, projectId, uniqueAdditionalIds, project.createdBy)

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

  private async getProject(database: AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0], projectId: string, includeArchived = false) {
    const rows = await database.select({
      id: schema.projects.id,
      title: schema.projects.title,
      createdBy: schema.projects.createdBy,
      academicYearId: schema.projects.academicYearId,
      categoryId: schema.projects.categoryId,
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

  private validateParticipation(type: schema.ParticipationType, enrollmentIds: string[]) {
    if (type === 'INDIVIDUAL' && enrollmentIds.length !== 1) throw new ProjectRuleError('Bireysel projede tam olarak bir öğrenci olmalıdır.')
    if (type === 'TEAM' && enrollmentIds.length < 2) throw new ProjectRuleError('Takım projesinde en az iki öğrenci olmalıdır.')
  }

  private buildConflictMessage(conflicts: ProjectConflict[]) {
    return conflicts.map((conflict) => `${conflict.bilsemNo}: “${conflict.title}” (${conflict.status}) – ${conflict.ownerName}`).join('\n')
  }
}
