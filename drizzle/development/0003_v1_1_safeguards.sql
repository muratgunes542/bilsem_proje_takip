UPDATE `project_categories`
SET `duplicate_check_enabled` = true
WHERE `code` IN ('TUBITAK_2204_A', 'TUBITAK_2204_B', 'TUBITAK_4004', 'TUBITAK_4006');
--> statement-breakpoint
INSERT OR IGNORE INTO `project_duplicate_claims` (`academic_year_id`, `student_id`, `category_id`, `project_id`)
SELECT p.`academic_year_id`, se.`student_id`, p.`category_id`, p.`id`
FROM `projects` p
INNER JOIN `project_categories` pc ON pc.`id` = p.`category_id`
INNER JOIN `project_students` ps ON ps.`project_id` = p.`id` AND ps.`deleted_at` IS NULL
INNER JOIN `student_enrollments` se ON se.`id` = ps.`enrollment_id`
WHERE pc.`duplicate_check_enabled` = true
ORDER BY p.`created_at`, p.`id`;
--> statement-breakpoint
CREATE TRIGGER `projects_created_by_immutable`
BEFORE UPDATE OF `created_by` ON `projects`
WHEN NEW.`created_by` <> OLD.`created_by`
BEGIN
  SELECT RAISE(ABORT, 'project owner is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_participation_type_guard_insert`
BEFORE INSERT ON `projects`
WHEN NEW.`participation_type` NOT IN ('INDIVIDUAL', 'TEAM')
BEGIN
  SELECT RAISE(ABORT, 'invalid participation type');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_participation_type_guard_update`
BEFORE UPDATE OF `participation_type` ON `projects`
WHEN NEW.`participation_type` NOT IN ('INDIVIDUAL', 'TEAM')
BEGIN
  SELECT RAISE(ABORT, 'invalid participation type');
END;
