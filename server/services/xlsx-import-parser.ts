import ExcelJS from 'exceljs'
import type { StudentImportRecord } from './import-service'

export type ImportFileWarning = {
  type: 'UNEXPECTED_COLUMN' | 'UNEXPECTED_ROW' | 'EXTRA_WORKSHEET'
  rowNumber?: number
  columnNumber?: number
  value?: string
}

export class ImportFileError extends Error {
  constructor(message: string, readonly statusCode: 400 | 413 = 400) {
    super(message)
  }
}

const MAX_ROWS = 5000
const MAX_COLUMNS = 64
const MAX_ZIP_ENTRIES = 256
const MAX_UNCOMPRESSED_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_UNCOMPRESSED_TOTAL_BYTES = 32 * 1024 * 1024
const HEADER_FIELDS = ['bilsemNo', 'firstName', 'lastName', 'talentArea', 'advisorName'] as const
const HEADER_ALIASES: Record<(typeof HEADER_FIELDS)[number], string[]> = {
  bilsemNo: ['bilsem no', 'bilsem numarasi', 'bilsem numara', 'bilsem kodu'],
  firstName: ['ad', 'adi', 'ogrenci adi', 'ogrenci ad'],
  lastName: ['soyad', 'soyadi', 'ogrenci soyadi', 'ogrenci soyad'],
  talentArea: ['yetenek alani', 'yetenek alan', 'alan'],
  advisorName: ['danisman', 'danisman ogretmen', 'danisman adi', 'ogretmen', 'ogretmen adi'],
}

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase('tr-TR').replaceAll('ı', 'i').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function cellString(cell: ExcelJS.Cell): string | undefined {
  const value = cell.value
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value && typeof value === 'object' && 'richText' in value) {
    const richText = value.richText.map((part) => part.text).join('').trim()
    return richText || undefined
  }
  return undefined
}

function validateZipContainer(buffer: Buffer): void {
  const searchStart = Math.max(0, buffer.length - 65_557)
  let endOffset = -1
  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new ImportFileError('XLSX ZIP dizini bulunamadı veya desteklenmeyen ZIP64 biçimi kullanılmış.')
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const directorySize = buffer.readUInt32LE(endOffset + 12)
  let offset = buffer.readUInt32LE(endOffset + 16)
  if (entryCount > MAX_ZIP_ENTRIES || offset + directorySize > endOffset) throw new ImportFileError('XLSX arşivi geçersiz veya çok sayıda dosya içeriyor.')
  let totalUncompressed = 0
  let hasWorkbook = false
  let hasContentTypes = false
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new ImportFileError('XLSX arşiv dizini bozuk.')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    if ((flags & 0x1) !== 0) throw new ImportFileError('Parola korumalı Excel dosyaları desteklenmiyor.')
    if (![0, 8].includes(method) || uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) throw new ImportFileError('XLSX arşiv biçimi desteklenmiyor.')
    if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES || compressedSize === 0 && uncompressedSize > 0 || uncompressedSize > compressedSize * 200) {
      throw new ImportFileError('XLSX arşivinde izin verilenden büyük veya aşırı sıkıştırılmış içerik var.', 413)
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_UNCOMPRESSED_TOTAL_BYTES) throw new ImportFileError('XLSX açılmış içerik sınırını aşıyor.', 413)
    const nameStart = offset + 46
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    if (name.startsWith('/') || name.split('/').includes('..')) throw new ImportFileError('XLSX arşivinde geçersiz dosya yolu var.')
    if (/vbaProject\.bin$/i.test(name)) throw new ImportFileError('Makro içeren çalışma kitapları desteklenmiyor.')
    if (name === 'xl/workbook.xml') hasWorkbook = true
    if (name === '[Content_Types].xml') hasContentTypes = true
    offset = nameStart + nameLength + extraLength + commentLength
  }
  if (!hasWorkbook || !hasContentTypes) throw new ImportFileError('Dosya geçerli bir Excel XLSX çalışma kitabı değil.')
}

