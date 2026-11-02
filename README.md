# Kurumsal Proje Takip Sistemi

React 19, TypeScript, Vite, Turso/libSQL, Drizzle ORM ve Better Auth tabanlı Ünye BİLSEM proje takip uygulamasıdır. Arayüz oturum, öğrenci/proje, yönetici ve Excel aktarım API'leriyle çalışır.

## Gereksinimler

- Node.js 22+
- npm 10+
- Yerel geliştirme için libSQL dosyası veya Turso veritabanı

## Kurulum

```bash
npm install
cp .env.example .env
```

`BETTER_AUTH_SECRET` en az 32 karakterlik rastgele bir değer olmalıdır. Üretim ve test ortamları için ayrı veritabanı, auth secret ve URL kullanın. `.env`, `.env.test` ve `.env.production` Git'e dahil edilmez. İzole yerel veritabanı için `.env` içindeki `TURSO_DATABASE_URL=file:./data/development.db` kullanın; bağlantı hedefini kontrol etmeden migration çalıştırmayın.

## Komutlar

```bash
npm run dev             # Yalnızca Vite frontend
npx dotenv -e .env -- npm run db:migrate # Yerel geliştirme migration'ları
npm run dev:local                       # İzole yerel DB ile Vite + API + Better Auth
npx dotenv -e .env -- npm run dev:api   # Vercel CLI geliştirme ortamı
npm run db:bootstrap-admin:local        # Mevcut yerel öğretmeni ilk yönetici yapar
npm run build           # TypeScript kontrolü ve üretim build'i
npm run typecheck       # Strict TypeScript kontrolü
npm run lint            # ESLint
npm test                # Yetki ve birim testleri
npm run db:generate     # Şemadan migration üretir
npm run db:migrate      # APP_ENV klasöründeki migration'ları uygular
npm run db:migrate:test # .env.test ile test migration'ı
```

## Ortam Ayrımı

- `APP_ENV=development`: `drizzle/development`, yerel veya geliştirme Turso DB.
- `APP_ENV=test`: `drizzle/test`, yalnızca otomatik test veritabanı.
- `APP_ENV=production`: `drizzle/production`, Vercel production secret'ları.
- Production secret'ları yalnızca Vercel/Turso secret yönetiminde tutulur; `VITE_` öneki verilmez ve frontend bundle'ına girmez.

## Mimari

- `src/`: Türkçe, duyarlı giriş, öğretmen/yönetici panelleri, öğrenci, proje ve Excel aktarım ekranları.
- `api/auth/[...all].ts`: Vercel üzerinde Better Auth sunucu endpoint'i.
- `server/db/schema.ts`: 14 iş tablosu ve Better Auth tabloları.
- `server/authorization.ts`: Sunucu tarafı ADMIN/TEACHER kuralları.
- `drizzle/development/`: Geliştirme SQL migration zinciri.
- `tests/authorization.test.ts`: Sahiplik, admin, inactive ve audit yetki testleri.
- `docs/data-model.md`: Veri modeli ve ilişkiler.
- `docs/backup-restore.md`: Yedekleme/geri yükleme stratejisi.

## Güvenlik Kararları

- Veritabanı istemcisi yalnızca `server/` ve Vercel API katmanında oluşturulur; frontend'e açılmaz.
- Better Auth parolayı hashleyerek `accounts.password` alanında tutar.
- Öğretmen proje güncellemesi, oturum kullanıcısı ve `projects.created_by` karşılaştırılarak sunucuda doğrulanır.
- Silme işlemleri domain tablolarında soft delete'tir. Auth oturum tablolarındaki cascade yalnızca auth yaşam döngüsü içindir.
- `audit_logs` ve `project_status_history` SQL trigger'larıyla append-only yapılmıştır.
- Gerçek öğrenci verisi veya seed öğrenci kaydı bulunmaz.
- `db:bootstrap-admin:local` yalnızca `APP_ENV=development`, `TURSO_DATABASE_URL=file:./data/development.db` ve boş yönetici durumunda çalışır; mevcut etkin öğretmen hesabını etkileşimli onayla yönetici yapar.

## Migration Akışı

Şema değişikliğinden önce ekip onayı alınır. Onaydan sonra `server/db/schema.ts` değiştirilir, `npm run db:generate` çalıştırılır, oluşan SQL incelenir ve test veritabanında `npm run db:migrate:test` ile doğrulanır. Üretime geçişten önce yedek alınır.

## Dağıtım

GitHub deposu Vercel'e bağlanır. Vercel ortam değişkenlerine `.env.example` içindeki değerlerin production karşılıkları eklenir. Build komutu `npm run build`, çıktı klasörü `dist` olarak ayarlanır. Migration, deploy öncesi kontrollü CI işi olarak çalıştırılmalıdır; uygulama başlangıcında otomatik migration önerilmez.
