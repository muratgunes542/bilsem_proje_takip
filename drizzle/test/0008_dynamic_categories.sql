INSERT OR IGNORE INTO `project_categories` (`id`, `code`, `name`, `is_active`, `duplicate_check_enabled`, `duplicate_rule`, `created_at`, `updated_at`)
SELECT seed.`id`, seed.`code`, seed.`name`, 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)
FROM (
  SELECT 'category-teknofest' AS `id`, 'TEKNOFEST' AS `code`, 'TEKNOFEST' AS `name`
  UNION ALL SELECT 'category-tubitak-4005', 'TUBITAK_4005', 'TÜBİTAK 4005'
  UNION ALL SELECT 'category-tubitak-4008', 'TUBITAK_4008', 'TÜBİTAK 4008'
  UNION ALL SELECT 'category-tubitak-bilim-soylesisi', 'TUBITAK_BILIM_SOYLESISI', 'TÜBİTAK Bilim Söyleşisi'
  UNION ALL SELECT 'category-other-competitions', 'OTHER_COMPETITIONS', 'Diğer Yarışmalar'
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM `project_categories` AS existing
  WHERE lower(trim(existing.`code`)) = lower(seed.`code`)
    OR lower(trim(existing.`name`)) = lower(seed.`name`)
);
