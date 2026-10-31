import { randomUUID } from 'node:crypto'
import { and, eq, isNull, ne } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { assertCanModifyProject, canArchiveProject, canRestoreProject, type AuthenticatedUser, AuthorizationError } from '../authorization'
import * as schema from '../db/schema'

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

  async createProject(actor: AuthenticatedUser, input: CreateProjectInput) {
    if (!actor.isActive) throw new AuthorizationError()
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
        .where(isNull(schema.studentEnrollments.deletedAt))

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

      const category = await transaction
        .select({ duplicateCheckEnabled: schema.projectCategories.duplicateCheckEnabled })
        .from(schema.projectCategories)
        .where(eq(schema.projectCategories.id, input.categoryId))
        .limit(1)

      const conflicts: ProjectConflict[] = []
      if (category[0]?.duplicateCheckEnabled) {
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
        await transaction.update(schema.projectStudents).set({ deletedAt: new Date(), deletedBy: actor.id, updatedAt: new Date() })
          .where(and(eq(schema.projectStudents.projectId, projectId), eq(schema.projectStudents.enrollmentId, enrollmentId)))
      }

      let memberConflict: { projectId: string; title: string; ownerId: string; ownerName: string } | undefined
      if (operation === 'ADD') {
        const category = await transaction.select({ enabled: schema.projectCategories.duplicateCheckEnabled })
          .from(schema.projectCategories).where(eq(schema.projectCategories.id, project.categoryId)).limit(1)
        if (category[0]?.enabled) {
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

  private async getProject(database: AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0], projectId: string, includeArchived = false) {
    const rows = await database.select({
      id: schema.projects.id,
      title: schema.projects.title,
      createdBy: schema.projects.createdBy,
      academicYearId: schema.projects.academicYearId,
      categoryId: schema.projects.categoryId,
      participationType: schema.projects.participationType,
      deletedAt: schema.projects.deletedAt,
      statusCode: schema.projectStatuses.code,
    }).from(schema.projects)
      .innerJoin(schema.projectStatuses, eq(schema.projectStatuses.id, schema.projects.statusId))
      .where(eq(schema.projects.id, projectId)).limit(1)
    if (!rows[0] || (!includeArchived && rows[0].deletedAt !== null)) throw new ProjectRuleError('Proje bulunamadı.')
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
