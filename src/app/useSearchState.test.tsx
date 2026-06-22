import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSearchState } from './useSearchState'

const options = {
  allowedIndexIds: [
    'brute-force',
    's2-cell-btree',
    'dynamic-z-order-cells',
    'segmented-kd-tree',
    'segmented-ball-tree',
  ],
  defaultSelectedIndexId: 'brute-force',
  defaultQueryPoint: { lat: 47.3769, lon: 8.5417 },
  defaultResultPageSize: 100,
  allowedPageSizes: [50, 100, 250, 500],
  pageSizeStorageKey: 'test-page-size',
  mapPointLimit: 500,
}

function SearchHarness() {
  const search = useSearchState(options)
  return (
    <div>
      <output data-testid="page">{search.values.resultPage}</output>
      <output data-testid="page-size">{search.values.resultPageSize}</output>
      <output data-testid="kind">{search.values.kindFilter}</output>
      <output data-testid="href">{search.values.appHref}</output>
      <button
        type="button"
        onClick={() => search.actions.setPage((page) => page + 1)}
      >
        next
      </button>
    </div>
  )
}

describe('useSearchState', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('updates the URL when pagination changes', async () => {
    render(<SearchHarness />)

    fireEvent.click(screen.getByText('next'))

    await waitFor(() => {
      expect(window.location.search).toBe('?page=2')
    })
    expect(screen.getByTestId('page').textContent).toBe('1')
    expect(screen.getByTestId('href').textContent).toBe('/?page=2')
  })

  it('applies popstate URL state without pushing another history entry', async () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    render(<SearchHarness />)
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('0'))
    pushState.mockClear()

    window.history.pushState(
      null,
      '',
      '/?page=3&pageSize=50&kind=geo_point',
    )
    pushState.mockClear()
    fireEvent.popState(window)

    await waitFor(() => {
      expect(screen.getByTestId('page').textContent).toBe('2')
      expect(screen.getByTestId('page-size').textContent).toBe('50')
      expect(screen.getByTestId('kind').textContent).toBe('geo_point')
    })
    expect(pushState).not.toHaveBeenCalled()
  })
})
