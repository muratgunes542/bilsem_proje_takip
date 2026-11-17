import { eq } from 'drizzle-orm'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { env } from '../server/env.js'
import { db, client } from '../server/db/client.js'
import { createAuth } from '../server/auth.js'
import * as schema from '../server/db/schema.js'

export function validateAdminEnvironment(): void {
  if (
    env.APP_ENV !== 'development' ||
    env.TURSO_DATABASE_URL !== 'file:./data/development.db' ||
    env.TURSO_AUTH_TOKEN
  ) {
    throw new Error(
      'Bu komut yalnızca yerel development.db üzerinde çalışabilir.',
    )
  }
}

export function validateAdminPassword(password: string | undefined): void {
  if (!password || password.length < 8) {
    throw new Error(
      'LOCAL_ADMIN_PASSWORD tanımlı değil veya parola 8 karakterden kısa.',
    )
  }
}

export async function createAdminAccount(
  auth: ReturnType<typeof createAuth>,
  name: string,
  email: string,
  password: string,
  dbInstance = db,
): Promise<string> {
  let createdUserId: string | null = null
  let signupSucceeded = false

  try {
    const signupResult = await auth.api.signUpEmail({
      body: {
        name,
        email,
        password,
      },
    })

    signupSucceeded = true
    const signupUser = (signupResult as { user?: { id?: string } })?.user
    if (signupUser?.id) {
      createdUserId = signupUser.id
    }

    if (!createdUserId) {
      throw new Error(
        'Better Auth kayıt yanıtında kullanıcı kimliği (user.id) alınamadı.',
      )
    }

    await dbInstance
      .update(schema.users)
      .set({
        role: 'ADMIN',
        isActive: true,
        mustChangePassword: false,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, createdUserId))

    return createdUserId
  } catch (err: unknown) {
    let cleanupErrorMsg: string | null = null

    // Yalnızca bu çalıştırmada oluşturulduğu kesin olan kullanıcı ve hesap kayıtları temizlenir.
    if (signupSucceeded && createdUserId) {
      try {
        await dbInstance.delete(schema.accounts).where(eq(schema.accounts.userId, createdUserId))
        await dbInstance.delete(schema.users).where(eq(schema.users.id, createdUserId))
      } catch (cleanupErr: unknown) {
        cleanupErrorMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        console.error(
          `KRİTİK TEMİZLİK HATASI: Yarım kalan kullanıcı kaydı (${createdUserId}) temizlenirken hata oluştu: ${cleanupErrorMsg}`,
        )
      }
    }

    const mainErrorMsg = err instanceof Error ? err.message : String(err)
    if (cleanupErrorMsg) {
      throw new Error(
        `${mainErrorMsg} (Ayrıca yarım kalan hesabı temizleme hatası: ${cleanupErrorMsg})`,
      )
    }
    throw err
  }
}

export async function main() {
  validateAdminEnvironment()

  const password = process.env.LOCAL_ADMIN_PASSWORD
  validateAdminPassword(password)

  const readline = createInterface({ input: stdin, output: stdout })

  try {
    const name = (await readline.question('Yönetici adı: ')).trim()
    const email = (await readline.question('Yönetici e-postası: '))
      .trim()
      .toLowerCase()

    if (!name || !email || !email.includes('@')) {
      throw new Error('Geçerli bir ad ve e-posta girilmelidir.')
    }

    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1)

    if (existing) {
      throw new Error(
        'Bu e-posta zaten kayıtlı. Başka bir yerel test e-postası kullan.',
      )
    }

    const confirmation = await readline.question(
      `${name} (${email}) yerel ADMIN hesabı olarak oluşturulacak. Onay için CREATE yaz: `,
    )

    if (confirmation !== 'CREATE') {
      throw new Error('Onay verilmedi. İşlem yapılmadı.')
    }

    const auth = createAuth(db, false)
    await createAdminAccount(auth, name, email, password!)

    console.log('\nYerel yönetici hesabı oluşturuldu.')
    console.log(`Ad: ${name}`)
    console.log(`E-posta: ${email}`)
    console.log('Rol: ADMIN')
    console.log('Durum: Aktif')
    console.log('Parola: Better Auth tarafından güvenli biçimde işlendi.')
    console.log('Üretim veritabanına bağlantı veya yazma yapılmadı.')
  } finally {
    readline.close()
    await client.close()
  }
}

if (process.env.NODE_ENV !== 'test' || process.env.CREATE_ADMIN_RUN === 'true') {
  main().catch((error: unknown) => {
    console.error('\nYEREL YÖNETİCİ OLUŞTURULAMADI:')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
