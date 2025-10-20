CREATE TABLE `functionEmbeddings` (
	`id` integer PRIMARY KEY NOT NULL,
	`functionId` integer NOT NULL,
	`chunkIndex` integer NOT NULL,
	`vector` F32_BLOB(3072) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `functions` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`filePath` text NOT NULL
);
