# Veri Modeli

## Tasarım İlkeleri

- Kimlikler uygulama katmanında üretilen metin UUID/ULID değerleridir.
- Tarihler Unix epoch milisaniye olarak saklanır ve Drizzle tarafından `Date` olarak okunur.
- İş tablolarında fiziksel silme yerine `deleted_at` ve `deleted_by` kullanılır.
- Yabancı anahtarlarda geçmiş kaybını önlemek için çoğunlukla `ON DELETE RESTRICT` uygulanır.
- `audit_logs` ve `project_status_history` append-only tablolardır; migration içindeki trigger'lar update/delete işlemlerini engeller.
- `accounts.password` Better Auth tarafından hashlenmiş parola için kullanılır; düz metin parola hiçbir tabloda tutulmaz.

## Tablolar

| Tablo | Amaç | Önemli kısıtlar |
| --- | --- | --- |
| `users` | Better Auth kullanıcısı ve uygulama rolü | E-posta unique, rol ADMIN/TEACHER |
| `sessions` | Better Auth oturumları | Token unique, kullanıcı silinirse cascade |
| `accounts` | Parola ve harici sağlayıcı hesapları | Provider + account unique |
| `verifications` | E-posta/kimlik doğrulama kodları | Identifier indexli |
| `students` | Yıldan bağımsız öğrenci ana kaydı | Öğrenci kodu unique |
| `academic_years` | Akademik dönem | Ad unique, geçmiş dönemler korunur |
| `student_enrollments` | Öğrencinin akademik yıl kaydı | Student + academic year unique |
| `project_categories` | Proje türü sözlüğü | Kod unique, sekiz başlangıç kategorisi |
| `project_statuses` | Durum sözlüğü | Kod unique |
| `projects` | Proje ana kaydı | Yıl, kategori, durum ve oluşturucu zorunlu |
| `project_students` | Proje-öğrenci çoktan çoğa ilişkisi | Project + enrollment composite PK |
| `project_advisors` | Proje-danışman çoktan çoğa ilişkisi | Project + user composite PK |
| `project_status_history` | Durum geçiş geçmişi | Append-only |
| `audit_logs` | İşlem denetim izi | Append-only, actor/entity indexli |
| `project_attachments` | Dosya metadata kaydı | Storage key unique; dosya verisi DB dışında |
| `import_batches` | Toplu içe aktarma işi | Akademik yıl ve oluşturan kullanıcı zorunlu |
| `import_rows` | İçe aktarmadaki satır sonucu | Batch + row number unique |

## Yetki Modeli

- `ADMIN`: Tüm aktif kayıtları yönetebilir ve soft-delete edilmiş projeleri geri alabilir.
- `TEACHER`: Proje oluşturabilir; yalnızca `projects.created_by` kendi kullanıcı kimliği olan aktif projeleri değiştirebilir.
- Soft-delete edilmiş proje normal güncelleme akışına kapalıdır.
- Audit kayıtları hiçbir uygulama rolü tarafından güncellenemez veya silinemez.
- Bu kontroller frontend'e bırakılmaz; sunucu servisleri `server/authorization.ts` kurallarını kullanır.

## İlişki Özeti

- Student 1—N StudentEnrollment N—1 AcademicYear
- Project N—1 AcademicYear / Category / Status / Creator
- Project N—N StudentEnrollment (`project_students`)
- Project N—N User (`project_advisors`)
- Project 1—N StatusHistory / Attachment
- ImportBatch 1—N ImportRow
