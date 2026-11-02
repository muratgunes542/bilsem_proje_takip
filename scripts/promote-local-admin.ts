import { and, eq, isNull } from 'drizzle-orm'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { env } from '../server/env'
import { db, client } from '../server/db/client'
import * as schema from '../server/db/schema'

async function main() {
  if (env.APP_ENV !== 'development' || env.TURSO_DATABASE_URL !== 'file:./data/development.db' || env.TURSO_AUTH_TOKEN) {
    throw new Error('Bu komut yalnızca APP_ENV=development ve TURSO_DATABASE_URL=file:./data/development.db yerel hedefinde çalışır.')
  }
  const admins = await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.role, 'ADMIN'), isNull(schema.users.deletedAt))).limit(1)
  if (admins.length) throw new Error('Yerel veritabanında zaten bir yönetici var; işlem yapılmadı.')

  const readline = createInterface({ input: stdin, output: stdout })
  try {
    const email = (await readline.question('Yükseltilecek mevcut öğretmen e-postası: ')).trim().toLowerCase()
    const [teacher] = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.users.role })
      .from(schema.users).where(and(eq(schema.users.email, email), eq(schema.users.role, 'TEACHER'), eq(schema.users.isActive, true), isNull(schema.users.deletedAt))).limit(1)
    if (!teacher) throw new Error('Bu e-posta ile etkin bir öğretmen hesabı bulunamadı. Önce uygulamadan öğretmen hesabı oluşturun.')
    const confirmation = await readline.question(`${teacher.name} (${teacher.email}) hesabı yerel veritabanında yönetici yapılacak. Onay için PROMOTE yazın: `)
    if (confirmation !== 'PROMOTE') throw new Error('Onay alınmadı; hiçbir değişiklik yapılmadı.')
    await db.update(schema.users).set({ role: 'ADMIN', updatedAt: new Date() }).where(eq(schema.users.id, teacher.id))
    console.log(`Yerel yönetici hesabı hazır: ${teacher.email}`)
  } finally {
    readline.close()
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Yerel yönetici kurulamadı.')
  process.exitCode = 1
})
