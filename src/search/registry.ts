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
    const selectedEngineId = spec.order.engineId
    return selectedEngineId
      ? candidates.filter((engine) => engine.id === selectedEngineId)
      : candidates
  }
  const selectedEngineId = spec.order.engineId
  if (!selectedEngineId) {
    return candidates
  }

  return candidates.filter((engine) => engine.id === selectedEngineId)
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
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
        if (isAbortError(caught)) throw caught
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
