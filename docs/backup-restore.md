# Turso Yedekleme ve Geri Yükleme Stratejisi

## Üretim

1. Turso planındaki point-in-time recovery/backup özelliği etkinleştirilir.
2. Ayrıca günlük mantıksal kopya alınır: `turso db shell <db> .dump > backup-YYYY-MM-DD.sql`.
3. Yedekler şifreli, erişimi sınırlandırılmış ve uygulama veritabanından ayrı bir depoda tutulur.
4. Günlük yedekler 30 gün, aylık yedekler 12 ay saklanır; kurum politikası daha uzunsa o süre uygulanır.
5. Her migration öncesi manuel geri dönüş noktası oluşturulur.

## Geri Yükleme

1. Üretim yazma trafiği durdurulur.
2. Yeni ve boş bir Turso veritabanı oluşturulur; mevcut üretim veritabanının üzerine doğrudan yazılmaz.
3. İlgili dump yeni veritabanına uygulanır veya Turso point-in-time recovery kullanılır.
4. Foreign key kontrolü, tablo sayıları, son audit kaydı ve örnek ilişki sorguları doğrulanır.
5. Uygulamanın `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` değerleri yeni veritabanına yönlendirilir.
6. Smoke test sonrası trafik açılır; eski veritabanı inceleme süresi boyunca salt okunur tutulur.

## Tatbikat

- En az üç ayda bir izole test ortamında restore tatbikatı yapılır.
- RPO hedefi 24 saatten düşük, RTO hedefi kurumun operasyon gereksinimine göre belgelenir.
- Yedek dosyalarında gerçek öğrenci verisi varsa kişisel veri politikaları ve erişim loglaması uygulanır.
