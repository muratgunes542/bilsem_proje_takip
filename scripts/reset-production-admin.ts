import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { and, eq, isNull } from 'drizzle-orm'
import { env } from '../server/env'
import { db, client } from '../server/db/client'
import * as schema from '../server/db/schema'
import { resetTeacherPasswordByAdmin } from '../server/services/admin-promotion'

async function main() {
  if (
    env.APP_ENV !== 'production' ||
    !env.TURSO_DATABASE_URL.startsWith('libsql://') ||
    !env.TURSO_AUTH_TOKEN
  ) {
    throw new Error('İşlem yalnızca uzak üretim veritabanında çalışabilir.')
  }

  const readline = createInterface({ input: stdin, output: stdout })

  try {
    const email = (await readline.question('Mevcut ADMIN e-posta adresi: '))
      .trim()
      .toLowerCase()

    const [admin] = await db.select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
    })
      .from(schema.users)
      .where(and(
        eq(schema.users.email, email),
        isNull(schema.users.deletedAt),
      ))
      .limit(1)

    if (!admin || admin.role !== 'ADMIN') {
      throw new Error('Hesap bulunamadı veya ADMIN rolünde değil. İşlem yapılmadı.')
    }

    console.log(`Doğrulanan hesap: ${admin.email}`)
    console.log('Rol: ADMIN')

    const confirmation = await readline.question(
      'Yalnızca bu yöneticinin parolası sıfırlanacak. Onay için ADMIN_PASSWORD_RESET yazın: ',
    )

    if (confirmation !== 'ADMIN_PASSWORD_RESET') {
      throw new Error('Onay alınmadı. İşlem yapılmadı.')
    }

    const result = await resetTeacherPasswordByAdmin(db, {
      email: admin.email,
      actorUserId: admin.id,
      auditAction: 'ADMIN_PASSWORD_RESET',
    })

    console.log('\nİŞLEM BAŞARILI')
    console.log(`Hesap: ${result.email}`)
    console.log(`Geçici parola: ${result.tempPassword}`)
    console.log('İlk girişte parolanızı değiştirmeniz gerekecek.')
    console.log('Bu parolayı güvenli bir yere kaydedin; sohbet üzerinden paylaşmayın.')
  } finally {
    readline.close()
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error('İşlem başarısız:', error instanceof Error ? error.message : 'Bilinmeyen hata')
  process.exitCode = 1
})
