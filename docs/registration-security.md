# Kayıt güvenliği değerlendirmesi

## Mevcut davranış

Better Auth e-posta/parola kaydını etkin tutuyor. Kayıt sırasında `role` istemciden alınmıyor; varsayılan rol `TEACHER`. `isActive` varsayılanı `true` ve üretimde e-posta doğrulaması zorunlu kılınmış değil. Bu nedenle kayıt sayfasına erişebilen herkes doğrulama veya yönetici onayı olmadan etkin öğretmen hesabı açabilir. Öğretmen rolü öğrenci ve proje kayıtlarını okuyabildiğinden, internetten erişilen üretim kurulumunda bu yüksek risklidir.

Yönetici API'leri sunucuda rol kontrolüne tabi; bu koruma halka açık öğretmen kaydının öğrenci verisine erişim riskini ortadan kaldırmaz.

## Üretim için öneri

Üretimde herkese açık kaydı kapatın (`emailAndPassword.disableSignUp`) ve yönetici tarafından oluşturulan tek kullanımlık, süreli davet akışına geçin. Davet rolü sunucuda sabitlenmeli; kayıt e-posta doğrulamasından geçene kadar kullanıcı pasif kalmalı ve gerekiyorsa yönetici onayıyla etkinleşmelidir. Davet oluşturma, kullanma, iptal ve hesap etkinleştirme işlemleri denetlenebilir kayıt üretmelidir.

Bu öneri bu sürümde uygulanmadı; yerel öğretmen kaydı ve üretim yapılandırması değiştirilmedi. Üretime açmadan önce bu karar ayrıca uygulanmalıdır.

## Yerel ilk yönetici

`npm run db:bootstrap-admin:local`, yalnızca `APP_ENV=development`, `TURSO_DATABASE_URL=file:./data/development.db`, boş auth token ve henüz ADMIN bulunmaması halinde mevcut etkin öğretmeni etkileşimli onayla yükseltir. Var olan yönetici varken yeni yönetici üretmez. Test veritabanı ve XLSX dosyası `/data/` altında tutulur; Git dışında kalır.
