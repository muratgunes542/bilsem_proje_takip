ALTER TABLE `project_categories` ADD `parent_id` text REFERENCES `project_categories`(`id`) ON UPDATE no action ON DELETE restrict;
--> statement-breakpoint
INSERT OR IGNORE INTO `project_categories` (`id`, `code`, `name`, `parent_id`, `is_active`, `duplicate_check_enabled`, `duplicate_rule`, `created_at`, `updated_at`) VALUES
  ('category-tubitak-parent', 'TUBITAK_MAIN', 'TÜBİTAK Ana Kategori', NULL, 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-teknofest-parent', 'TEKNOFEST_MAIN', 'TEKNOFEST Ana Kategori', NULL, 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-ip-parent', 'IP_MAIN', 'Fikri Mülkiyet Hakları Ana Kategori', NULL, 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-competitions-parent', 'COMPETITIONS_MAIN', 'Yarışmalar Ana Kategori', NULL, 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-special-parent', 'SPECIAL_MAIN', 'Özel Projeler Ana Kategori', NULL, 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),

  ('category-tubitak-other', 'TUBITAK_OTHER', 'Diğer TÜBİTAK Projeleri', 'category-tubitak-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),

  ('category-teknofest-human-tech', 'TEKNOFEST_HUMAN_TECH', 'İnsanlık Yararına Teknoloji', 'category-teknofest-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-teknofest-ed-tech', 'TEKNOFEST_ED_TECH', 'Eğitim Teknolojileri', 'category-teknofest-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-teknofest-environment', 'TEKNOFEST_ENVIRONMENT', 'Çevre ve Enerji', 'category-teknofest-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-teknofest-health', 'TEKNOFEST_HEALTH', 'Sağlık ve İyi Yaşam', 'category-teknofest-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-teknofest-other', 'TEKNOFEST_OTHER', 'Diğer TEKNOFEST Kategorileri', 'category-teknofest-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),

  ('category-ip-patent', 'IP_PATENT', 'Patent', 'category-ip-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-ip-utility', 'IP_UTILITY_MODEL', 'Faydalı Model', 'category-ip-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-ip-trademark', 'IP_TRADEMARK', 'Marka', 'category-ip-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-ip-design', 'IP_DESIGN', 'Tasarım', 'category-ip-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),

  ('category-comp-national', 'COMPETITION_NATIONAL', 'Ulusal Projeler', 'category-competitions-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-comp-international', 'COMPETITION_INTERNATIONAL', 'Uluslararası Yarışmalar', 'category-competitions-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-comp-university', 'COMPETITION_UNIVERSITY', 'Üniversite Yarışmaları', 'category-competitions-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-comp-other', 'COMPETITION_OTHER', 'Diğer Yarışmalar', 'category-competitions-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),

  ('category-special-school', 'SPECIAL_SCHOOL', 'Okul İçi Projeler', 'category-special-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-special-institution', 'SPECIAL_INSTITUTION', 'Kurumlar Arası Projeler', 'category-special-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-special-social', 'SPECIAL_SOCIAL', 'Sosyal Sorumluluk', 'category-special-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000)),
  ('category-special-other', 'SPECIAL_OTHER', 'Diğer Özel Projeler', 'category-special-parent', 1, 0, 'ACADEMIC_YEAR_STUDENT_CATEGORY', (unixepoch() * 1000), (unixepoch() * 1000))
;
--> statement-breakpoint
UPDATE `project_categories` SET `parent_id` = 'category-tubitak-parent' WHERE `code` IN ('TUBITAK_2204_A', 'TUBITAK_2204_B', 'TUBITAK_4004', 'TUBITAK_4005', 'TUBITAK_4006', 'TUBITAK_4008', 'TUBITAK_BILIM_SOYLESISI');
--> statement-breakpoint
UPDATE `project_categories` SET `parent_id` = 'category-teknofest-parent' WHERE `code` = 'TEKNOFEST';
--> statement-breakpoint
UPDATE `project_categories` SET `parent_id` = 'category-ip-parent' WHERE `code` = 'IP_RIGHTS';
--> statement-breakpoint
UPDATE `project_categories` SET `parent_id` = 'category-special-parent' WHERE `code` = 'SPECIAL_PROJECT';
--> statement-breakpoint
UPDATE `project_categories` SET `parent_id` = 'category-competitions-parent' WHERE `code` = 'SPECIAL_COMPETITION';