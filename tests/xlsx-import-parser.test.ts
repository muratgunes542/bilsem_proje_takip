import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { parseStudentWorkbook } from '../server/services/xlsx-import-parser'

async function parseNumber(value: string | number, numFmt?: string) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('TEST')
  sheet.addRow(['BİLSEM No', 'Ad', 'Soyad', 'Yetenek Alanı', 'Danışman Öğretmen'])
  const row = sheet.addRow([value, 'TEST Ada', 'TEST Yılmaz', 'TEST Müzik', 'TEST Öğretmen'])
  if (numFmt) row.getCell(1).numFmt = numFmt
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  return parseStudentWorkbook(bytes)
}

describe('BİLSEM number Excel parsing', () => {
  it('accepts digit-only text and preserves leading zeroes', async () => {
    const result = await parseNumber('00042')
    expect(result.records[0]).toMatchObject({ bilsemNo: '00042', invalidFields: [] })
  })
  it('safely converts integer cells and applies an unambiguous zero-only format', async () => {
    expect((await parseNumber(42)).records[0]).toMatchObject({ bilsemNo: '42', invalidFields: [] })
    expect((await parseNumber(42, '00000')).records[0]).toMatchObject({ bilsemNo: '00042', invalidFields: [] })
  })
  it('rejects decimals, negative numbers, scientific formats and invalid text', async () => {
    for (const [value, format] of [[42.5, undefined], [-42, undefined], [42, '0.00E+00'], ['00 A', undefined]] as const) {
      const parsed = (await parseNumber(value, format)).records[0]
      expect(parsed?.invalidFields).toContain('bilsemNo')
    }
  })
})
