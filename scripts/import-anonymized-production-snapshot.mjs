import { createClient } from "@libsql/client";
import { copyFile, access, stat } from "node:fs/promises";
import path from "node:path";

// ÖNEMLİ GÜVENLİK NOTU:
// SOURCE_TURSO_AUTH_TOKEN kesinlikle canlı üretim veritabanı üzerinde
// yalnızca salt okunur (Read-Only / RO) erişim yetkisine sahip bir token olarak oluşturulmalıdır.
const SOURCE_URL =
  "libsql://bilsem-prod-db-muratgunes542.aws-eu-west-1.turso.io";
const TARGET_URL = "file:./data/development.db";

const TABLES = [
  "academic_years",
  "users",
  "students",
  "student_enrollments",
  "projects",
  "project_students",
  "project_advisors",
  "project_duplicate_claims",
];

const token = process.env.SOURCE_TURSO_AUTH_TOKEN;
const sourceUrl = process.env.SOURCE_TURSO_DATABASE_URL;
const applyMode = process.argv.includes("--apply");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getValue(row, column) {
  return row[column] === undefined ? null : row[column];
}

function ordinal(index) {
  return String(index + 1).padStart(3, "0");
}

function assertReadOnlyQuery(sql) {
  const rawSql = String(sql);

  // Yorum içeren SQL ifadeleri engellenir (-- ve /*)
  assert(
    !rawSql.includes("--") && !rawSql.includes("/*"),
    `Güvenlik İhlali: Yorum içeren SQL ifadelerine izin verilmez. (Sorgu: ${rawSql})`,
  );

  // Çoklu SQL ifadeleri engellenir
  const statements = rawSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  assert(
    statements.length === 1,
    `Güvenlik İhlali: Yalnızca tek bir SQL ifadesine izin verilir. (Sorgu: ${rawSql})`,
  );

  const trimmed = statements[0].toUpperCase();

  // Kaynak bağlantısında YALNIZCA tek bir SELECT ifadesine izin verilir
  assert(
    trimmed.startsWith("SELECT"),
    `Güvenlik İhlali: Kaynak üretim veritabanında yalnızca SELECT sorgularına izin verilir. (Sorgu: ${rawSql})`,
  );

  const forbiddenKeywords = [
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE",
    "REPLACE", "ATTACH", "DETACH", "VACUUM", "EXEC", "EXECUTE", "PRAGMA",
  ];

  for (const keyword of forbiddenKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    assert(
      !regex.test(rawSql),
      `Güvenlik İhlali: Kaynak veritabanında '${keyword}' işlemi çalıştırılamaz. (Sorgu: ${rawSql})`,
    );
  }
}

async function safeSourceExecute(sourceClient, queryObjOrString) {
  const sql = typeof queryObjOrString === "string" ? queryObjOrString : queryObjOrString.sql;
  assertReadOnlyQuery(sql);
  return await sourceClient.execute(queryObjOrString);
}

function verifyWalCheckpoint(checkpointResult) {
  assert(
    checkpointResult && Array.isArray(checkpointResult.rows) && checkpointResult.rows.length === 1,
    "WAL checkpoint sonucu tam olarak 1 satır içermelidir. Aktarım durduruldu.",
  );

  const row = checkpointResult.rows[0];
  const busy = Number(row.busy ?? row[0]);
  const log = Number(row.log ?? row[1]);
  const checkpointed = Number(row.checkpointed ?? row[2]);

  assert(
    !isNaN(busy) && !isNaN(log) && !isNaN(checkpointed),
    `WAL checkpoint sonucu geçersiz veya sayısal değil (busy=${row.busy}, log=${row.log}, checkpointed=${row.checkpointed}). Aktarım durduruldu.`,
  );

  assert(
    busy === 0,
    `WAL checkpoint başarısız: Veritabanı meşgul (busy=${busy}, log=${log}, checkpointed=${checkpointed}). Aktarım durduruldu.`,
  );

  const isNoWalMode = log === -1 && checkpointed === -1;
  const isFullyCheckpointed = log >= 0 && checkpointed >= 0 && log === checkpointed;

  assert(
    isNoWalMode || isFullyCheckpointed,
    `WAL checkpoint tutarsız: Tüm log çerçeveleri aktarılamadı (busy=${busy}, log=${log}, checkpointed=${checkpointed}). Aktarım durduruldu.`,
  );

  return { busy, log, checkpointed };
}

async function countRows(client, table, isSource = false) {
  const sql = `SELECT COUNT(*) AS total FROM "${table}"`;
  if (isSource) {
    const result = await safeSourceExecute(client, sql);
    return Number(result.rows[0].total);
  }
  const result = await client.execute(sql);
  return Number(result.rows[0].total);
}