export async function parseStudentWorkbook(buffer: Buffer): Promise<{ records: StudentImportRecord[]; warnings: ImportFileWarning[] }> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    throw new ImportFileError('Dosya geçerli bir XLSX çalışma kitabı değil.')
  }
  validateZipContainer(buffer)

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Uint8Array.from(buffer).buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch {
    throw new ImportFileError('XLSX dosyası bozuk, parola korumalı veya desteklenmiyor.')
  }

  const sheet = workbook.worksheets.find((candidate) => candidate.state === 'visible')
  if (!sheet) throw new ImportFileError('Dosyada görünür bir çalışma sayfası bulunamadı.')
  if (sheet.rowCount > MAX_ROWS + 25 || sheet.columnCount > MAX_COLUMNS) {
    throw new ImportFileError(`Çalışma sayfası en fazla ${MAX_ROWS} satır ve ${MAX_COLUMNS} sütun içerebilir.`, 413)
  }

  const warnings: ImportFileWarning[] = workbook.worksheets
    .filter((candidate) => candidate.id !== sheet.id)
    .map((candidate) => ({ type: 'EXTRA_WORKSHEET', value: candidate.name }))

  let headerRow: ExcelJS.Row | undefined
  let fieldColumns = new Map<string, number>()
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 25); rowNumber++) {
    const row = sheet.getRow(rowNumber)
    const found = new Map<string, number>()
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const header = normalizeHeader(cellString(cell) ?? '')
      for (const field of HEADER_FIELDS) {
        if (HEADER_ALIASES[field].map(normalizeHeader).includes(header) && !found.has(field)) found.set(field, columnNumber)
      }
    })
    if (HEADER_FIELDS.every((field) => found.has(field))) {
      headerRow = row
      fieldColumns = found
      break
    }
  }
  if (!headerRow) throw new ImportFileError('BİLSEM numarası, ad, soyad, yetenek alanı ve danışman öğretmen başlıklarının tümü gerekli.')

  const knownColumns = new Set(fieldColumns.values())
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const name = cellString(cell) ?? ''
    if (!knownColumns.has(columnNumber)) warnings.push({ type: 'UNEXPECTED_COLUMN', rowNumber: headerRow!.number, columnNumber, value: name })
  })

  const records: StudentImportRecord[] = []
  for (let rowNumber = headerRow.number + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber)
    if (!row.hasValues) continue
    const mappedCells = [...fieldColumns.entries()].map(([field, column]) => [field, row.getCell(column)] as const)
    const formulaFields = mappedCells
      .filter(([, cell]) => Boolean(cell.value && typeof cell.value === 'object' && 'formula' in cell.value))
      .map(([field]) => field)
    const bilsemColumn = fieldColumns.get('bilsemNo')!
    const bilsemCell = row.getCell(bilsemColumn)
    const numericBilsemNo = typeof bilsemCell.value === 'number'
    const mappedValues = mappedCells.map(([, cell]) => cellString(cell))
    if (mappedValues.every((value) => value === undefined) && formulaFields.length === 0) {
      warnings.push({ type: 'UNEXPECTED_ROW', rowNumber, value: 'Eşleşen sütunlarda veri yok.' })
      continue
    }

    const get = (field: string) => {
      const column = fieldColumns.get(field)
      return column ? cellString(row.getCell(column)) : undefined
    }
    records.push({
      rowNumber,
      bilsemNo: numericBilsemNo ? undefined : get('bilsemNo'),
      firstName: get('firstName'),
      lastName: get('lastName'),
      talentArea: get('talentArea'),
      advisorName: get('advisorName'),
      formulaFields,
      invalidFields: numericBilsemNo ? ['bilsemNo'] : [],
    })
  }

  if (records.length === 0) throw new ImportFileError('Çalışma sayfasında aktarılabilir öğrenci satırı bulunamadı.')
  return { records, warnings }
}
