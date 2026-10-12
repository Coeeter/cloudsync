import { localSql } from "./d1"
const date = new Date().toISOString()
await localSql(
  "INSERT OR IGNORE INTO entries(id,name,normalizedName,kind,createdAt,updatedAt) VALUES('benchmark-root','Benchmark','benchmark','directory',?,?)",
  [date, date],
)
await localSql(
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<233)
 INSERT OR IGNORE INTO entries(id,parentId,name,normalizedName,kind,createdAt,updatedAt)
 SELECT 'benchmark-dir-'||i,'benchmark-root','Folder '||i,'folder '||i,'directory',?,? FROM n`,
  [date, date],
)
await localSql(
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<74723)
 INSERT OR IGNORE INTO entries(id,parentId,name,normalizedName,kind,objectKey,mimeType,size,createdAt,updatedAt)
 SELECT 'benchmark-file-'||i,'benchmark-dir-'||(((i-1)/323)+1),'IMG_'||i||'.png','img_'||i||'.png','file','objects/benchmark-'||i,'image/png',1000,?,? FROM n`,
  [date, date],
)
const measurements: Record<string, number> = {}
for (const [name, sql, params] of [
  ["children", "SELECT * FROM entries WHERE parentId=? AND deletedAt IS NULL", ["benchmark-dir-1"]],
  [
    "paths",
    "WITH RECURSIVE paths AS (SELECT id,parentId,name,name AS path FROM entries WHERE parentId IS NULL AND deletedAt IS NULL UNION ALL SELECT e.id,e.parentId,e.name,p.path||'/'||e.name FROM entries e JOIN paths p ON e.parentId=p.id WHERE e.deletedAt IS NULL) SELECT id,path FROM paths",
    [],
  ],
] as const) {
  const start = performance.now()
  const rows = await localSql(sql, [...params])
  measurements[name] = Math.round(performance.now() - start)
  console.log(JSON.stringify({ query: name, rows: rows.length, elapsedMs: measurements[name] }))
}
