export type ApiResponse<T = unknown> = {
  success: boolean
  data?: T
  pagination?: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

export type ApiContextUser = {
  id: string
  role: 'ADMIN' | 'TEACHER'
  isActive: boolean
  name: string
  email: string
}
