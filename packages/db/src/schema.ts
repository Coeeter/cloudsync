import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const entryKind = pgEnum("entry_kind", ["file", "directory"])
export const uploadStatus = pgEnum("upload_status", ["pending", "uploaded", "finalized", "failed"])
export const jobStatus = pgEnum("job_status", ["pending", "running", "completed", "failed"])

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    kind: entryKind("kind").notNull(),
    objectKey: text("object_key"),
    mimeType: text("mime_type"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    checksumSha256: text("checksum_sha256"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    thumbnailKey: text("thumbnail_key"),
    previewKey: text("preview_key"),
    previewError: text("preview_error"),
    isAnimated: boolean("is_animated"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    originalParentId: uuid("original_parent_id"),
    trashRootId: uuid("trash_root_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("entries_active_sibling_name")
      .on(
        sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.normalizedName,
      )
      .where(sql`${table.deletedAt} is null`),
    index("entries_parent_idx").on(table.parentId),
    index("entries_deleted_idx").on(table.deletedAt),
  ],
)

export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentId: uuid("parent_id"),
    relativePath: text("relative_path").notNull(),
    objectKey: text("object_key").notNull().unique(),
    size: bigint("size", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    previewManifest: jsonb("preview_manifest"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }).notNull(),
    status: uploadStatus("status").notNull().default("pending"),
    error: text("error"),
    entryId: uuid("entry_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("uploads_status_idx").on(table.status),
    index("uploads_expiry_idx").on(table.expiresAt),
  ],
)

export const authPins = pgTable(
  "auth_pins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_pins_email_idx").on(table.email, table.createdAt)],
)

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_expiry_idx").on(table.expiresAt)],
)

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("jobs_ready_idx").on(table.status, table.runAfter)],
)

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStartedAt] })],
)
