import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { env } from '../server/env'
import { db, client } from '../server/db/client'
import { promoteProductionAdmin } from '../server/services/admin-promotion'

async function main() {
  if (env.APP_ENV !== 'production' || !env.TURSO_DATABASE_URL?.startsWith('libsql://') || !env.TURSO_AUTH_TOKEN) {
    throw new Error('Üretim yöneticisi betiği yalnızca APP_ENV=production ve Turso uzak üretim veritabanı (libsql://) hedefinde çalıştırılabilir.')
  }

  console.log(`Hedef Üretim Veritabanı URL: ${env.TURSO_DATABASE_URL}`)
  const readline = createInterface({ input: stdin, output: stdout })
  try {
    const email = (await readline.question('Üretim yöneticisi e-posta adresi: ')).trim().toLowerCase()
    const confirmation = await readline.question(`DİKKAT: ÜRETİM veritabanında (${env.TURSO_DATABASE_URL}) '${email}' hesabı ADMIN yapılacak. Onay için 'PRODUCTION_CONFIRM' yazın: `)
    const name = (await readline.question('Yönetici adı soyadı (Yeni kullanıcı için): ')).trim()

    const result = await promoteProductionAdmin(db, {
      email,
      name,
      confirmation,
      expectedDatabaseUrl: env.TURSO_DATABASE_URL,
    })

    console.log(`\n${result.message}`)
    if (result.tempPassword) {
      console.log(`E-posta: ${result.email}`)
      console.log(`Geçici Parola: ${result.tempPassword}`)
      console.log(`(Bu parolayı güvenli bir yerde saklayın; ilk girişte değiştirilmesi istenecektir.)\n`)
    }
  } finally {
    readline.close()
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Üretim yöneticisi kurulamadı.')
  process.exitCode = 1
})
