import { useCallback, useRef, useState } from 'react'
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

function isAbortError(caught: unknown): boolean {
  return caught instanceof DOMException
    ? caught.name === 'AbortError'
    : caught instanceof Error && caught.name === 'AbortError'
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
  activeImportKind: 'folder' | 'geo' | undefined
  cancelling: boolean
  importFolder(): Promise<void>
  importGeoFile(): Promise<void>
  cancelImport(): void
  commitImport(): void
} {
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [activeImportKind, setActiveImportKind] = useState<
    'folder' | 'geo' | undefined
  >()
  const [importProgress, setImportProgress] = useState<ImportProgress>()
  const activeImportControllerRef = useRef<AbortController | undefined>(
    undefined,
  )

  const finishImport = useCallback(
    (summary: ImportSummary) => {
      onImported(summary)
      if (summary.cancelled) {
        recordActivity('activityImportStopped')
        return
      }
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

  const cancelImport = useCallback(() => {
    if (!activeImportControllerRef.current) return
    setCancelling(true)
    activeImportControllerRef.current.abort()
  }, [])

  const commitImport = useCallback(() => {
    void platform.importer.commitImport()
  }, [platform])

  const importFolder = useCallback(async () => {
    onError('')
    setImportProgress(undefined)
    setBusy(true)
    setCancelling(false)
    setActiveImportKind('folder')
    const controller = new AbortController()
    activeImportControllerRef.current = controller
    try {
      const summary = await platform.importer.importFolder(
        (progress) => {
          setImportProgress(progress)
        },
        { signal: controller.signal },
      )
      finishImport(summary)
    } catch (caught) {
      if (!isAbortError(caught)) {
        onError(caught instanceof Error ? caught.message : String(caught))
      }
      recordActivity('activityImportStopped')
    } finally {
      activeImportControllerRef.current = undefined
      setImportProgress(undefined)
      setCancelling(false)
      setActiveImportKind(undefined)
      setBusy(false)
    }
  }, [finishImport, onError, platform, recordActivity])

  const importGeoFile = useCallback(async () => {
    onError('')
    setImportProgress(undefined)
    setBusy(true)
    setCancelling(false)
    setActiveImportKind('geo')
    const controller = new AbortController()
    activeImportControllerRef.current = controller
    try {
      const summary = await platform.importer.importGeoFile(
        (progress) => {
          setImportProgress(progress)
        },
        { signal: controller.signal },
      )
      finishImport(summary)
    } catch (caught) {
      if (!isAbortError(caught)) {
        onError(caught instanceof Error ? caught.message : String(caught))
      }
      recordActivity('activityImportStopped')
    } finally {
      activeImportControllerRef.current = undefined
      setImportProgress(undefined)
      setCancelling(false)
      setActiveImportKind(undefined)
      setBusy(false)
    }
  }, [finishImport, onError, platform, recordActivity])

  return {
    busy,
    importProgress,
    activeImportKind,
    cancelling,
    importFolder,
    importGeoFile,
    cancelImport,
    commitImport,
  }
}
