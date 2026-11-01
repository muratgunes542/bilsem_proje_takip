import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AuthorizationError } from '../authorization'
import { db } from '../db/client'
import { AcademicYearService } from '../services/academic-year-service'
import { StudentImportService } from '../services/import-service'
import { NotificationService } from '../services/notification-service'
import { ProjectRuleError, ProjectService } from '../services/project-service'
import { StudentService } from '../services/student-service'
import { UserService } from '../services/user-service'
import { getAuthenticatedApiUser } from './context'
import type { ApiResponse } from './types'
import type { AppDatabase } from '../services/project-service'
import { env } from '../env'
import { ImportFileError, parseStudentWorkbook } from '../services/xlsx-import-parser'

// Zod Schemas
const createAcademicYearSchema = z.object({
  name: z.string().trim().min(1, 'Akademik yıl adı zorunludur.').max(100),
  startsOn: z.iso.date().transform((val) => new Date(`${val}T00:00:00.000Z`)),
  endsOn: z.iso.date().transform((val) => new Date(`${val}T00:00:00.000Z`)),
  isCurrent: z.boolean().optional(),
}).refine((value) => value.endsOn > value.startsOn, { message: 'Bitiş tarihi başlangıç tarihinden sonra olmalıdır.', path: ['endsOn'] })

const createProjectSchema = z.object({
  title: z.string().trim().min(1, 'Proje başlığı zorunludur.').max(200),
  description: z.string().max(10000).nullable().optional(),
  academicYearId: z.string().min(1),
  categoryId: z.string().min(1),
  statusId: z.string().min(1),
  participationType: z.enum(['INDIVIDUAL', 'TEAM']),
  teamName: z.string().nullable().optional(),
  enrollmentIds: z.array(z.string().min(1)).min(1, 'En az bir öğrenci seçilmelidir.').max(50),
})

const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10000).nullable().optional(),
  statusId: z.string().optional(),
  teamName: z.string().nullable().optional(),
})

const addTeamMemberSchema = z.object({
  enrollmentId: z.string().min(1, 'Öğrenci kayıt ID zorunludur.'),
})

const updateUserSchema = z.object({
  role: z.enum(['ADMIN', 'TEACHER']).optional(),
  isActive: z.boolean().optional(),
})

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

const resolveAdvisorSchema = z.object({ advisorUserId: z.string().min(1) }).strict()

