CREATE TABLE `session_sync_state` (
	`session_id` text PRIMARY KEY,
	`version` integer DEFAULT 1 NOT NULL,
	`exported` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_session_sync_state_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);

--> statement-breakpoint
INSERT INTO session_sync_state (session_id) SELECT id FROM session;

--> statement-breakpoint
CREATE TRIGGER session_sync_session_insert AFTER INSERT ON session BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = NEW.id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_session_update AFTER UPDATE ON session BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = NEW.id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_message_insert AFTER INSERT ON message BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = NEW.session_id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_message_update AFTER UPDATE ON message BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = NEW.session_id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_message_delete AFTER DELETE ON message BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = OLD.session_id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_part_insert AFTER INSERT ON part BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = NEW.session_id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_part_update AFTER UPDATE ON part BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = NEW.session_id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_part_delete AFTER DELETE ON part BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE id = OLD.session_id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;

--> statement-breakpoint
CREATE TRIGGER session_sync_project_update AFTER UPDATE OF worktree, name ON project BEGIN
  INSERT INTO session_sync_state (session_id) SELECT id FROM session WHERE project_id = NEW.id
  ON CONFLICT(session_id) DO UPDATE SET version = session_sync_state.version + 1;
END;
