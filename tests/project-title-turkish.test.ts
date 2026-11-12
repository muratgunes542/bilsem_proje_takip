import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthenticatedUser } from '../server/authorization'
import * as schema from '../server/db/schema'
import { ProjectService } from '../server/services/project-service'

describe('Project Title Turkish Character Preservation Tests', () => {
  let client: Client
  let db: ReturnType<typeof drizzle<typeof schema>>
  let projectService: ProjectService

  const teacher: AuthenticatedUser = { id: 'teacher-1', role: 'TEACHER', isActive: true }

  beforeEach(async () => {
    const databaseFile = join(tmpdir(), `project-title-${randomUUID()}.db`)
    client = createClient({ url: `file:${databaseFile}` })
    db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: 'drizzle/test' })

    await db.insert(schema.users).values([
      { id: teacher.id, name: 'Teacher One', email: 'teacher1@test.com', role: 'TEACHER' },
    ])

    await db.insert(schema.academicYears).values([
      { id: 'year-2024', name: '2024-2025', startsOn: new Date('2024-09-01'), endsOn: new Date('2025-06-30'), isCurrent: true },
    ])

    await db.insert(schema.students).values([
      { id: 'student-1', bilsemNo: '1001', firstName: 'Ali', lastName: 'Yılmaz' },
      { id: 'student-2', bilsemNo: '1002', firstName: 'Ayşe', lastName: 'Kaya' },
    ])

    await db.insert(schema.studentEnrollments).values([
      { id: 'enroll-1', studentId: 'student-1', academicYearId: 'year-2024', isActive: true },
      { id: 'enroll-2', studentId: 'student-2', academicYearId: 'year-2024', isActive: true },
    ])

    projectService = new ProjectService(db)
  })

  afterEach(async () => {
    await client.close()
  })

  const turkishTitles = [
    'Güneş Enerjisiyle Akıllı Sulama',
    'Öğrencilerde Yapay Zekâ Farkındalığı',
    'Çevre Kirliliğinin Önlenmesine Yönelik Çözüm Önerileri',
    'Işığın Bitkilerin Gelişimine Etkisi',
    'Çağdaş Eğitimde Öğrenci Katılımı',
  ]

  for (const title of turkishTitles) {
    it(`correctly creates and retrieves project with Turkish title: "${title}"`, async () => {
      const created = await projectService.createProject(teacher, {
        title,
        academicYearId: 'year-2024',
        categoryId: 'category-etwinning',
        statusId: 'status-draft',
        participationType: 'INDIVIDUAL',
        enrollmentIds: ['enroll-1'],
      })

      const detail = await projectService.getProjectDetail(teacher, created.projectId)
      expect(detail.project.title).toBe(title)

      // Test updating title with Turkish characters
      const updatedTitle = `${title} (Güncellendi)`
      await projectService.updateProject(teacher, created.projectId, { title: updatedTitle })

      const updatedDetail = await projectService.getProjectDetail(teacher, created.projectId)
      expect(updatedDetail.project.title).toBe(updatedTitle)
    })
  }
})