async function readRows(client, table, isSource = false) {
  const sql = `SELECT * FROM "${table}"`;
  if (isSource) {
    const result = await safeSourceExecute(client, sql);
    return result.rows;
  }
  const result = await client.execute(sql);
  return result.rows;
}

async function insertRows(tx, table, columns, rows, transform = (r) => r) {
  const names = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const sql = `INSERT INTO "${table}" (${names}) VALUES (${placeholders})`;

  for (const sourceRow of rows) {
    const row = transform(sourceRow);
    const args = columns.map((column) => getValue(row, column));
    await tx.execute({ sql, args });
  }
}

async function verifyEnvironment() {
  assert(token, "Salt okunur Turso tokenı bulunamadı. (TOKEN_RO gerekli)");
  assert(
    sourceUrl === SOURCE_URL,
    "Kaynak veritabanı adresi beklenen üretim adresi değil.",
  );
  assert(
    process.env.APP_ENV === "development",
    "APP_ENV=development değil. İşlem durduruldu.",
  );
  assert(
    process.env.TURSO_DATABASE_URL === TARGET_URL,
    "Yerel hedef adresi doğrulanamadı. İşlem durduruldu.",
  );
  assert(
    !process.env.TURSO_AUTH_TOKEN,
    "Uygulamanın TURSO_AUTH_TOKEN değişkeni tanımlı. İşlem durduruldu.",
  );

  await access(path.resolve("data/development.db"));
}

async function verifyCategoriesAndStatuses(source, target) {
  const sourceCategories = await safeSourceExecute(
    source,
    "SELECT code, name FROM project_categories ORDER BY code",
  );
  const targetCategories = await target.execute(
    "SELECT code, name FROM project_categories ORDER BY code",
  );

  const sourceStatuses = await safeSourceExecute(
    source,
    "SELECT code, name FROM project_statuses ORDER BY code",
  );
  const targetStatuses = await target.execute(
    "SELECT code, name FROM project_statuses ORDER BY code",
  );

  const normalize = (rows) =>
    rows.map((r) => `${r.code}\u0000${r.name}`).join("\n");

  assert(
    normalize(sourceCategories.rows) === normalize(targetCategories.rows),
    "Proje kategorileri kaynak ve hedefte eşleşmiyor.",
  );
  assert(
    normalize(sourceStatuses.rows) === normalize(targetStatuses.rows),
    "Proje durumları kaynak ve hedefte eşleşmiyor.",
  );
  assert(
    sourceCategories.rows.length === 8,
    "Üretimde beklenen 8 kategori bulunamadı.",
  );
  assert(
    sourceStatuses.rows.length === 4,
    "Üretimde beklenen 4 proje durumu bulunamadı.",
  );
}

async function verifyBackupFile(backupPath) {
  const backupStat = await stat(backupPath);
  assert(backupStat.size > 0, "Yedekleme dosyası boş oluşturuldu. İşlem durduruldu.");

  const verifyClient = createClient({ url: `file:${backupPath}` });
  try {
    const checkResult = await verifyClient.execute("PRAGMA quick_check");
    const status = checkResult.rows[0]
      ? String(checkResult.rows[0].quick_check || Object.values(checkResult.rows[0])[0])
      : "";
    assert(
      status === "ok",
      `Yedekleme dosyası SQLite quick_check doğrulamasını geçemedi (Status: ${status}).`,
    );
  } finally {
    await verifyClient.close();
  }
}

