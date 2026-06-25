import { useCallback, useRef, useState } from 'react'
import type { EnrichedSearchResult } from '../types'

export type ViewerSession = {
  absoluteIndex: number
  windowOffset: number
  items: EnrichedSearchResult[]
  canNavigateNext: boolean
  totalItems?: number
}

export type UseMediaViewerOptions = {
  resultOffset: number
  resultPageSize: number
  currentItems: EnrichedSearchResult[]
  totalItems?: number
  loadWindow(offset: number, signal?: AbortSignal): Promise<EnrichedSearchResult[]>
  onWindowLoaded(offset: number, items: EnrichedSearchResult[]): void
  onError(message: string): void
}

function canNavigateNext(
  localIndex: number,
  windowOffset: number,
  windowItems: EnrichedSearchResult[],
  pageSize: number,
  totalItems?: number,
): boolean {
  if (localIndex < windowItems.length - 1) return true
  if (typeof totalItems === 'number') {
    return windowOffset + windowItems.length < totalItems
  }
  return windowItems.length === pageSize
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

export function useMediaViewer({
  resultOffset,
  resultPageSize,
  currentItems,
  totalItems,
  loadWindow,
  onWindowLoaded,
  onError,
}: UseMediaViewerOptions): {
  viewerSession: ViewerSession | undefined
  viewerLocalIndex: number
  viewerNavigationPending: boolean
  openViewer(index: number): void
  openViewerAtIndex(index: number): Promise<void>
  closeViewer(): void
} {
  const [viewerSession, setViewerSession] = useState<ViewerSession>()
  const [viewerNavigationPending, setViewerNavigationPending] = useState(false)
  const requestIdRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)

  const openViewerAtIndex = useCallback(
    async (absoluteIndex: number) => {
      if (absoluteIndex < 0) return

      const requestId = ++requestIdRef.current
      loadControllerRef.current?.abort()
      loadControllerRef.current = undefined
      setViewerNavigationPending(true)
      try {
        const windowOffset =
          Math.floor(absoluteIndex / resultPageSize) * resultPageSize
        const localIndex = absoluteIndex - windowOffset
        let windowItems = currentItems

        if (windowOffset !== resultOffset) {
          const controller = new AbortController()
          loadControllerRef.current = controller
          windowItems = await loadWindow(windowOffset, controller.signal)
          if (requestId !== requestIdRef.current) return
          onWindowLoaded(windowOffset, windowItems)
        }

        if (!windowItems[localIndex]) {
          setViewerSession((session) =>
            session ? { ...session, canNavigateNext: false } : session,
          )
          return
        }

        setViewerSession({
          absoluteIndex,
          windowOffset,
          items: windowItems,
          canNavigateNext: canNavigateNext(
            localIndex,
            windowOffset,
            windowItems,
            resultPageSize,
            totalItems,
          ),
          totalItems:
            typeof totalItems === 'number'
              ? totalItems
              : windowItems.length < resultPageSize
                ? windowOffset + windowItems.length
                : undefined,
        })
      } catch (caught) {
        if (isAbortError(caught)) return
        onError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (requestId === requestIdRef.current) {
          loadControllerRef.current = undefined
          setViewerNavigationPending(false)
        }
      }
    },
    [
      currentItems,
      loadWindow,
      onError,
      onWindowLoaded,
      resultOffset,
      resultPageSize,
      totalItems,
    ],
  )

  const openViewer = useCallback(
    (index: number) => {
      void openViewerAtIndex(resultOffset + index)
    },
    [openViewerAtIndex, resultOffset],
  )

  const closeViewer = useCallback(() => {
    ++requestIdRef.current
    loadControllerRef.current?.abort()
    loadControllerRef.current = undefined
    setViewerSession(undefined)
    setViewerNavigationPending(false)
  }, [])

  const viewerLocalIndex = viewerSession
    ? viewerSession.absoluteIndex - viewerSession.windowOffset
    : -1

  return {
    viewerSession,
    viewerLocalIndex,
    viewerNavigationPending,
    openViewer,
    openViewerAtIndex,
    closeViewer,
  }
}
