CREATE TABLE archive_selections(archiveId TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,page INTEGER NOT NULL,ids TEXT NOT NULL,PRIMARY KEY(archiveId,page));
