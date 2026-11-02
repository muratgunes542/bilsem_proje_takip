# BİLSEM Proje Takip Sistemi – Üretim ve Dağıtım Kılavuzu (Production Deployment Guide)

Bu doküman, BİLSEM Proje Takip Sistemi'nin Vercel platformunda ve Turso (libSQL) üretim veritabanı üzerinde güvenli bir şekilde canlıya alınması için adım adım yapılandırma ve dağıtım planını içerir.

---

## 1. Vercel Proje Kurulumu
* **Framework Preset:** Vite
* **Build Command:** `npm run build`
* **Output Directory:** `dist`
* **Node.js Sürümü:** 20.x veya üzeri (önerilen: 20.x LTS)
* **API Route Yapılandırması:** Proje kök dizinindeki `api/` klasörü içerisindeki Vercel serverless fonksiyonları (`api/me.ts`, `api/reports/...`, `api/auth/[...all].ts`, vb.) otomatik olarak route edilir.

---

## 2. GitHub Bağlantısı ve Deploy Akışı
1. Proje deposunu GitHub üzerinde hazırlayın.
2. Vercel Dashboard üzerinde **"New Project"** seçeneği ile GitHub repository'sini bağlayın.
3. **Production Branch:** `main` olarak ayarlanır.
4. **Preview Deployments:** Her pull request (PR) için otomatik preview ortamı oluşturulur. Preview ortamlarının üretim veritabanına bağlanması Vercel Environment Variables üzerinde Preview için ayrı Turso veritabanı (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`) tanımlanarak veya boş bırakılarak kesin olarak izole edilir.

---

## 3. Turso Üretim Veritabanı Hazırlığı
Turso CLI kullanarak üretim veritabanı ve bağlantı bilgileri oluşturulur (Komutlar Windows PowerShell ortamına uygundur):

```powershell
# 1. Turso CLI oturum açma
turso auth login

# 2. Üretim veritabanının oluşturulması (örnek: bilsem-prod-db)
turso db create bilsem-prod-db

# 3. Veritabanına ait bağlantı URL'sinin alınması
turso db show bilsem-prod-db --url

# 4. Üretim veritabanı için güvenlik token (Auth Token) oluşturulması
turso db tokens create bilsem-prod-db
```
*Not: Elde edilen `TURSO_DATABASE_URL` (`libsql://...`) ve `TURSO_AUTH_TOKEN` değerleri Vercel ortam değişkenlerine eklenecektir.*

---

## 4. Ortam Değişkenleri ve Ortam Bazında Dağılımı (Environment Variables Matrix)

Vercel projesinde **Settings > Environment Variables** bölümünde aşağıdaki değişkenler tanımlanmalıdır:

| Değişken Adı | Production Ortamı | Preview Ortamı | Development Ortamı | Açıklama |
| :--- | :--- | :--- | :--- | :--- |
| `APP_ENV` | `production` | `preview` | `development` | Çalışma ortamı modu |
| `TURSO_DATABASE_URL` | `libsql://<your-prod-db>.turso.io` | `libsql://<your-preview-db>.turso.io` | `file:./data/development.db` | libSQL / Turso bağlantı dizesi |
| `TURSO_AUTH_TOKEN` | `<your-production-turso-token>` | `<your-preview-turso-token>` | *(Boş bırakılabilir)* | Turso şifreli erişim token'ı |
| `BETTER_AUTH_SECRET` | `<secure-random-32-char-string>` | `<preview-secret>` | `<dev-secret>` | Better Auth oturum imza anahtarı (Min 32 karakter) |
| `BETTER_AUTH_URL` | `https://<your-production-domain>` | `https://<preview-domain>` | `http://localhost:3000` | Better Auth taban URL'si |
| `TRUSTED_ORIGINS` | `https://<your-production-domain>` | `https://<preview-domain>` | `http://localhost:3000,http://localhost:5173` | İzin verilen CORS origin'leri |
| `IMPORT_MAX_FILE_BYTES` | `4194304` | `4194304` | `4194304` | Excel yükleme dosya boyutu sınırı (4 MB) |

*Güvenlik Koruması:* `server/env.ts` katmanında `APP_ENV=production` olduğunda `TURSO_DATABASE_URL` adresinin `file:` ile başlaması veya `TURSO_AUTH_TOKEN` değerinin eksik olması durumunda uygulama **fail-fast** (hata vererek başmama) kuralıyla sessizce yerel veritabanına düşmeyi engeller.

---

## 5. Domain ve HTTPS Ayarları
* **Özel Domain (Custom Domain):** Vercel projesine kurumunuza ait özel domain (örn. `proje.kurum.meb.k12.tr`) tanımlayın.
* **HTTPS Zorunluluğu:** Vercel otomatik SSL sertifikası sağlar ve HTTP isteklerini HTTPS'e yönlendirir.
* **Cookie ve Güvenlik:** Better Auth yapılandırması gereği üretimde `secure` çerezler, `SameSite=Lax` ve katı `TRUSTED_ORIGINS` denetimleri aktif olarak çalışır. Açık kayıt (self sign-up) uç noktaları (`/api/auth/sign-up`) sunucu katmanında 403 ile engellenmiştir.

---

## 6. Migration Öncesi Yedekleme ve Güvenli Çalıştırma
Üretim veritabanında şema değişikliği veya migration uygulanmadan önce mutlaka Turso üzerinden yedek alınmalı ve `scripts/migrate.ts` güvenlik koruması altında çalıştırılmalıdır:

```powershell
# 1. Turso veritabanı yedeği (snapshot) alma
turso db snapshot create bilsem-prod-db

# 2. Üretim migration uygulama (Güvenlik koruması: APP_ENV=production, libsql:// ve MIGRATE_PROD onayı zorunludur)
$env:APP_ENV="production"
$env:TURSO_DATABASE_URL="libsql://<your-prod-db>.turso.io"
$env:TURSO_AUTH_TOKEN="<your-production-turso-token>"
npx dotenv -e .env.production -- npm run db:migrate
```

---

## 7. İlk Yönetici Hesabının Oluşturulması (Production vs Local)
* **Yerel Ortam:** `scripts/promote-local-admin.ts` yalnızca `APP_ENV=development` ve yerel `file:./data/development.db` hedefinde çalışır.
* **Üretim Ortamı:** `scripts/promote-production-admin.ts` yalnızca `APP_ENV=production` ve Turso uzak üretim veritabanı (`libsql://`) hedefinde çalışır. `server/services/admin-promotion.ts` içindeki `promoteProductionAdmin` atomik iş mantığını kullanır:
  * Operatörden e-posta adresi ve açık onay (`PRODUCTION_CONFIRM`) alır.
  * Kullanıcı yoksa Better Auth `signUpEmail` ile atomik olarak yeni yönetici oluşturur.
  * Kullanıcı var ve öğretmen ise Better Auth parola sıfırlama akışıyla atomik olarak geçici parola atar ve rolünü `ADMIN` yapar. Herhangi bir adımda hata oluşursa tüm değişiklikler otomatik olarak geri alınır (rollback).
  * Kullanıcı zaten `ADMIN` ise parola sıfırlanmaz, işlem güvenle pas geçilir.

```powershell
# Üretim yöneticisi oluşturma betiğini çalıştırma (atomik, onay gerektiren)
$env:APP_ENV="production"
$env:TURSO_DATABASE_URL="libsql://<your-prod-db>.turso.io"
$env:TURSO_AUTH_TOKEN="<your-production-turso-token>"
$env:BETTER_AUTH_SECRET="<secure-random-32-char-string>"
$env:BETTER_AUTH_URL="https://<your-production-domain>"
$env:TRUSTED_ORIGINS="https://<your-production-domain>"

npx tsx scripts/promote-production-admin.ts
```

---

## 8. İlk Canlı Testler
Yayına alım sonrasında sırasıyla şu testler gerçekleştirilmelidir:
1. **Anonim Kayıt Engeli:** `/api/auth/sign-up/email` uç noktasına doğrudan istek atıldığında `403 Forbidden` döndüğü doğrulanır.
2. **Yönetici Girişi:** İlk yönetici hesabı ile giriş yapılarak `Dashboard`, `Kullanıcı Yönetimi` ve `Raporlama` sekmelerinin çalıştığı kontrol edilir.
3. **Yetki İzolasyonu:** Bir öğretmen hesabıyla giriş yapılarak başka öğretmenin projelerine veya yönetici paneline erişilemediği (`403`) doğrulanır.
4. **Raporlama Erişimi:** Genel analiz, öğrenci ve öğretmen raporları sekmelerinin hata vermeden yüklendiği doğrulanır.

---

## 9. Geri Dönüş / Rollback Planı
1. **Kod Geri Alınması:** Vercel Dashboard üzerinden önceki kararlı (stable) commit dağıtımına (Instant Rollback) tek tıkla dönülür.
2. **Veritabanı Geri Alınması:** Gerekirse Turso snapshot yedeği geri yüklenir:
   ```powershell
   turso db restore bilsem-prod-db <snapshot-id>
   ```
