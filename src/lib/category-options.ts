export type HierarchicalCategory = {
  id: string
  parentId: string | null
}

export function getCategoryOptionLabel(category: HierarchicalCategory & { name: string }, depth: number): string {
  return category.parentId
    ? `${'　'.repeat(depth)}↳ Alt kategori · ${category.name}`
    : `Ana kategori · ${category.name}`
}

export function getCategoriesInHierarchy<T extends HierarchicalCategory>(
  categories: T[],
): Array<{ category: T; depth: number }> {
  const childrenByParent = new Map<string, T[]>()
  const byId = new Map(categories.map((category) => [category.id, category]))

  for (const category of categories) {
    if (category.parentId && byId.has(category.parentId)) {
      const children = childrenByParent.get(category.parentId) ?? []
      children.push(category)
      childrenByParent.set(category.parentId, children)
    }
  }

  const result: Array<{ category: T; depth: number }> = []
  const visited = new Set<string>()
  const addCategory = (category: T, depth: number) => {
    if (visited.has(category.id)) return
    visited.add(category.id)
    result.push({ category, depth })
    for (const child of childrenByParent.get(category.id) ?? []) {
      addCategory(child, depth + 1)
    }
  }

  for (const category of categories) {
    if (!category.parentId || !byId.has(category.parentId)) addCategory(category, 0)
  }
  for (const category of categories) addCategory(category, category.parentId ? 1 : 0)

  return result
}
