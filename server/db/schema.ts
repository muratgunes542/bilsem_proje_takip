import { relations, sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const userRoles = ['ADMIN', 'TEACHER'] as const
export const projectCategoryCodes = [
  'TUBITAK_2204_A',
  'TUBITAK_2204_B',
  'TUBITAK_4004',
  'TUBITAK_4006',
  'ETWINNING',
  'IP_RIGHTS',
  'SPECIAL_PROJECT',
  'SPECIAL_COMPETITION',
] as const
export const importRowStatuses = ['PENDING', 'VALID', 'INVALID', 'IMPORTED'] as const
export const importBatchStatuses = ['UPLOADED', 'VALIDATING', 'READY', 'IMPORTED', 'FAILED', 'CANCELLED'] as const
export const importResultTypes = [
  'NEW_STUDENT',
  'CONTINUING_STUDENT',
  'ADVISOR_CHANGED',
  'TALENT_AREA_CHANGED',
  'ADVISOR_AND_TALENT_CHANGED',
  'UNMATCHED_TEACHER',
  'NOT_IN_CURRENT_IMPORT',
  'INVALID_RECORD',
  'DUPLICATE_BILSEM_NO',
  'UNEXPECTED_COLUMN',
  'UNEXPECTED_ROW',
] as const
export const participationTypes = ['INDIVIDUAL', 'TEAM'] as const
export const notificationTypes = [
  'DUPLICATE_PROJECT_WARNING',
  'TEAM_MEMBER_ADDED',
  'TEAM_MEMBER_PROJECT_CONFLICT',
  'PROJECT_STATUS_UPDATED',
] as const

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}

const softDelete = {
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  deletedBy: text('deleted_by'),
}

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  role: text('role', { enum: userRoles }).notNull().default('TEACHER'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
  ...softDelete,
}, (table) => [
  index('users_role_idx').on(table.role),
  index('users_deleted_at_idx').on(table.deletedAt),
])

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
  ...timestamps,
}, (table) => [index('sessions_user_id_idx').on(table.userId)])

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  ...timestamps,
}, (table) => [
  index('accounts_user_id_idx').on(table.userId),
  uniqueIndex('accounts_provider_account_uidx').on(table.providerId, table.accountId),
])

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ...timestamps,
}, (table) => [index('verifications_identifier_idx').on(table.identifier)])

export const students = sqliteTable('students', {
  id: text('id').primaryKey(),
  bilsemNo: text('bilsem_no').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  ...timestamps,
  ...softDelete,
}, (table) => [index('students_deleted_at_idx').on(table.deletedAt)])

export const academicYears = sqliteTable('academic_years', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  startsOn: integer('starts_on', { mode: 'timestamp_ms' }).notNull(),
  endsOn: integer('ends_on', { mode: 'timestamp_ms' }).notNull(),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
  ...softDelete,
}, (table) => [index('academic_years_current_idx').on(table.isCurrent)])