export type ApiRequest = {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

export async function handleApiRequest(req: ApiRequest, database: AppDatabase = db): Promise<{ statusCode: number; payload: ApiResponse }> {
  const parsedUrl = new URL(req.url, 'http://localhost')
  const pathname = parsedUrl.pathname.replace(/\/$/, '')
  const method = req.method.toUpperCase()

  try {
    const user = await getAuthenticatedApiUser(req, database)
    const userService = new UserService(database)
    const academicYearService = new AcademicYearService(database)
    const studentService = new StudentService(database)
    const projectService = new ProjectService(database)
    const notificationService = new NotificationService(database)
    const importService = new StudentImportService(database)
    const requireAuth = () => {
      if (!user) throw new AuthorizationError('Oturum açmanız gerekiyor.', 401)
      if (!user.isActive) throw new AuthorizationError('Hesabınız pasif durumdadır.', 403)
      return user
    }
    // -------------------------------------------------------------
    // A. Session & Users
    // -------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/me') {
      const actor = requireAuth()
      const profile = await userService.getCurrentUserProfile(actor)
      return { statusCode: 200, payload: { success: true, data: profile } }
    }

    if (method === 'GET' && pathname === '/api/admin/users') {
      const actor = requireAuth()
      const { page, pageSize } = paginationSchema.parse(Object.fromEntries(parsedUrl.searchParams))
      const search = parsedUrl.searchParams.get('search') ?? undefined
      const role = parsedUrl.searchParams.get('role') ? z.enum(['ADMIN', 'TEACHER']).parse(parsedUrl.searchParams.get('role')) : undefined

      const result = await userService.listUsers(actor, { page, pageSize, search, role })
      return {
        statusCode: 200,
        payload: { success: true, data: result.users, pagination: result.pagination },
      }
    }

    const updateUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (method === 'PATCH' && updateUserMatch) {
      const actor = requireAuth()
      const targetUserId = updateUserMatch[1]!
      const body = updateUserSchema.parse(req.body)
      const updated = await userService.updateUserStatus(actor, targetUserId, body)
      return { statusCode: 200, payload: { success: true, data: updated } }
    }

    // -------------------------------------------------------------
    // B. Students
    // -------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/students') {
      const actor = requireAuth()
      const { page, pageSize } = paginationSchema.parse(Object.fromEntries(parsedUrl.searchParams))
      const search = parsedUrl.searchParams.get('search') ?? undefined
      const academicYearId = parsedUrl.searchParams.get('academicYearId') ?? undefined
      const talentArea = parsedUrl.searchParams.get('talentArea') ?? undefined
      const advisorName = parsedUrl.searchParams.get('advisorName') ?? undefined

      const result = await studentService.listStudents(actor, {
        page, pageSize, search, academicYearId, talentArea, advisorName,
      })
      return {
        statusCode: 200,
        payload: { success: true, data: result.students, pagination: result.pagination },
      }
    }

    const studentHistoryMatch = pathname.match(/^\/api\/students\/([^/]+)\/history$/)
    if (method === 'GET' && studentHistoryMatch) {
      const actor = requireAuth()
      const studentId = studentHistoryMatch[1]!
      const history = await studentService.getProjectHistory(actor, studentId)
      return { statusCode: 200, payload: { success: true, data: history } }
    }

    const studentProfileMatch = pathname.match(/^\/api\/students\/([^/]+)$/)
    if (method === 'GET' && studentProfileMatch) {
      const actor = requireAuth()
      const studentId = studentProfileMatch[1]!
      const profile = await studentService.getStudentProfile(actor, studentId)
      return { statusCode: 200, payload: { success: true, data: profile } }
    }

    // -------------------------------------------------------------
    // C. Academic Years
    // -------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/academic-years') {
      const actor = requireAuth()
      const years = await academicYearService.listAcademicYears(actor)
      return { statusCode: 200, payload: { success: true, data: years } }
    }

    if (method === 'GET' && pathname === '/api/academic-years/current') {
      const actor = requireAuth()
      const current = await academicYearService.getCurrentAcademicYear(actor)
      return { statusCode: 200, payload: { success: true, data: current } }
    }

    if (method === 'POST' && pathname === '/api/academic-years') {
      const actor = requireAuth()
      const input = createAcademicYearSchema.parse(req.body)
      const created = await academicYearService.createAcademicYear(actor, input)
      return { statusCode: 201, payload: { success: true, data: created } }
    }

    // -------------------------------------------------------------
    // D. Projects
    // -------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/projects') {
      const actor = requireAuth()
      const { page, pageSize } = paginationSchema.parse(Object.fromEntries(parsedUrl.searchParams))
      const academicYearId = parsedUrl.searchParams.get('academicYearId') ?? undefined
      const categoryId = parsedUrl.searchParams.get('categoryId') ?? undefined
      const statusId = parsedUrl.searchParams.get('statusId') ?? undefined
      const studentId = parsedUrl.searchParams.get('studentId') ?? undefined
      const advisorUserId = parsedUrl.searchParams.get('advisorUserId') ?? undefined
      const includeArchived = parsedUrl.searchParams.get('includeArchived') === 'true'

      const list = await projectService.listProjects(actor, {
        academicYearId, categoryId, statusId, studentId, advisorUserId, includeArchived,
      })
      const paged = list.slice((page - 1) * pageSize, page * pageSize)
      return { statusCode: 200, payload: { success: true, data: paged, pagination: {
        page, pageSize, total: list.length, totalPages: Math.ceil(list.length / pageSize),
      } } }
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const actor = requireAuth()
      const input = createProjectSchema.parse(req.body)
      const result = await projectService.createProject(actor, input)
      return { statusCode: 201, payload: { success: true, data: result } }
    }

    const archiveProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)\/archive$/)
    if (method === 'POST' && archiveProjectMatch) {
      const actor = requireAuth()
      const projectId = archiveProjectMatch[1]!
      await projectService.archiveProject(actor, projectId)
      return { statusCode: 200, payload: { success: true, data: { message: 'Proje arşivlendi.' } } }
    }

    const restoreProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)\/restore$/)
    if (method === 'POST' && restoreProjectMatch) {
      const actor = requireAuth()
      const projectId = restoreProjectMatch[1]!
      await projectService.restoreProject(actor, projectId)
      return { statusCode: 200, payload: { success: true, data: { message: 'Proje geri yüklendi.' } } }
    }

    // -------------------------------------------------------------
    // E. Team Membership
    // -------------------------------------------------------------
    const projectMembersMatch = pathname.match(/^\/api\/projects\/([^/]+)\/members$/)
    if (method === 'GET' && projectMembersMatch) {
      const actor = requireAuth()
      const projectId = projectMembersMatch[1]!
      const members = await projectService.getProjectMembers(actor, projectId)
      return { statusCode: 200, payload: { success: true, data: members } }
    }

    if (method === 'POST' && projectMembersMatch) {
      const actor = requireAuth()
      const projectId = projectMembersMatch[1]!
      const body = addTeamMemberSchema.parse(req.body)
      const result = await projectService.addTeamMember(actor, projectId, body.enrollmentId)
      return { statusCode: 200, payload: { success: true, data: result } }
    }

    const removeTeamMemberMatch = pathname.match(/^\/api\/projects\/([^/]+)\/members\/([^/]+)$/)
    if (method === 'DELETE' && removeTeamMemberMatch) {
      const actor = requireAuth()
      const projectId = removeTeamMemberMatch[1]!
      const enrollmentId = removeTeamMemberMatch[2]!
      const result = await projectService.removeTeamMember(actor, projectId, enrollmentId)
      return { statusCode: 200, payload: { success: true, data: result } }
    }

    // Project Detail, Update, Archive (DELETE /api/projects/:id)
    const projectDetailMatch = pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (projectDetailMatch) {
      const actor = requireAuth()
      const projectId = projectDetailMatch[1]!

      if (method === 'GET') {
        const detail = await projectService.getProjectDetail(actor, projectId)
        return { statusCode: 200, payload: { success: true, data: detail } }
      }

      if (method === 'PATCH') {
        const changes = updateProjectSchema.parse(req.body)
        await projectService.updateProject(actor, projectId, changes)
        return { statusCode: 200, payload: { success: true, data: { message: 'Proje güncellendi.' } } }
      }

      if (method === 'DELETE') {
        await projectService.archiveProject(actor, projectId)
        return { statusCode: 200, payload: { success: true, data: { message: 'Proje arşivlendi.' } } }
      }
    }

    // -------------------------------------------------------------
    // F. Notifications
    // -------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/notifications') {
      const actor = requireAuth()
      const { page, pageSize } = paginationSchema.parse(Object.fromEntries(parsedUrl.searchParams))
      const unreadOnly = z.enum(['true', 'false']).default('false').parse(parsedUrl.searchParams.get('unreadOnly') ?? undefined) === 'true'
      const result = await notificationService.listForUser(actor, { page, pageSize, unreadOnly })
      return { statusCode: 200, payload: { success: true, data: result.notifications, pagination: result.pagination } }
    }

    const markNotificationReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
    if (method === 'PATCH' && markNotificationReadMatch) {
      const actor = requireAuth()
      const notificationId = markNotificationReadMatch[1]!
      await notificationService.markAsRead(actor, notificationId)
      return { statusCode: 200, payload: { success: true, data: { message: 'Bildirim okundu işaretlendi.' } } }
    }

    // -------------------------------------------------------------
    // G. Excel Import
    // -------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/imports/preview') {
      const actor = requireAuth()
      if (actor.role !== 'ADMIN') throw new AuthorizationError('Excel aktarımı için yönetici yetkisi gerekir.')
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
      if (contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        throw new ImportFileError('Content-Type must be the XLSX spreadsheet media type.')
      }
      if (!Buffer.isBuffer(req.body)) throw new ImportFileError('XLSX dosyasının ikili gövdesi gönderilmelidir.')
      if (req.body.length > env.IMPORT_MAX_FILE_BYTES) throw new ImportFileError(`Dosya boyutu ${env.IMPORT_MAX_FILE_BYTES} bayt sınırını aşıyor.`, 413)
      const fileName = String(req.headers['x-file-name'] ?? '')
      if (!fileName.toLowerCase().endsWith('.xlsx')) throw new ImportFileError('Yalnızca .xlsx uzantılı dosyalar kabul edilir.')
      const academicYearId = z.string().min(1).parse(parsedUrl.searchParams.get('academicYearId'))
      const { records, warnings } = await parseStudentWorkbook(req.body)
      const preview = await importService.previewImport(actor, academicYearId, fileName, records, warnings)
      return { statusCode: 200, payload: { success: true, data: preview } }
    }

    const importBatchRowsMatch = pathname.match(/^\/api\/imports\/([^/]+)\/rows$/)
    if (method === 'GET' && importBatchRowsMatch) {
      const actor = requireAuth()
      const { page, pageSize } = paginationSchema.parse(Object.fromEntries(parsedUrl.searchParams))
      const result = await importService.listBatchRows(actor, importBatchRowsMatch[1]!, { page, pageSize })
      return { statusCode: 200, payload: { success: true, data: result.rows, pagination: result.pagination } }
    }

    const importAdvisorMatch = pathname.match(/^\/api\/imports\/([^/]+)\/rows\/([^/]+)\/advisor$/)
    if (method === 'PATCH' && importAdvisorMatch) {
      const actor = requireAuth()
      const input = resolveAdvisorSchema.parse(req.body)
      const result = await importService.resolveAdvisor(actor, importAdvisorMatch[1]!, importAdvisorMatch[2]!, input.advisorUserId)
      return { statusCode: 200, payload: { success: true, data: result } }
    }

    const cancelImportMatch = pathname.match(/^\/api\/imports\/([^/]+)\/cancel$/)
    if (method === 'POST' && cancelImportMatch) {
      const actor = requireAuth()
      const result = await importService.cancelImport(actor, cancelImportMatch[1]!)
      return { statusCode: 200, payload: { success: true, data: result } }
    }

    const importBatchMatch = pathname.match(/^\/api\/imports\/([^/]+)$/)
    if (method === 'GET' && importBatchMatch) {
      const actor = requireAuth()
      const batch = await importService.getBatch(actor, importBatchMatch[1]!)
      return { statusCode: 200, payload: { success: true, data: batch } }
    }

    const commitImportMatch = pathname.match(/^\/api\/imports\/([^/]+)\/commit$/)
    if (method === 'POST' && commitImportMatch) {
      const actor = requireAuth()
      const batchId = commitImportMatch[1]!
      const commitResult = await importService.commitImport(actor, batchId)
      return { statusCode: 200, payload: { success: true, data: commitResult } }
    }

    return {
      statusCode: 404,
      payload: { success: false, error: { code: 'NOT_FOUND', message: 'API ucu bulunamadı.' } },
    }
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return {
        statusCode: 400,
        payload: {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Geçersiz veri gönderildi.',
            details: err.flatten(),
          },
        },
      }
    }

    if (err instanceof AuthorizationError) {
      const code = err.statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN'
      return {
        statusCode: err.statusCode,
        payload: {
          success: false,
          error: {
            code,
            message: err.message,
          },
        },
      }
    }

    if (err instanceof ProjectRuleError) {
      return {
        statusCode: err.statusCode,
        payload: {
          success: false,
          error: {
            code: 'BUSINESS_RULE_ERROR',
            message: err.message,
          },
        },
      }
    }

    const status = err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500
    return {
      statusCode: status,
      payload: {
        success: false,
        error: {
          code: status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'VALIDATION_ERROR' : status === 422 ? 'BUSINESS_RULE_ERROR' : 'INTERNAL_SERVER_ERROR',
          message: status >= 500 ? 'Sunucu hatası oluştu.' : (err instanceof Error ? err.message : 'İstek işlenemedi.'),
        },
      },
    }
  }
}

