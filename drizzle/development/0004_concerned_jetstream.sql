ALTER TABLE `import_batches` ADD `new_student_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `continuing_student_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `changed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `warnings_json` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `approved_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `import_batches` ADD `approved_at` integer;--> statement-breakpoint
ALTER TABLE `import_rows` ADD `matched_advisor_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `import_rows` ADD `is_source_row` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `advisor_user_id` text REFERENCES users(id);