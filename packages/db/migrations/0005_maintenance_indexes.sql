-- The five-minute maintenance job filtered these with full scans of entries.
CREATE INDEX entries_trash_roots ON entries(deletedAt) WHERE trashRootId=id AND deleting=0;
CREATE INDEX entries_deleting ON entries(id) WHERE deleting=1;
CREATE INDEX uploads_finalized ON uploads(updatedAt) WHERE status='finalized';
