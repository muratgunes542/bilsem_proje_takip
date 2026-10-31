ALTER TABLE `students` RENAME COLUMN "student_code" TO "bilsem_no";--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_read_idx` ON `notifications` (`recipient_id`,`is_read`);--> statement-breakpoint
CREATE INDEX `notifications_project_idx` ON `notifications` (`project_id`);--> statement-breakpoint
DROP INDEX `students_student_code_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `students_bilsem_no_unique` ON `students` (`bilsem_no`);--> statement-breakpoint
ALTER TABLE `import_rows` ADD `result_type` text;--> statement-breakpoint
CREATE INDEX `import_rows_result_type_idx` ON `import_rows` (`result_type`);--> statement-breakpoint
ALTER TABLE `project_categories` ADD `duplicate_check_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `project_categories` ADD `duplicate_rule` text DEFAULT 'ACADEMIC_YEAR_STUDENT_CATEGORY' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `participation_type` text DEFAULT 'INDIVIDUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `team_name` text;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `advisor_name` text;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `talent_area` text;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `is_active` integer DEFAULT true NOT NULL;