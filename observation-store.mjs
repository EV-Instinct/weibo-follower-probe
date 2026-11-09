import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

export function writeObservationFile(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(data), { flag: 'wx' })
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
