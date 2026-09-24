CREATE TABLE `session_sync` (
  `machine` text NOT NULL,
  `source_id` text NOT NULL,
  `local_id` text NOT NULL,
  `revision` text NOT NULL,
  `baseline` text NOT NULL,
  CONSTRAINT `session_sync_pk` PRIMARY KEY (`machine`, `source_id`)
);
