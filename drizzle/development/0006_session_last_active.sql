ALTER TABLE `sessions` ADD `last_active_at` integer;
UPDATE `sessions` SET `last_active_at` = `created_at` WHERE `last_active_at` IS NULL;
