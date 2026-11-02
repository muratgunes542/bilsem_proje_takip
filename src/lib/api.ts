export type Role = 'ADMIN' | 'TEACHER'

export type UserProfile = {
  id: string
  name: string
  email: string
  role: Role
  isActive: boolean
  mustChangePassword?: boolean
  createdAt?: string
}

export type ApiPage<T> = {
  data: T[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

export type AcademicYear = {
  id: string
  name: string
  startsOn: string
  endsOn: string
  isCurrent: boolean
}

export type Student = {
  enrollmentId: string
  studentId: string
  bilsemNo: string
  firstName: string
  lastName: string
  academicYearId: string
  schoolName: string | null
  gradeLevel: number | null
  className: string | null
  advisorName: string | null
  talentArea: string | null
  isActive: boolean
}

export type StudentEnrollment = {
  enrollmentId: string
  academicYearId: string
  academicYearName: string
  isCurrentAcademicYear: boolean
  schoolName: string | null
  gradeLevel: number | null
  className: string | null
  advisorName: string | null
  advisorUserId: string | null
  talentArea: string | null
  isActive: boolean
}

export type StudentProfile = {
  student: { id: string; bilsemNo: string; firstName: string; lastName: string; createdAt: string }
  enrollments: StudentEnrollment[]
}

export type Project = {
  id: string
  title: string
  description: string | null
  academicYearId: string
  academicYearName: string
  categoryId: string
  categoryName: string
  statusId: string
  statusName: string
  createdBy: string
  creatorName: string
  participationType: 'INDIVIDUAL' | 'TEAM'
  teamName: string | null
  createdAt: string
  students?: string[]
  advisors?: string[]
}

export type DashboardSummary = {
  activeStudentCount: number
  activeTeacherCount: number
  activeProjectCount: number
  unreadNotificationCount: number
  currentAcademicYear: AcademicYear | null
  categoryDistribution: Array<{ categoryId: string; categoryName: string; total: number }>
  recentProjects: Array<{
    id: string
    title: string
    academicYearName: string
    categoryName: string
    statusName: string
    creatorName: string
    createdAt: string
  }>
}

export type ReportOverview = {
  academicYearId: string | null
  totalStudentCount: number
  activeStudentCount: number
  projectCount: number
  participatingStudentCount: number
  nonParticipatingStudentCount: number
  projectCreatorCount: number
  activeTeacherCount: number
  categoryDistribution: Array<{ categoryId: string; categoryName: string; total: number }>
  participationDistribution: Array<{ participationType: 'INDIVIDUAL' | 'TEAM'; total: number }>
  statusDistribution: Array<{ statusId: string; statusName: string; total: number }>
  yearComparisons: Array<{ academicYearId: string; academicYearName: string; activeStudentCount: number; projectCount: number; participatingStudentCount: number; projectCreatorCount: number; participationRate: number }>
}
export type ReportStudentRow = { enrollmentId: string; studentId: string; bilsemNo: string; firstName: string; lastName: string; academicYearId: string; academicYearName: string; talentArea: string | null; advisorUserId: string | null; advisorName: string | null; projectCount: number; individualProjectCount: number; teamProjectCount: number }
export type ReportTeacherRow = { id: string; name: string; email: string; isActive: boolean; createdProjectCount: number; advisedProjectCount: number; advisedStudentCount: number; createdCategories: Array<{ categoryName: string; total: number }>; advisedCategories: Array<{ categoryName: string; total: number }>; createdTypes: Array<{ participationType: 'INDIVIDUAL' | 'TEAM'; total: number }>; advisedTypes: Array<{ participationType: 'INDIVIDUAL' | 'TEAM'; total: number }>; createdYears: Array<{ yearName: string; total: number }>; advisedYears: Array<{ yearName: string; total: number }> }
export type ProjectReportRow = { id: string; title: string; academicYearId: string; academicYearName: string; categoryId: string; categoryName: string; statusId: string; statusName: string; participationType: 'INDIVIDUAL' | 'TEAM'; teamName: string | null; createdBy: string; creatorName: string; createdAt: string; studentCount: number; advisors: string[] }

export type ProjectOptions = {
  categories: Array<{ id: string; code: string; name: string; duplicateCheckEnabled: boolean }>
  statuses: Array<{ id: string; code: string; name: string; isTerminal: boolean }>
  teachers?: Array<{ id: string; name: string }>
}

export type StudentProject = {
  projectId: string
  title: string
  academicYear: string
  category: string
  status: string
  createdBy: string
  participationType: 'INDIVIDUAL' | 'TEAM'
  teamName: string | null
  advisors: Array<{ userId: string; name: string }>
}

type ApiEnvelope<T> = { success: true; data: T; pagination?: ApiPage<unknown>['pagination'] }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body instanceof FormData || init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError('Sunucuya ulaşılamıyor. Geliştirme sunucusunun API ile çalıştığını kontrol edin.', 0, 'NETWORK_ERROR')
  }

  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => null) as ApiEnvelope<T> & {
    success?: boolean
    error?: { message?: string; code?: string }
  } | null
  if (!response.ok || !body?.success) {
    throw new ApiError(body?.error?.message ?? 'İstek tamamlanamadı.', response.status, body?.error?.code)
  }
  return body.data
}

export async function apiPageRequest<T>(path: string, init: RequestInit = {}): Promise<ApiPage<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body instanceof FormData || init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError('Sunucuya ulaşılamıyor. Geliştirme sunucusunun API ile çalıştığını kontrol edin.', 0, 'NETWORK_ERROR')
  }

  const body = await response.json().catch(() => null) as {
    success?: boolean
    data?: T[]
    pagination?: { page: number; pageSize: number; total: number; totalPages: number }
    error?: { message?: string; code?: string }
  } | null
  if (!response.ok || !body?.success) {
    throw new ApiError(body?.error?.message ?? 'İstek tamamlanamadı.', response.status, body?.error?.code)
  }
  return {
    data: body.data ?? [],
    pagination: body.pagination ?? { page: 1, pageSize: 20, total: 0, totalPages: 1 },
  }
}

async function authRequest(path: string, body: Record<string, string>) {
  let response: Response
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Sunucuya ulaşılamıyor. `npm run dev:api` ile yerel API sunucusunu başlatın.', 0, 'NETWORK_ERROR')
  }
  const result = await response.json().catch(() => null) as { message?: string; code?: string } | null
  if (!response.ok) throw new ApiError(result?.message ?? 'Kimlik doğrulama başarısız.', response.status, result?.code)
}

export const signIn = (email: string, password: string) => authRequest('sign-in/email', { email, password })
export const signUp = (name: string, email: string, password: string) => authRequest('sign-up/email', { name, email, password })

export async function signOut() {
  try {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' })
  } finally {
    window.location.assign('/')
  }
}