async function main() {
  await verifyEnvironment();

  const source = createClient({
    url: SOURCE_URL,
    authToken: token,
  });

  let target = createClient({ url: TARGET_URL });

  try {
    await verifyCategoriesAndStatuses(source, target);

    const sourceCounts = {};
    for (const table of TABLES) {
      sourceCounts[table] = await countRows(source, table, true);
    }

    const historyCount = await countRows(
      source,
      "project_status_history",
      true,
    );

    assert(
      historyCount === 0,
      `Proje durum geçmişinde ${historyCount} kayıt var. Bu betik bu tabloyu aktarmıyor.`,
    );

    const targetCounts = {};
    for (const table of TABLES) {
      targetCounts[table] = await countRows(target, table, false);
      assert(
        targetCounts[table] === 0,
        `Yerel ${table} tablosunda ${targetCounts[table]} kayıt var. Mevcut veriyi korumak için işlem durduruldu.`,
      );
    }

    const nullProjectIds = await safeSourceExecute(
      source,
      `SELECT COUNT(*) AS total
       FROM project_duplicate_claims
       WHERE project_id IS NULL`,
    );

    assert(
      Number(nullProjectIds.rows[0].total) === 0,
      "Yinelenen başvuru kayıtlarında boş project_id bulundu.",
    );

    console.log("\n========== AKTARIM ÖN KONTROLÜ ==========");
    console.log("Kaynak: salt okunur üretim veritabanı (RO Token)");
    console.log(`Hedef: ${TARGET_URL}\n`);

    for (const table of TABLES) {
      console.log(`${table}: ${sourceCounts[table]}`);
    }

    console.log(`project_status_history: ${historyCount} (aktarılmayacak)`);
    console.log("\nKategoriler: eşleşiyor");
    console.log("Proje durumları: eşleşiyor");
    console.log("Hedef tablolar: boş");
    console.log("Yinelenen başvurularda boş project_id: 0");
    console.log("=========================================\n");

    if (!applyMode) {
      console.log("DRY-RUN tamamlandı. Hiçbir veri yazılmadı.");
      console.log("Gerçek aktarım için --apply parametresi gerekir.");
      return;
    }

    // UYARI: Aktarım öncesinde yerel dev sunucusu ve aynı SQLite dosyasına bağlanan süreçler durdurulmalıdır.
    console.log("UYARI: Yerel geliştirme sunucusu ve veritabanına bağlı süreçlerin kapalı olduğundan emin olun.");

    const readline = await import("node:readline/promises");
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let confirmation;
    try {
      confirmation = await prompt.question(
        "Yerel aktarımı onaylamak için IMPORT_ANONYMIZED_SNAPSHOT yazın: ",
      );
    } finally {
      prompt.close();
    }

    assert(
      confirmation === "IMPORT_ANONYMIZED_SNAPSHOT",
      "Onay verilmedi. Hiçbir veri aktarılmadı.",
    );

    // WAL checkpoint kontrolü (busy, log, checkpointed değerleri birlikte değerlendirilir)
    const checkpointResult = await target.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    verifyWalCheckpoint(checkpointResult);

    await target.close();
    target = null;

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const backupPath = path.resolve(
      `data/development.before-anonymized-import-${timestamp}.db`,
    );

    await copyFile(
      path.resolve("data/development.db"),
      backupPath,
    );

    // Yedekleme dosyasının SQLite doğrulaması
    await verifyBackupFile(backupPath);

    console.log(`\nYerel yedek oluşturuldu ve doğrulandı: ${backupPath}`);

    target = createClient({ url: TARGET_URL });
    await target.execute("PRAGMA foreign_keys = ON");

    // Kaynak kayıtlarını aktarım öncesinde oku.
    const rows = {};
    for (const table of TABLES) {
      rows[table] = await readRows(source, table, true);

      assert(
        rows[table].length === sourceCounts[table],
        `${table} kaynak kayıt sayısı değişti. Aktarım durduruldu.`,
      );
    }

    // Kullanıcı kimliklerini koruyarak anonim isim eşlemesi oluştur.
    const usersSorted = [...rows.users].sort(
      (a, b) => String(a.id).localeCompare(String(b.id)),
    );

    const userNumbers = new Map(
      usersSorted.map((row, index) => [
        String(row.id),
        ordinal(index),
      ]),
    );

    // Öğrenci kimliklerini koruyarak anonim numara eşlemesi oluştur.
    const studentsSorted = [...rows.students].sort(
      (a, b) => String(a.id).localeCompare(String(b.id)),
    );

    const studentNumbers = new Map(
      studentsSorted.map((row, index) => [
        String(row.id),
        ordinal(index),
      ]),
    );

    // Proje numaralarını oluştur.
    const projectsSorted = [...rows.projects].sort((a, b) => {
      const dateDifference =
        Number(a.created_at ?? 0) - Number(b.created_at ?? 0);

      return (
        dateDifference ||
        String(a.id).localeCompare(String(b.id))
      );
    });

    const projectNumbers = new Map(
      projectsSorted.map((row, index) => [
        String(row.id),
        ordinal(index),
      ]),
    );

    const tx = await target.transaction("write");

    try {
      // 1. Akademik yıllar
      await insertRows(
        tx,
        "academic_years",
        [
          "id", "name", "starts_on", "ends_on", "is_current",
          "created_at", "updated_at", "deleted_at", "deleted_by",
        ],
        rows.academic_years,
      );

      // 2. Kullanıcılar (Mevcut rol korunur, yoksa TEACHER; varsayılan yetki yükseltmesi yapılmaz)
      await insertRows(
        tx,
        "users",
        [
          "id", "name", "email", "email_verified", "image", "role",
          "is_active", "must_change_password", "created_at",
          "updated_at", "deleted_at", "deleted_by",
        ],
        rows.users,
        (row) => {
          const n = userNumbers.get(String(row.id));

          return {
            ...row,
            name: `Öğretmen ${n}`,
            email: `ogretmen${n}@example.test`,
            role: row.role || "TEACHER",
            email_verified: 0,
            image: null,
            is_active: 0,
            must_change_password: 1,
          };
        },
      );

      // 3. Öğrenciler
      await insertRows(
        tx,
        "students",
        [
          "id", "bilsem_no", "first_name", "last_name",
          "created_at", "updated_at", "deleted_at", "deleted_by",
        ],
        rows.students,
        (row) => {
          const n = studentNumbers.get(String(row.id));

          return {
            ...row,
            bilsem_no: `DEV-${n}`,
            first_name: "Öğrenci",
            last_name: n,
          };
        },
      );

      // 4. Yıllık öğrenci kayıtları (Danışman adı tam anonimleştirme)
      await insertRows(
        tx,
        "student_enrollments",
        [
          "id", "student_id", "academic_year_id", "school_name",
          "grade_level", "class_name", "created_at", "updated_at",
          "deleted_at", "deleted_by", "advisor_name", "talent_area",
          "is_active", "advisor_user_id",
        ],
        rows.student_enrollments,
        (row) => ({
          ...row,
          school_name: "Geliştirme Okulu",
          class_name: "DEV Sınıfı",
          advisor_name: row.advisor_user_id
            ? (userNumbers.has(String(row.advisor_user_id))
                ? `Öğretmen ${userNumbers.get(String(row.advisor_user_id))}`
                : "Anonim Öğretmen")
            : (row.advisor_name ? "Anonim Öğretmen" : null),
        }),
      );

      // 5. Projeler (project_type aktarımı ve anonimleştirme)
      await insertRows(
        tx,
        "projects",
        [
          "id", "academic_year_id", "category_id", "status_id",
          "created_by", "project_type", "created_at", "updated_at", "deleted_at",
          "deleted_by", "description", "participation_type",
          "team_name", "title",
        ],
        rows.projects,
        (row) => {
          const n = projectNumbers.get(String(row.id));

          return {
            ...row,
            project_type: row.project_type || "STUDENT",
            title: `Geliştirme Projesi ${n}`,
            description: "Anonimleştirilmiş test projesi.",
            team_name:
              row.participation_type === "TEAM"
                ? `Geliştirme Takımı ${n}`
                : null,
          };
        },
      );

      // 6. Proje-öğrenci ilişkileri
      await insertRows(
        tx,
        "project_students",
        [
          "project_id", "enrollment_id", "created_at",
          "updated_at", "deleted_at", "deleted_by",
        ],
        rows.project_students,
      );

      // 7. Proje-danışman ilişkileri
      await insertRows(
        tx,
        "project_advisors",
        [
          "project_id", "user_id", "created_at", "deleted_at",
          "deleted_by", "is_primary", "updated_at",
        ],
        rows.project_advisors,
      );

      // 8. Yinelenen başvuru kayıtları
      await insertRows(
        tx,
        "project_duplicate_claims",
        [
          "academic_year_id", "student_id", "category_id",
          "project_id", "created_at",
        ],
        rows.project_duplicate_claims,
      );

      // İşlem tamamlanmadan FK bütünlüğünü kontrol et.
      const fkCheck = await tx.execute(
        "PRAGMA foreign_key_check",
      );

      assert(
        fkCheck.rows.length === 0,
        `Yabancı anahtar kontrolü başarısız: ${JSON.stringify(fkCheck.rows)}`,
      );

      await tx.commit();
    } catch (error) {
      await tx.rollback();
      console.error("\nAKTARIM İŞLEMİ HATASI: İşlem geri alındı (rollback).");
      throw error;
    }

    console.log("\n========== AKTARIM SONUCU ==========");

    for (const table of TABLES) {
      const count = await countRows(target, table, false);
      console.log(`${table}: ${count}`);

      if (count !== sourceCounts[table]) {
        console.error(`AKTARIM DOĞRULAMA HATASI: ${table} tablosundaki kayıt sayısı (${count}), kaynak ile (${sourceCounts[table]}) eşleşmiyor!`);
        assert(false, `${table} kayıt sayısı beklenenle eşleşmiyor.`);
      }
    }

    console.log("\nYabancı anahtar kontrolü: başarılı.");
    console.log("Üretim veritabanına yazma işlemi yapılmadı.");
    console.log("Kullanıcı hesapları pasif olarak aktarıldı.");
    console.log("Aktarım başarıyla tamamlandı.");
  } finally {
    if (target) await target.close();
    await source.close();
  }
}

if (process.env.NODE_ENV !== "test" || process.env.IMPORT_SNAPSHOT_RUN === "true") {
  main().catch((error) => {
    console.error("\nİŞLEM DURDURULDU:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export {
  main,
  verifyEnvironment,
  verifyCategoriesAndStatuses,
  verifyWalCheckpoint,
  verifyBackupFile,
  assertReadOnlyQuery,
  safeSourceExecute,
  TABLES,
};
