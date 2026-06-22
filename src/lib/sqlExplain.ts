import type { SqlExplainPlan, SqlExplainPlanRow } from '../types'

const SQLITE_INDEX_PATTERNS = [
  /\bUSING\s+COVERING\s+INDEX\s+([^\s)]+)/gi,
  /\bUSING\s+INDEX\s+([^\s)]+)/gi,
  /\bUSING\s+AUTOMATIC\s+(?:COVERING\s+)?INDEX\s+([^\s)]+)/gi,
]

export function extractSqliteUsedIndexes(details: string[]): string[] {
  const indexes = new Set<string>()

  for (const detail of details) {
    for (const pattern of SQLITE_INDEX_PATTERNS) {
      pattern.lastIndex = 0
      let match = pattern.exec(detail)
      while (match) {
        indexes.add(match[1])
        match = pattern.exec(detail)
      }
    }
  }

  return [...indexes].sort((a, b) => a.localeCompare(b))
}

export function createSqlExplainPlan(
  rows: SqlExplainPlanRow[],
): SqlExplainPlan {
  return {
    rows,
    usedIndexes: extractSqliteUsedIndexes(rows.map((row) => row.detail)),
  }
}
