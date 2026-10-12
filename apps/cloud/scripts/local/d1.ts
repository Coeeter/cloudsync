export async function localSql<A = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<A[]> {
  const base = process.env.CLOUDSYNC_E2E_URL ?? "http://localhost:3310"
  if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
    throw new Error("Local D1 fixtures only")
  const response = await fetch(
    `${base}/cdn-cgi/local/explorer/api/d1/database/local-cloudsync/raw`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    },
  )
  const result = (await response.json()) as {
    success: boolean
    result?: { success: boolean; results: { columns: string[]; rows: unknown[][] } }[]
  }
  if (!response.ok || !result.success || !result.result?.[0]?.success)
    throw new Error("Local D1 query failed")
  const table = result.result[0].results
  return table.rows.map(
    (row) => Object.fromEntries(table.columns.map((name, i) => [name, row[i]])) as A,
  )
}
