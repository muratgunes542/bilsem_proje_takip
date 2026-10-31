CREATE TABLE `project_duplicate_claims` (
	`academic_year_id` text NOT NULL,
	`student_id` text NOT NULL,
	`category_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`academic_year_id`, `student_id`, `category_id`),
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `project_categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `project_duplicate_claims_project_idx` ON `project_duplicate_claims` (`project_id`);