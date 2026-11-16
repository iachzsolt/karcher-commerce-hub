export type InventoryImportFingerprintCandidate = {
  status: string
  sourceFingerprint: string | null
}

export function canSkipInventoryImport(input: {
  latestRun: InventoryImportFingerprintCandidate | null
  currentFingerprint: string
}): boolean {
  const { latestRun, currentFingerprint } = input

  if (!latestRun) return false

  if (
    latestRun.status !== 'SUCCESS' &&
    latestRun.status !== 'NO_CHANGE'
  ) {
    return false
  }

  return (
    latestRun.sourceFingerprint === currentFingerprint
  )
}
