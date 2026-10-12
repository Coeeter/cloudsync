CREATE TABLE revision(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO revision VALUES(1,0);
CREATE TABLE assertions(value INTEGER NOT NULL CHECK(value=1));
CREATE TABLE entries (
 id TEXT PRIMARY KEY, parentId TEXT REFERENCES entries(id), name TEXT NOT NULL,
 normalizedName TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
 objectKey TEXT, mimeType TEXT, size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0), checksumSha256 TEXT,
 modifiedAt TEXT, thumbnailKey TEXT, previewKey TEXT, previewError TEXT, isAnimated INTEGER,
 deletedAt TEXT, originalParentId TEXT, trashRootId TEXT, deleting INTEGER NOT NULL DEFAULT 0,
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX entries_active_name ON entries(coalesce(parentId,''), normalizedName) WHERE deletedAt IS NULL AND deleting=0;
CREATE INDEX entries_parent ON entries(parentId);
CREATE INDEX entries_trash ON entries(trashRootId,deletedAt);
CREATE TRIGGER entry_parent_insert BEFORE INSERT ON entries WHEN NEW.parentId IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'invalid parent') WHERE NOT EXISTS(SELECT 1 FROM entries WHERE id=NEW.parentId AND kind='directory' AND deletedAt IS NULL AND deleting=0);
END;
CREATE TRIGGER entry_parent_update BEFORE UPDATE OF parentId ON entries WHEN NEW.parentId IS NOT NULL AND NEW.deletedAt IS NULL BEGIN
 SELECT RAISE(ABORT,'invalid parent') WHERE NOT EXISTS(SELECT 1 FROM entries WHERE id=NEW.parentId AND kind='directory' AND deletedAt IS NULL AND deleting=0);
 SELECT RAISE(ABORT,'cycle') WHERE EXISTS(WITH RECURSIVE ancestors(id,parentId) AS (SELECT id,parentId FROM entries WHERE id=NEW.parentId UNION SELECT e.id,e.parentId FROM entries e JOIN ancestors a ON e.id=a.parentId) SELECT 1 FROM ancestors WHERE id=NEW.id);
END;
CREATE TRIGGER entries_revision_insert AFTER INSERT ON entries BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER entries_revision_update AFTER UPDATE ON entries BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER entries_revision_delete AFTER DELETE ON entries BEGIN UPDATE revision SET value=value+1 WHERE id=1; END;
CREATE TABLE uploads(
 id TEXT PRIMARY KEY, parentId TEXT, relativePath TEXT NOT NULL, objectKey TEXT NOT NULL UNIQUE,
 size INTEGER NOT NULL, mimeType TEXT NOT NULL, checksumSha256 TEXT NOT NULL, previewManifest TEXT,
 modifiedAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', entryId TEXT, previewEntryId TEXT,
 expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX uploads_expiry ON uploads(status,expiresAt);
CREATE TABLE auth_pins(id TEXT PRIMARY KEY,email TEXT NOT NULL,codeHash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,expiresAt TEXT NOT NULL,consumedAt TEXT,createdAt TEXT NOT NULL);
CREATE INDEX pins_email ON auth_pins(email,createdAt);
CREATE TABLE sessions(id TEXT PRIMARY KEY,email TEXT NOT NULL,tokenHash TEXT NOT NULL UNIQUE,expiresAt TEXT NOT NULL,lastSeenAt TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expiresAt);
CREATE TABLE archives(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,name TEXT NOT NULL,objectKey TEXT NOT NULL,manifest TEXT NOT NULL,selection TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',processed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,bytes INTEGER NOT NULL,error TEXT,leaseToken TEXT,leaseUntil TEXT,submittedAt TEXT,attempts INTEGER NOT NULL DEFAULT 0,expiresAt TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE INDEX archives_fingerprint ON archives(fingerprint,expiresAt);
CREATE INDEX archives_pending ON archives(status,createdAt);
CREATE TABLE cleanup(id TEXT PRIMARY KEY,objectKeys TEXT NOT NULL,createdAt TEXT NOT NULL);