export const studentEnrollments = sqliteTable('student_enrollments', {
  id: text('id').primaryKey(),
  studentId: text('student_id').notNull().references(() => students.id, { onDelete: 'restrict' }),
  academicYearId: text('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'restrict' }),
  schoolName: text('school_name'),
  gradeLevel: integer('grade_level'),
  className: text('class_name'),
  advisorName: text('advisor_name'),
  advisorUserId: text('advisor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  talentArea: text('talent_area'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
  ...softDelete,
}, (table) => [
  uniqueIndex('student_enrollments_student_year_uidx').on(table.studentId, table.academicYearId),
  index('student_enrollments_year_idx').on(table.academicYearId),
])

export const projectCategories = sqliteTable('project_categories', {
  id: text('id').primaryKey(),
  code: text('code', { enum: projectCategoryCodes }).notNull().unique(),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  duplicateCheckEnabled: integer('duplicate_check_enabled', { mode: 'boolean' }).notNull().default(false),
  duplicateRule: text('duplicate_rule').notNull().default('ACADEMIC_YEAR_STUDENT_CATEGORY'),
  ...timestamps,
  ...softDelete,
})

export const projectStatuses = sqliteTable('project_statuses', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
  ...softDelete,
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  academicYearId: text('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'restrict' }),
  categoryId: text('category_id').notNull().references(() => projectCategories.id, { onDelete: 'restrict' }),
  statusId: text('status_id').notNull().references(() => projectStatuses.id, { onDelete: 'restrict' }),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  participationType: text('participation_type', { enum: participationTypes }).notNull().default('INDIVIDUAL'),
  teamName: text('team_name'),
  ...timestamps,
  ...softDelete,
}, (table) => [
  index('projects_created_by_idx').on(table.createdBy),
  index('projects_academic_year_idx').on(table.academicYearId),
  index('projects_status_idx').on(table.statusId),
  index('projects_deleted_at_idx').on(table.deletedAt),
])

export const projectStudents = sqliteTable('project_students', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  enrollmentId: text('enrollment_id').notNull().references(() => studentEnrollments.id, { onDelete: 'restrict' }),
  ...timestamps,
  ...softDelete,
}, (table) => [
  primaryKey({ columns: [table.projectId, table.enrollmentId] }),
  index('project_students_enrollment_idx').on(table.enrollmentId),
])

export const projectDuplicateClaims = sqliteTable('project_duplicate_claims', {
  academicYearId: text('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'restrict' }),
  studentId: text('student_id').notNull().references(() => students.id, { onDelete: 'restrict' }),
  categoryId: text('category_id').notNull().references(() => projectCategories.id, { onDelete: 'restrict' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  primaryKey({ columns: [table.academicYearId, table.studentId, table.categoryId] }),
  index('project_duplicate_claims_project_idx').on(table.projectId),
])

export const projectAdvisors = sqliteTable('project_advisors', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
  ...softDelete,
}, (table) => [
  primaryKey({ columns: [table.projectId, table.userId] }),
  index('project_advisors_user_idx').on(table.userId),
])

export const projectStatusHistory = sqliteTable('project_status_history', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  fromStatusId: text('from_status_id').references(() => projectStatuses.id, { onDelete: 'restrict' }),
  toStatusId: text('to_status_id').notNull().references(() => projectStatuses.id, { onDelete: 'restrict' }),
  changedBy: text('changed_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [index('project_status_history_project_idx').on(table.projectId)])

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  requestId: text('request_id'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('audit_logs_entity_idx').on(table.entityType, table.entityId),
  index('audit_logs_actor_idx').on(table.actorUserId),
  index('audit_logs_created_at_idx').on(table.createdAt),
])

export const projectAttachments = sqliteTable('project_attachments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  storageKey: text('storage_key').notNull().unique(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: text('uploaded_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  ...timestamps,
  ...softDelete,
}, (table) => [index('project_attachments_project_idx').on(table.projectId)])

export const importBatches = sqliteTable('import_batches', {
  id: text('id').primaryKey(),
  academicYearId: text('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'restrict' }),
  fileName: text('file_name').notNull(),
  status: text('status', { enum: importBatchStatuses }).notNull().default('UPLOADED'),
  totalRows: integer('total_rows').notNull().default(0),
  validRows: integer('valid_rows').notNull().default(0),
  invalidRows: integer('invalid_rows').notNull().default(0),
  newStudentCount: integer('new_student_count').notNull().default(0),
  continuingStudentCount: integer('continuing_student_count').notNull().default(0),
  changedCount: integer('changed_count').notNull().default(0),
  warningsJson: text('warnings_json'),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  approvedBy: text('approved_by').references(() => users.id, { onDelete: 'restrict' }),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  ...timestamps,
  ...softDelete,
}, (table) => [index('import_batches_year_idx').on(table.academicYearId)])

export const importRows = sqliteTable('import_rows', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull().references(() => importBatches.id, { onDelete: 'restrict' }),
  rowNumber: integer('row_number').notNull(),
  rawJson: text('raw_json').notNull(),
  normalizedJson: text('normalized_json'),
  status: text('status', { enum: importRowStatuses }).notNull().default('PENDING'),
  resultType: text('result_type', { enum: importResultTypes }),
  matchedAdvisorUserId: text('matched_advisor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  isSourceRow: integer('is_source_row', { mode: 'boolean' }).notNull().default(true),
  errorMessage: text('error_message'),
  studentId: text('student_id').references(() => students.id, { onDelete: 'restrict' }),
  enrollmentId: text('enrollment_id').references(() => studentEnrollments.id, { onDelete: 'restrict' }),
  ...timestamps,
}, (table) => [
  uniqueIndex('import_rows_batch_row_uidx').on(table.batchId, table.rowNumber),
  index('import_rows_status_idx').on(table.status),
  index('import_rows_result_type_idx').on(table.resultType),
])

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
  type: text('type', { enum: notificationTypes }).notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index('notifications_recipient_read_idx').on(table.recipientId, table.isRead),
  index('notifications_project_idx').on(table.projectId),
])

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  createdProjects: many(projects),
  advisedProjects: many(projectAdvisors),
  notifications: many(notifications),
}))

export const studentsRelations = relations(students, ({ many }) => ({ enrollments: many(studentEnrollments) }))
export const academicYearsRelations = relations(academicYears, ({ many }) => ({ enrollments: many(studentEnrollments), projects: many(projects) }))
export const projectsRelations = relations(projects, ({ one, many }) => ({
  academicYear: one(academicYears, { fields: [projects.academicYearId], references: [academicYears.id] }),
  category: one(projectCategories, { fields: [projects.categoryId], references: [projectCategories.id] }),
  status: one(projectStatuses, { fields: [projects.statusId], references: [projectStatuses.id] }),
  creator: one(users, { fields: [projects.createdBy], references: [users.id] }),
  students: many(projectStudents),
  advisors: many(projectAdvisors),
  statusHistory: many(projectStatusHistory),
  attachments: many(projectAttachments),
  notifications: many(notifications),
}))

export type UserRole = (typeof userRoles)[number]
export type ProjectCategoryCode = (typeof projectCategoryCodes)[number]
export type ParticipationType = (typeof participationTypes)[number]
export type NotificationType = (typeof notificationTypes)[number]
export type ImportResultType = (typeof importResultTypes)[number]
export type ImportRowStatus = (typeof importRowStatuses)[number]
