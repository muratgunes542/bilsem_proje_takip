CREATE TABLE `academic_years` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`starts_on` integer NOT NULL,
	`ends_on` integer NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `academic_years_name_unique` ON `academic_years` (`name`);--> statement-breakpoint
CREATE INDEX `academic_years_current_idx` ON `academic_years` (`is_current`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_uidx` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`before_json` text,
	`after_json` text,
	`request_id` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`academic_year_id` text NOT NULL,
	`file_name` text NOT NULL,
	`status` text DEFAULT 'UPLOADED' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`valid_rows` integer DEFAULT 0 NOT NULL,
	`invalid_rows` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `import_batches_year_idx` ON `import_batches` (`academic_year_id`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`raw_json` text NOT NULL,
	`normalized_json` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`error_message` text,
	`student_id` text,
	`enrollment_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_rows_batch_row_uidx` ON `import_rows` (`batch_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `import_rows_status_idx` ON `import_rows` (`status`);--> statement-breakpoint
CREATE TABLE `project_advisors` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `project_advisors_user_idx` ON `project_advisors` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_attachments_storage_key_unique` ON `project_attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `project_attachments_project_idx` ON `project_attachments` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_categories_code_unique` ON `project_categories` (`code`);--> statement-breakpoint
CREATE TABLE `project_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_status_id` text,
	`to_status_id` text NOT NULL,
	`changed_by` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`from_status_id`) REFERENCES `project_statuses`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_status_id`) REFERENCES `project_statuses`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `project_status_history_project_idx` ON `project_status_history` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_statuses_code_unique` ON `project_statuses` (`code`);--> statement-breakpoint
CREATE TABLE `project_students` (
	`project_id` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	PRIMARY KEY(`project_id`, `enrollment_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `project_students_enrollment_idx` ON `project_students` (`enrollment_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`academic_year_id` text NOT NULL,
	`category_id` text NOT NULL,
	`status_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `project_categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`status_id`) REFERENCES `project_statuses`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `projects_created_by_idx` ON `projects` (`created_by`);--> statement-breakpoint
CREATE INDEX `projects_academic_year_idx` ON `projects` (`academic_year_id`);--> statement-breakpoint
CREATE INDEX `projects_status_idx` ON `projects` (`status_id`);--> statement-breakpoint
CREATE INDEX `projects_deleted_at_idx` ON `projects` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `student_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`academic_year_id` text NOT NULL,
	`school_name` text,
	`grade_level` integer,
	`class_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `student_enrollments_student_year_uidx` ON `student_enrollments` (`student_id`,`academic_year_id`);--> statement-breakpoint
CREATE INDEX `student_enrollments_year_idx` ON `student_enrollments` (`academic_year_id`);--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`student_code` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_student_code_unique` ON `students` (`student_code`);--> statement-breakpoint
CREATE INDEX `students_deleted_at_idx` ON `students` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'TEACHER' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX `users_deleted_at_idx` ON `users` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_update`
BEFORE UPDATE ON `audit_logs`
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_delete`
BEFORE DELETE ON `audit_logs`
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `project_status_history_no_update`
BEFORE UPDATE ON `project_status_history`
BEGIN
  SELECT RAISE(ABORT, 'project_status_history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `project_status_history_no_delete`
BEFORE DELETE ON `project_status_history`
BEGIN
  SELECT RAISE(ABORT, 'project_status_history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `users_role_guard_insert`
BEFORE INSERT ON `users`
WHEN NEW.role NOT IN ('ADMIN', 'TEACHER')
BEGIN
  SELECT RAISE(ABORT, 'invalid user role');
END;
--> statement-breakpoint
CREATE TRIGGER `users_role_guard_update`
BEFORE UPDATE OF role ON `users`
WHEN NEW.role NOT IN ('ADMIN', 'TEACHER')
BEGIN
  SELECT RAISE(ABORT, 'invalid user role');
END;
--> statement-breakpoint
INSERT INTO `project_categories` (`id`, `code`, `name`) VALUES
  ('category-tubitak-2204-a', 'TUBITAK_2204_A', 'TÜBİTAK 2204-A'),
  ('category-tubitak-2204-b', 'TUBITAK_2204_B', 'TÜBİTAK 2204-B'),
  ('category-tubitak-4004', 'TUBITAK_4004', 'TÜBİTAK 4004'),
  ('category-tubitak-4006', 'TUBITAK_4006', 'TÜBİTAK 4006'),
  ('category-etwinning', 'ETWINNING', 'eTwinning'),
  ('category-ip-rights', 'IP_RIGHTS', 'Fikri Mülkiyet Hakları'),
  ('category-special-project', 'SPECIAL_PROJECT', 'Özel Proje'),
  ('category-special-competition', 'SPECIAL_COMPETITION', 'Özel Yarışma');
--> statement-breakpoint
INSERT INTO `project_statuses` (`id`, `code`, `name`, `sort_order`, `is_terminal`) VALUES
  ('status-draft', 'DRAFT', 'Taslak', 10, 0),
  ('status-active', 'ACTIVE', 'Aktif', 20, 0),
  ('status-completed', 'COMPLETED', 'Tamamlandı', 30, 1),
  ('status-cancelled', 'CANCELLED', 'İptal Edildi', 40, 1);