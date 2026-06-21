import { useCallback, useState } from 'react'
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
  loadWindow(offset: number): Promise<EnrichedSearchResult[]>
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

  const openViewerAtIndex = useCallback(
    async (absoluteIndex: number) => {
      if (absoluteIndex < 0) return

      setViewerNavigationPending(true)
      try {
        const windowOffset =
          Math.floor(absoluteIndex / resultPageSize) * resultPageSize
        const localIndex = absoluteIndex - windowOffset
        let windowItems = currentItems

        if (windowOffset !== resultOffset) {
          windowItems = await loadWindow(windowOffset)
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
        onError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setViewerNavigationPending(false)
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