// Node HTTP ServerResponse helper for Vercel / Node server functions
export async function dispatchNodeApi(req: IncomingMessage, res: ServerResponse, bodyOverride?: unknown, database: AppDatabase = db) {
  let body = bodyOverride
  if (body === undefined && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT')) {
    const isImportUpload = (req.url ?? '').split('?')[0] === '/api/imports/preview' && req.method === 'POST'
    const maxBytes = isImportUpload ? env.IMPORT_MAX_FILE_BYTES : 2 * 1024 * 1024
    body = await new Promise((resolve) => {
      const chunks: Buffer[] = []
      let byteLength = 0
      let tooLarge = false
      req.on('data', (chunk) => {
        if (tooLarge) return
        const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        byteLength += content.length
        if (byteLength > maxBytes) {
          tooLarge = true
          resolve({ __payloadTooLarge: true })
          return
        }
        chunks.push(content)
      })
      req.on('end', () => {
        if (tooLarge) return
        const data = Buffer.concat(chunks)
        if (isImportUpload) {
          resolve(data)
          return
        }
        try {
          resolve(data.length ? JSON.parse(data.toString('utf8')) : {})
        } catch {
          resolve({ __invalidJson: true })
        }
      })
    })
  }

  if (body && typeof body === 'object' && '__payloadTooLarge' in body) {
    res.statusCode = 413
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'İstek gövdesi izin verilen boyutu aşıyor.' } }))
    return
  }
  if (body && typeof body === 'object' && '__invalidJson' in body) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'İstek gövdesi geçerli JSON değil.' } }))
    return
  }

  const { statusCode, payload } = await handleApiRequest({
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    headers: req.headers,
    body,
  }, database)

  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}
