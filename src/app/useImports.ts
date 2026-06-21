import { useCallback, useState } from 'react'
import type {
  ImportProgress,
  ImportSummary,
  PlatformBackend,
} from '../platform/types'
import type { TranslationKey, TranslationValues } from '../i18n'

export type UseImportsOptions = {
  platform: PlatformBackend
  locale: string
  t(key: TranslationKey, values?: TranslationValues): string
  recordActivity(key: TranslationKey, values?: TranslationValues): void
  onError(message: string): void
  onImported(summary: ImportSummary): void
}

export function useImports({
  platform,
  locale,
  t,
  recordActivity,
  onError,
  onImported,
}: UseImportsOptions): {
  busy: boolean
  importProgress: ImportProgress | undefined
  importFolder(): Promise<void>
  importGeoFile(): Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress>()

  const finishImport = useCallback(
    (summary: ImportSummary) => {
      onImported(summary)
      recordActivity('activityImportedMediaFilesFrom', {
        count: summary.acceptedMedia.toLocaleString(locale),
        sourceLabel: summary.sourceLabel,
      })
      if (summary.errors.length > 0) {
        onError(
          t('filesCouldNotBeRead', {
            count: summary.errors.length.toLocaleString(locale),
          }),
        )
      }
    },
    [locale, onError, onImported, recordActivity, t],
  )

  const importFolder = useCallback(async () => {
    onError('')
    setImportProgress(undefined)
    setBusy(true)
    try {
      const summary = await platform.importer.importFolder((progress) => {
        setImportProgress(progress)
      })
      finishImport(summary)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
      recordActivity('activityImportStopped')
    } finally {
      setImportProgress(undefined)
      setBusy(false)
    }
  }, [finishImport, onError, platform, recordActivity])

  const importGeoFile = useCallback(async () => {
    onError('')
    setImportProgress(undefined)
    setBusy(true)
    const startedAt = performance.now()
    const traceId = `app-${Date.now().toString(36)}-${crypto.randomUUID()}`
    console.log('[import-trace]', {
      traceId,
      scope: 'app',
      phase: 'geo import action start',
    })
    try {
      const summary = await platform.importer.importGeoFile(
        (progress) => {
          setImportProgress(progress)
        },
        { traceId },
      )
      console.log('[import-trace]', {
        traceId,
        scope: 'app',
        phase: 'worker geo import complete',
        elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
        acceptedMedia: summary.acceptedMedia,
        skippedFiles: summary.skippedFiles,
      })
      finishImport(summary)
      console.log('[import-trace]', {
        traceId,
        scope: 'app',
        phase: 'geo import action complete',
        elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      })
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
      recordActivity('activityImportStopped')
    } finally {
      setImportProgress(undefined)
      setBusy(false)
    }
  }, [finishImport, onError, platform, recordActivity])

  return { busy, importProgress, importFolder, importGeoFile }
}
