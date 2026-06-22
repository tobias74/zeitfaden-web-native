import type {
  SearchIndexEngine,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
} from '../types'

function orderCandidatesForSpec(
  engines: SearchIndexEngine[],
  spec: SearchSpec,
): SearchIndexEngine[] {
  const candidates = engines.filter((engine) => engine.canHandle(spec))
  if (spec.order.kind !== 'distance') {
    return candidates
  }
  const selectedEngineId = spec.order.engineId
  if (!selectedEngineId) {
    return candidates
  }

  const selected = candidates.filter(
    (engine) => engine.id === selectedEngineId,
  )
  const fallback = candidates.filter(
    (engine) => engine.id !== selectedEngineId,
  )
  return [...selected, ...fallback]
}

export class SearchIndexRegistry {
  readonly engines: readonly SearchIndexEngine[]

  constructor(engines: readonly SearchIndexEngine[]) {
    this.engines = engines
  }

  matchingEngines(spec: SearchSpec): SearchIndexEngine[] {
    return orderCandidatesForSpec([...this.engines], spec).filter(
      (engine) => engine.capabilities.exact,
    )
  }

  async search(spec: SearchSpec): Promise<SearchPage> {
    const candidates = this.matchingEngines(spec)
    let lastError: unknown

    for (const engine of candidates) {
      try {
        return await engine.search(spec)
      } catch (caught) {
        lastError = caught
      }
    }

    if (lastError instanceof Error) throw lastError
    if (lastError) throw new Error(String(lastError))
    throw new Error('No exact search index engine can handle this query.')
  }

  async stats(): Promise<SearchIndexStats[]> {
    return Promise.all(this.engines.map((engine) => engine.stats()))
  }
}
