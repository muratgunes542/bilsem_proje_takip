import { describe, expect, it } from 'vitest'
import { getCategoriesInHierarchy, getCategoryOptionLabel } from '../src/lib/category-options'

describe('category selector hierarchy', () => {
  it('orders parents before descendants while preserving category ids and sibling order', () => {
    const categories = [
      { id: 'child-b', parentId: 'parent', name: 'Child B' },
      { id: 'other-parent', parentId: null, name: 'Other parent' },
      { id: 'grandchild', parentId: 'child-b', name: 'Grandchild' },
      { id: 'parent', parentId: null, name: 'Parent' },
      { id: 'child-a', parentId: 'parent', name: 'Child A' },
    ]

    expect(getCategoriesInHierarchy(categories).map(({ category, depth }) => [category.id, depth])).toEqual([
      ['other-parent', 0],
      ['parent', 0],
      ['child-b', 1],
      ['grandchild', 2],
      ['child-a', 1],
    ])
  })

  it('labels historical subcategories as children when their parent is not in active options', () => {
    const historicalCategory = { id: 'historical-child', parentId: 'inactive-parent', name: 'Historical Child' }
    const [result] = getCategoriesInHierarchy([historicalCategory])
    expect(result).toBeDefined()
    if (!result) throw new Error('Historical category was omitted.')

    expect(result.category.parentId).toBe('inactive-parent')
    expect(getCategoryOptionLabel(result.category, result.depth)).toBe('↳ Alt kategori · Historical Child')
  })
})
