const suffixPattern = /^(.*?)(?: \((\d+)\))?$/

export function splitExtension(name: string): { stem: string; extension: string } {
  const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"))
  const lastDot = name.lastIndexOf(".")
  if (lastDot <= lastSlash + 1) return { stem: name, extension: "" }
  return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) }
}

export function nextAvailableName(name: string, existingNames: Iterable<string>): string {
  const existing = new Set(
    Array.from(existingNames, (value) => value.normalize("NFC").toLocaleLowerCase("en")),
  )
  if (!existing.has(name.normalize("NFC").toLocaleLowerCase("en"))) return name

  const { stem, extension } = splitExtension(name)
  const match = suffixPattern.exec(stem)
  const base = match?.[1] ?? stem
  let counter = Math.max(2, Number(match?.[2] ?? 1) + 1)
  let candidate = `${base} (${counter})${extension}`
  while (existing.has(candidate.normalize("NFC").toLocaleLowerCase("en"))) {
    counter += 1
    candidate = `${base} (${counter})${extension}`
  }
  return candidate
}

export function sanitizeRelativePath(path: string): ReadonlyArray<string> {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")

  if (parts.length === 0 || parts.some((part) => part === ".." || part.includes("\0"))) {
    throw new Error("Invalid relative path")
  }
  return parts
}

export const naturalCompare = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
}).compare
