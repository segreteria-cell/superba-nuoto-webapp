import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import LZString from 'lz-string'
import * as XLSX from 'xlsx'
import XLSXStyle from 'xlsx-js-style'
import { ref as rtdbRef, set as rtdbSet, get as rtdbGet } from 'firebase/database'
import { rtdb } from '../lib/firebase'

// ── Firebase ──────────────────────────────────────────────────────────────────

async function cloudSave(rows) {
  const compressed = LZString.compress(JSON.stringify(rows))
  await rtdbSet(rtdbRef(rtdb, 'graduatorie'), {
    timestamp: new Date().toISOString(),
    total: rows.length,
    data: compressed,
  })
}

async function cloudLoad() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'graduatorie'))
  if (!snap.exists()) return null
  const val = snap.val()
  const rows = JSON.parse(LZString.decompress(val.data))
  return { rows, timestamp: val.timestamp }
}

const lsGet = (key, fallback = null) => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const dec = LZString.decompress(raw)
    return JSON.parse(dec || raw)
  } catch { return fallback }
}
const lsSet = (key, value) => {
  try { localStorage.setItem(key, LZString.compress(JSON.stringify(value))) }
  catch (e) { console.warn('localStorage write failed:', e.message); try { localStorage.removeItem(key) } catch {} }
}

// ── Costanti ──────────────────────────────────────────────────────────────────

const TOP_N_OPTIONS = [10, 25, 50, 100, 500]
const CACHE_KEY     = 'grad_allRows'

const CAT_ORDER  = ['RAGAZZI', 'JUNIORES', 'CADETTI', 'SENIORES', 'ASSOLUTI']
const CAT_FILTER = {
  RAGAZZI:  c => c.toUpperCase().includes('RAGAZZI'),
  JUNIORES: c => c.toUpperCase().includes('JUNIORES'),
  CADETTI:  c => c.toUpperCase().includes('CADETTI'),
  SENIORES: c => c.toUpperCase().includes('SENIORES'),
  ASSOLUTI: ()  => true,
}

const SPEC_ABBR  = { STILE: 'SL', DORSO: 'DO', RANA: 'RA', FARFALLA: 'FA', MISTI: 'MX' }
const SPEC_LABEL = { STILE: 'STILE', DORSO: 'DORSO', RANA: 'RANA', FARFALLA: 'FARFALLA', MISTI: 'MISTI' }
const SPEC_ORDER = ['STILE', 'DORSO', 'RANA', 'FARFALLA', 'MISTI']
const DIST_ORDER = [50, 100, 200, 400, 800, 1500]

const STAFFETTE_DEF = [
  { sheet: '4x100 SL', spec: 'STILE', dist: 100 },
  { sheet: '4x200 SL', spec: 'STILE', dist: 200 },
  { sheet: '4x100 MX', spec: 'MISTI', dist: 100, solo25: true },
]

// ── Tempo helpers ─────────────────────────────────────────────────────────────

function tempoToSeconds(raw) {
  if (!raw) return null
  const s = String(raw).replace(',', '.').trim()
  let m = s.match(/^(\d{2}):(\d{2}):(\d{2}\.\d+)$/)
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
  m = s.match(/^(\d+):(\d{2}\.\d+)$/)
  if (m) return parseInt(m[1]) * 60 + parseFloat(m[2])
  m = s.match(/^(\d{1,3}\.\d+)$/)
  if (m) return parseFloat(m[1])
  return null
}

function secondsToTempo(secs) {
  if (secs == null || isNaN(secs)) return '—'
  const mins  = Math.floor(secs / 60)
  const ssF   = secs - mins * 60
  const ssInt = Math.floor(ssF)
  const cc    = Math.round((ssF - ssInt) * 100)
  const ssStr = String(ssInt).padStart(2, '0')
  const ccStr = String(cc).padStart(2, '0')
  return mins === 0 ? `${ssStr},${ccStr}` : `${String(mins).padStart(2, '0')}:${ssStr},${ccStr}`
}

function formatTempo(raw) {
  if (!raw) return '—'
  const secs = tempoToSeconds(raw)
  if (secs == null) return String(raw).trim()
  return secondsToTempo(secs)
}

function sumTempi(tempiRaw) {
  const secs = tempiRaw.map(tempoToSeconds)
  if (secs.some(s => s == null)) return '—'
  return secondsToTempo(secs.reduce((a, b) => a + b, 0))
}

// ── Parsing xlsx ──────────────────────────────────────────────────────────────

function parseStagioneFromName(filename) {
  const m = filename.match(/(\d{2}-\d{2})/)
  return m ? m[1] : filename.replace(/\.[^.]+$/, '')
}

function normalizeVasca(v) {
  const s = String(v || '').replace(/metri/i, '').replace(/m$/i, '').trim()
  if (s === '25' || s.startsWith('25')) return '25m'
  if (s === '50' || s.startsWith('50')) return '50m'
  return String(v || '').trim()
}

function normalizeSesso(s) {
  const x = String(s || '').toLowerCase()
  if (x === 'female' || x === 'f') return 'F'
  if (x === 'male'   || x === 'm') return 'M'
  return s
}

function parseDataFromEvento(evento) {
  const m = String(evento || '').match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(.+)$/)
  if (m) return { data: m[1], gara: m[2].trim() }
  return { data: '', gara: String(evento || '') }
}

function parseXlsxFile(file) {
  return new Promise((resolve, reject) => {
    const stagione = parseStagioneFromName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb  = XLSX.read(e.target.result, { type: 'array', cellDates: false })
        const ws  = wb.Sheets[wb.SheetNames[0]]
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
        if (raw.length < 2) { resolve([]); return }

        const normH = h => String(h).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim()
        const hdrs  = raw[0].map(normH)
        const idx   = name => hdrs.findIndex(h => h.includes(name))

        const iEv   = idx('EVENTO')
        const iNome = idx('NOME')
        const iCog  = idx('COGNOME')
        const iSoc  = idx('SOCIETA')
        const iCat  = idx('CATEGORIA')
        const iSex  = idx('SESSO')
        const iVas  = idx('VASCA')
        const iSpec = idx('SPECIALIT')
        const iDist = idx('DISTANZA')
        const iPos  = idx('POS')
        const iTemp = idx('TEMPO')
        const iFINA = idx('FINA')

        const rows = []
        for (let i = 1; i < raw.length; i++) {
          const r = raw[i]
          if (!r || r.every(c => c === '')) continue
          const g = j => (j >= 0 && j < r.length) ? r[j] : ''
          const evento = g(iEv)
          const { data, gara } = parseDataFromEvento(evento)
          const fina     = parseFloat(String(g(iFINA)).replace(',', '.')) || 0
          const distanza = parseInt(String(g(iDist)), 10) || 0
          const nome     = String(g(iNome)).trim()
          const cognome  = String(g(iCog)).trim()
          const tempo    = String(g(iTemp)).trim()
          rows.push({
            id:        i,
            atleta:    [cognome, nome].filter(Boolean).join(' '),
            societa:   String(g(iSoc)).trim(),
            categoria: String(g(iCat)).trim(),
            sesso:     normalizeSesso(g(iSex)),
            vasca:     normalizeVasca(g(iVas)),
            specialita: String(g(iSpec)).trim().toUpperCase(),
            distanza,
            pos:       parseInt(String(g(iPos)).replace('.', ''), 10) || 0,
            tempo,
            tempoFmt:  formatTempo(tempo),
            fina,
            gara,
            data,
            stagione,
          })
        }
        resolve(rows)
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// ── Logica graduatoria ────────────────────────────────────────────────────────

function applyFilters(rows, { stagione, vasca, sesso, categoria, specialita, distanza }) {
  return rows.filter(r => {
    if (stagione   && r.stagione   !== stagione) return false
    if (vasca      && r.vasca      !== vasca) return false
    if (sesso      && r.sesso      !== sesso) return false
    if (categoria  && r.categoria  !== categoria) return false
    if (specialita && r.specialita !== specialita) return false
    if (distanza   && r.distanza   !== parseInt(distanza, 10)) return false
    return true
  })
}

function deduplicateBest(rows) {
  const best = new Map()
  for (const r of rows) {
    const key = `${r.atleta}|${r.sesso}`
    const cur = best.get(key)
    if (!cur || r.fina > cur.fina) best.set(key, r)
  }
  return Array.from(best.values())
}

function buildGraduatoria(allRows, filters, topN, bestPerAtleta) {
  let rows = applyFilters(allRows, filters)
  if (bestPerAtleta) rows = deduplicateBest(rows)
  rows.sort((a, b) => b.fina - a.fina)
  return rows.slice(0, topN).map((r, i) => ({ ...r, posGrad: i + 1 }))
}

// ── Temi colori per sesso ─────────────────────────────────────────────────────

const THEME = {
  F: {
    title:   'C2185B', colHdr: 'F06292', evt: 'E91E8C',
    sTitle:  'AD1457', sCat:   '880E4F', sCol: 'F48FB1',
    frazLbl: 'E91E8C', totLbl: '880E4F', totData: 'FCE4EC',
  },
  M: {
    title:   '0D47A1', colHdr: '42A5F5', evt: '1565C0',
    sTitle:  '0D47A1', sCat:   '0A2540', sCol: '90CAF9',
    frazLbl: '1565C0', totLbl: '1A237E', totData: 'E3F2FD',
  },
}

// Data row colors: pos 1-4 fissi, poi EAF5FC/FFFFFF alternati
function dataRowFill(i) {
  const c = ['FFF8E1', 'F5F5F5', 'FBE9E7', 'FFFFFF']
  if (i < 4) return c[i]
  return i % 2 === 0 ? 'EAF5FC' : 'FFFFFF'
}

function xsFill(rgb)  { return rgb ? { patternType: 'solid', fgColor: { rgb } } : {} }
function fntWBL(sz=13){ return { bold: true, color: { rgb: 'FFFFFF' }, sz } }
function fntWB(sz=10) { return { bold: true, color: { rgb: 'FFFFFF' }, sz } }
function fntDB(sz=10) { return { bold: true, color: { rgb: '333333' }, sz } }
function fntD()       { return { color: { rgb: '444444' } } }
function fntFINA(b)   { return { bold: !!b, color: { rgb: '1565C0' } } }

const AL = { horizontal: 'left',   vertical: 'center' }
const AC = { horizontal: 'center', vertical: 'center' }
const AR = { horizontal: 'right',  vertical: 'center' }

function xsCell(ws, r, c, val, rgb, fnt, al) {
  const ref = XLSX.utils.encode_cell({ r, c })
  const t   = typeof val === 'number' ? 'n' : 's'
  ws[ref]   = { v: val ?? '', t: val == null ? 's' : t,
    s: { fill: xsFill(rgb), font: fnt || {}, alignment: al || AL } }
}

function xsMerge(merges, r1, c1, r2, c2) {
  merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } })
}

function xsSetRef(ws, rows, cols) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { r:0, c:0 }, e: { r:rows-1, c:cols-1 } })
}

function xlsxDownload(wb, filename) {
  const buf  = XLSXStyle.write(wb, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url  = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

// ── Export: Graduatorie Top N ─────────────────────────────────────────────────

function generateTopNExport(allRows, stagione, topN, bestPerAtleta) {
  const wb    = XLSX.utils.book_new()
  const NCOLS = 5   // #, ATLETA, TEMPO, FINA, sep
  const TCOLS = CAT_ORDER.length * NCOLS  // 25

  const colWidths = []
  for (let ci = 0; ci < CAT_ORDER.length; ci++) {
    const b = ci * NCOLS
    colWidths[b]   = { wch: 3.5 }
    colWidths[b+1] = { wch: 19  }
    colWidths[b+2] = { wch: 9   }
    colWidths[b+3] = { wch: 6.5 }
    colWidths[b+4] = { wch: 1.2 }
  }

  const VASCHE = [{ key: '25m', label: '25 METRI' }, { key: '50m', label: '50 METRI' }]
  const SESSI  = [{ key: 'F',   label: 'FEMMINE'  }, { key: 'M',   label: 'MASCHI'   }]
  const stagLabel = stagione ? stagione.replace(/^(\d{2})-(\d{2})$/, '20$1/20$2') : '—'

  for (const vasc of VASCHE) {
    for (const sess of SESSI) {
      const T = THEME[sess.key]
      const ws = {}; ws['!cols'] = colWidths; ws['!rows'] = []; const merges = []
      let row = 0

      // ROW 0 — Title
      ws['!rows'][row] = { hpx: 24 }
      xsCell(ws, row, 0,
        `GRADUATORIE  Top ${topN}  —  VASCA ${vasc.label}  —  ${sess.key==='F'?'FEMMINE':'MASCHI'}  —  Stagione ${stagLabel}`,
        T.title, fntWBL(13), AC)
      for (let c = 1; c < TCOLS; c++) xsCell(ws, row, c, null, T.title, {}, {})
      xsMerge(merges, row, 0, row, TCOLS-1); row++

      // ROW 1 — Category headers
      ws['!rows'][row] = { hpx: 18 }
      CAT_ORDER.forEach((cat, ci) => {
        const b = ci * NCOLS
        xsCell(ws, row, b, cat, '37474F', fntWB(11), AC)
        for (let c = 1; c < 4; c++) xsCell(ws, row, b+c, null, '37474F', {}, {})
        xsMerge(merges, row, b, row, b+3)
        xsCell(ws, row, b+4, null, null, {}, {})
      }); row++

      // ROW 2 — Column headers
      ws['!rows'][row] = { hpx: 14 }
      CAT_ORDER.forEach((_, ci) => {
        const b = ci * NCOLS
        ;[['#',AC],['ATLETA',AL],['TEMPO',AC],['FINA',AR]].forEach(([h, al], j) =>
          xsCell(ws, row, b+j, h, T.colHdr, fntWB(9), al))
        xsCell(ws, row, b+4, null, null, {}, {})
      }); row++

      // DATA — events
      for (const spec of SPEC_ORDER) {
        for (const dist of DIST_ORDER) {
          const catData = CAT_ORDER.map(cat => {
            const base = applyFilters(allRows, { stagione, vasca: vasc.key, sesso: sess.key, specialita: spec, distanza: String(dist) })
            let filtered = cat === 'ASSOLUTI' ? base : base.filter(r => CAT_FILTER[cat](r.categoria))
            if (bestPerAtleta) filtered = deduplicateBest(filtered)
            return filtered.sort((a, b) => b.fina - a.fina).slice(0, topN)
          })
          if (!catData.some(a => a.length > 0)) continue

          // Event label
          ws['!rows'][row] = { hpx: 20 }
          xsCell(ws, row, 0, `  ${dist}m  ${spec}  (${SPEC_ABBR[spec]||spec})`, T.evt, fntWB(10), AL)
          for (let c = 1; c < TCOLS; c++) xsCell(ws, row, c, null, T.evt, {}, {})
          xsMerge(merges, row, 0, row, TCOLS-1); row++

          // Data rows
          const maxLen = Math.max(...catData.map(a => a.length))
          for (let i = 0; i < maxLen; i++) {
            ws['!rows'][row] = { hpx: 15 }
            const fg = dataRowFill(i)
            CAT_ORDER.forEach((_, ci) => {
              const b = ci * NCOLS; const r = catData[ci][i]
              xsCell(ws, row, b,   r ? i+1 : null, fg, r ? fntDB(9) : {}, AC)
              xsCell(ws, row, b+1, r ? r.atleta : null, fg, fntD(), AL)
              xsCell(ws, row, b+2, r ? r.tempoFmt : null, fg, fntD(), AC)
              xsCell(ws, row, b+3, r ? Math.round(r.fina) : null, fg, fntFINA(!!r), AR)
              xsCell(ws, row, b+4, null, null, {}, {})
            }); row++
          }

          // Spacer
          ws['!rows'][row] = { hpx: 5 }; row++
        }
      }

      ws['!merges'] = merges
      xsSetRef(ws, row, TCOLS)
      XLSX.utils.book_append_sheet(wb, ws,
        `${vasc.key==='25m'?'25':'50'} ${sess.key==='F'?'Femmine':'Maschi'}`)
    }
  }

  const stagFile = stagione ? stagione.replace('-','_') : 'tutte'
  xlsxDownload(wb, `Graduatorie_Top${topN}_${stagFile}.xlsx`)
}

// ── Export: Staffette ─────────────────────────────────────────────────────────

function generateStaffetteExport(allRows, stagione) {
  const wb    = XLSX.utils.book_new()
  const NCOLS = 6   // #,RUOLO,ATLETA,TEMPO,FINA,sep (ultimo cat senza sep)
  const TCOLS = CAT_ORDER.length * NCOLS - 1  // 29

  const colWidths = []
  for (let ci = 0; ci < CAT_ORDER.length; ci++) {
    const b = ci * NCOLS
    colWidths[b]   = { wch: 3.5  }
    colWidths[b+1] = { wch: 6.0  }
    colWidths[b+2] = { wch: 22.0 }
    colWidths[b+3] = { wch: 10.0 }
    colWidths[b+4] = { wch: 6.5  }
    if (ci < CAT_ORDER.length - 1) colWidths[b+5] = { wch: 1.5 }
  }

  const VASCHE  = [{ key: '25m', label: '25 METRI' }, { key: '50m', label: '50 METRI' }]
  const SESSI   = [{ key: 'F',   label: 'FEMMINE'  }, { key: 'M',   label: 'MASCHI'   }]
  const FRAZ_BG = ['FFF8E1', 'F5F5F5', 'FBE9E7', 'EAF5FC']
  const RIS_BG  = ['F8F8F8', 'EFEFEF', 'F8F8F8']

  for (const staffDef of STAFFETTE_DEF) {
    const vascheDa = staffDef.solo25 ? [VASCHE[0]] : VASCHE
    for (const vasc of vascheDa) {
      for (const sess of SESSI) {
        const T  = THEME[sess.key]
        const ws = {}; ws['!cols'] = colWidths; ws['!rows'] = []; const merges = []
        let row  = 0
        const vNum = vasc.key.replace('m', '')

        // ROW 0 — Title
        ws['!rows'][row] = { hpx: 30 }
        xsCell(ws, row, 0,
          `  STAFFETTA ${staffDef.sheet}  —  VASCA ${vasc.label}  —  ${sess.key==='F'?'FEMMINE':'MASCHI'}`,
          T.sTitle, fntWBL(13), AL)
        for (let c = 1; c < TCOLS; c++) xsCell(ws, row, c, null, T.sTitle, {}, {})
        xsMerge(merges, row, 0, row, TCOLS-1); row++

        // ROW 1 — Category headers
        ws['!rows'][row] = { hpx: 22 }
        CAT_ORDER.forEach((cat, ci) => {
          const b = ci * NCOLS
          xsCell(ws, row, b, cat, T.sCat, fntWB(11), AC)
          for (let c = 1; c <= 4; c++) xsCell(ws, row, b+c, null, T.sCat, {}, {})
          xsMerge(merges, row, b, row, b+4)
          if (ci < CAT_ORDER.length - 1) xsCell(ws, row, b+5, null, null, {}, {})
        }); row++

        // ROW 2 — Column headers
        ws['!rows'][row] = { hpx: 18 }
        CAT_ORDER.forEach((_, ci) => {
          const b = ci * NCOLS
          ;[['#',AC],['RUOLO',AC],['ATLETA',AL],['TEMPO',AC],['FINA',AR]].forEach(([h,al],j) =>
            xsCell(ws, row, b+j, h, T.sCol, fntDB(9), al))
          if (ci < CAT_ORDER.length - 1) xsCell(ws, row, b+5, null, null, {}, {})
        }); row++

        // Get athletes
        const catAtleti = CAT_ORDER.map(cat => {
          const base = applyFilters(allRows, { stagione, vasca: vasc.key, sesso: sess.key,
            specialita: staffDef.spec, distanza: String(staffDef.dist) })
          let filtered = cat === 'ASSOLUTI' ? base : base.filter(r => CAT_FILTER[cat](r.categoria))
          filtered = deduplicateBest(filtered)
          return filtered.sort((a, b) => b.fina - a.fina).slice(0, 7)
        })

        // FRAZ 1-4
        for (let i = 0; i < 4; i++) {
          ws['!rows'][row] = { hpx: 22 }
          CAT_ORDER.forEach((_, ci) => {
            const b = ci * NCOLS; const r = catAtleti[ci][i]
            xsCell(ws, row, b,   i+1,           T.frazLbl, fntWB(10), AC)
            xsCell(ws, row, b+1, `FRAZ ${i+1}`, T.frazLbl, fntWB(10), AC)
            xsCell(ws, row, b+2, r ? r.atleta : null,    FRAZ_BG[i], fntD(), AL)
            xsCell(ws, row, b+3, r ? r.tempoFmt : null,   FRAZ_BG[i], fntD(), AC)
            xsCell(ws, row, b+4, r ? Math.round(r.fina) : null, FRAZ_BG[i], fntFINA(!!r), AR)
            if (ci < CAT_ORDER.length - 1) xsCell(ws, row, b+5, null, null, {}, {})
          }); row++
        }

        // TOTALE
        ws['!rows'][row] = { hpx: 22 }
        CAT_ORDER.forEach((_, ci) => {
          const b = ci * NCOLS
          const tit   = catAtleti[ci].slice(0, 4)
          const total = tit.length === 4 && tit.every(r => r) ? sumTempi(tit.map(r => r.tempo)) : '—'
          xsCell(ws, row, b,   'TOTALE', T.totLbl, fntWB(10), AC)
          xsCell(ws, row, b+1, null,     T.totLbl, {}, {})
          xsMerge(merges, row, b, row, b+1)
          xsCell(ws, row, b+2, total, T.totData, { bold: true, color: { rgb: '333333' }, sz: 10 }, AC)
          xsCell(ws, row, b+3, null,  T.totData, {}, {})
          xsCell(ws, row, b+4, null,  T.totData, {}, {})
          xsMerge(merges, row, b+2, row, b+4)
          if (ci < CAT_ORDER.length - 1) xsCell(ws, row, b+5, null, null, {}, {})
        }); row++

        // RISERVE header
        ws['!rows'][row] = { hpx: 14 }
        CAT_ORDER.forEach((_, ci) => {
          const b = ci * NCOLS
          xsCell(ws, row, b, '▼  RISERVE', '78909C', fntWB(9), AC)
          for (let c = 1; c <= 4; c++) xsCell(ws, row, b+c, null, '78909C', {}, {})
          xsMerge(merges, row, b, row, b+4)
          if (ci < CAT_ORDER.length - 1) xsCell(ws, row, b+5, null, null, {}, {})
        }); row++

        // RIS 1-3
        for (let i = 0; i < 3; i++) {
          ws['!rows'][row] = { hpx: 22 }
          CAT_ORDER.forEach((_, ci) => {
            const b = ci * NCOLS; const r = catAtleti[ci][4+i]
            xsCell(ws, row, b,   i+1,          '78909C', fntWB(10), AC)
            xsCell(ws, row, b+1, `RIS ${i+1}`, '78909C', fntWB(10), AC)
            xsCell(ws, row, b+2, r ? r.atleta : null,   RIS_BG[i], fntD(), AL)
            xsCell(ws, row, b+3, r ? r.tempoFmt : null,  RIS_BG[i], fntD(), AC)
            xsCell(ws, row, b+4, r ? Math.round(r.fina) : null, RIS_BG[i], fntFINA(false), AR)
            if (ci < CAT_ORDER.length - 1) xsCell(ws, row, b+5, null, null, {}, {})
          }); row++
        }

        ws['!rows'][row] = { hpx: 10 }; row++
        ws['!merges'] = merges
        xsSetRef(ws, row, TCOLS)
        XLSX.utils.book_append_sheet(wb, ws, `${staffDef.sheet} - ${vNum}${sess.key}`)
      }
    }
  }

  const stagFile = stagione ? stagione.replace('-','_') : 'tutte'
  xlsxDownload(wb, `Staffette_${stagFile}.xlsx`)
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function Graduatorie() {
  const fileInputRef = useRef(null)

  const [allRows,    setAllRows]    = useState(() => lsGet(CACHE_KEY, []))
  const [lastUpdate, setLastUpdate] = useState(() => localStorage.getItem('grad_lastupdate') || '')
  const [loadingFile, setLoadingFile] = useState(false)
  const [syncing,    setSyncing]    = useState(false)
  const [cloudLoading, setCloudLoading] = useState(false)
  const [error,      setError]      = useState('')

  const [stagione,   setStagione]   = useState('')
  const [vasca,      setVasca]      = useState('')
  const [sesso,      setSesso]      = useState('')
  const [categoria,  setCategoria]  = useState('')
  const [specialita, setSpecialita] = useState('')
  const [distanza,   setDistanza]   = useState('')
  const [topN,       setTopN]       = useState(10)
  const [bestPerAtleta, setBestPerAtleta] = useState(false)

  const [graduatoria, setGraduatoria] = useState([])
  const [sortCol,     setSortCol]     = useState('posGrad')
  const [sortDir,     setSortDir]     = useState(1)
  const hasGeneratedRef = useRef(false)

  const handleCloudLoad = useCallback(() => {
    setCloudLoading(true); setError('')
    cloudLoad()
      .then(data => {
        if (data?.rows?.length > 0) {
          setAllRows(data.rows)
          lsSet(CACHE_KEY, data.rows)
          const ts = data.timestamp ? new Date(data.timestamp).toLocaleString('it-IT') : ''
          setLastUpdate(`Da cloud · ${ts || '—'}`)
        } else {
          setError('Nessun dato trovato su Firebase. Carica prima un file xlsx.')
        }
      })
      .catch(e => setError(`Errore Firebase: ${e.message}`))
      .finally(() => setCloudLoading(false))
  }, [])

  useEffect(() => {
    if (allRows.length > 0) return
    handleCloudLoad()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const stagioniOpts   = useMemo(() => [...new Set(allRows.map(r => r.stagione))].filter(Boolean).sort(), [allRows])
  const categorieOpts  = useMemo(() => [...new Set(allRows.map(r => r.categoria))].filter(Boolean).sort(), [allRows])
  const specialitaOpts = useMemo(() => [...new Set(allRows.map(r => r.specialita))].filter(Boolean).sort(), [allRows])
  const distanzeOpts   = useMemo(() => [...new Set(allRows.map(r => r.distanza))].filter(Boolean).sort((a, b) => a - b), [allRows])

  const handleFileChange = useCallback(async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setLoadingFile(true); setError('')
    try {
      const parsed = []
      for (const file of files) {
        const rows = await parseXlsxFile(file)
        parsed.push(...rows)
      }
      const newStag = new Set(parsed.map(r => r.stagione))
      const merged  = [...allRows.filter(r => !newStag.has(r.stagione)), ...parsed]
      setAllRows(merged)
      lsSet(CACHE_KEY, merged)
      const now = new Date().toLocaleString('it-IT')
      setLastUpdate(now); localStorage.setItem('grad_lastupdate', now)
      setSyncing(true)
      cloudSave(merged).catch(e => console.warn('[RTDB] save:', e)).finally(() => setSyncing(false))
    } catch (err) {
      setError(`Errore parsing: ${err.message}`)
    } finally {
      setLoadingFile(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [allRows])

  const handleGenera = useCallback(() => {
    hasGeneratedRef.current = true
    const result = buildGraduatoria(
      allRows,
      { stagione, vasca, sesso, categoria, specialita, distanza },
      topN, bestPerAtleta
    )
    setGraduatoria(result)
    setSortCol('posGrad'); setSortDir(1)
  }, [allRows, stagione, vasca, sesso, categoria, specialita, distanza, topN, bestPerAtleta])

  useEffect(() => {
    if (!hasGeneratedRef.current) return
    setGraduatoria(
      buildGraduatoria(allRows, { stagione, vasca, sesso, categoria, specialita, distanza }, topN, bestPerAtleta)
    )
    setSortCol('posGrad'); setSortDir(1)
  }, [bestPerAtleta]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClear = () => {
    try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem('grad_lastupdate') } catch {}
    setAllRows([]); setGraduatoria([]); setLastUpdate(''); setError('')
  }

  const displayRows = useMemo(() => {
    return [...graduatoria].sort((a, b) => {
      let av = a[sortCol] ?? '', bv = b[sortCol] ?? ''
      if (['posGrad', 'fina', 'distanza'].includes(sortCol)) return (Number(av) - Number(bv)) * sortDir
      return String(av).localeCompare(String(bv), 'it') * sortDir
    })
  }, [graduatoria, sortCol, sortDir])

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => -d)
    else { setSortCol(col); setSortDir(col === 'fina' ? -1 : 1) }
  }

  const stats = useMemo(() => ({
    tot:    allRows.length,
    atleti: new Set(graduatoria.map(r => r.atleta)).size,
    gare:   new Set(graduatoria.map(r => r.gara)).size,
    inGrad: graduatoria.length,
  }), [allRows, graduatoria])

  const exportCols = [
    ['Pos','posGrad'], ['Atleta','atleta'], ['Societa','societa'],
    ['Categoria','categoria'], ['Sesso','sesso'], ['Vasca','vasca'],
    ['Specialita','specialita'], ['Distanza','distanza'],
    ['Tempo','tempoFmt'], ['FINA','fina'], ['Gara','gara'], ['Data','data'],
  ]

  const handleExportXLSX = () => {
    if (!displayRows.length) return
    const wsData = [exportCols.map(c => c[0]), ...displayRows.map(r => exportCols.map(c => r[c[1]] ?? ''))]
    const ws = XLSX.utils.aoa_to_sheet(wsData)
    ws['!cols'] = [5,22,22,14,6,7,12,8,10,7,28,12].map(w => ({ wch: w }))
    const wbx = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wbx, ws, 'Graduatoria')
    XLSX.writeFile(wbx, `Graduatoria_${stagione || 'tutte'}_${new Date().toLocaleDateString('it-IT').replace(/\//g,'-')}.xlsx`)
  }

  const handleExportCSV = () => {
    if (!displayRows.length) return
    const lines = [
      exportCols.map(c => c[0]).join(';'),
      ...displayRows.map(r => exportCols.map(c => String(r[c[1]] ?? '').replace(/;/g, ',')).join(';')),
    ]
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a'); a.href = url
    a.download = `Graduatoria_${stagione || 'tutte'}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const rowCls = (pos, idx) => {
    if (pos === 1) return 'bg-yellow-50 border-l-4 border-yellow-400 font-semibold'
    if (pos === 2) return 'bg-slate-50  border-l-4 border-slate-300  font-semibold'
    if (pos === 3) return 'bg-orange-50 border-l-4 border-orange-300 font-semibold'
    return idx % 2 === 0 ? 'bg-white' : 'bg-sb-bg/30'
  }

  const SortTh = ({ col, children, align = 'left' }) => (
    <th onClick={() => handleSort(col)}
      className={`px-3 py-2 text-${align} text-xs font-semibold text-sb-muted uppercase tracking-wide cursor-pointer select-none hover:text-sb-text whitespace-nowrap`}>
      {children}{sortCol === col && <span className="ml-1 opacity-60">{sortDir === 1 ? '▲' : '▼'}</span>}
    </th>
  )

  return (
    <div className="flex flex-col gap-4 min-h-0">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-sb-text">Graduatorie</h1>
          <p className="text-xs text-sb-muted mt-0.5">
            {cloudLoading ? '☁ Caricamento da cloud...' : syncing ? '☁ Sincronizzazione...' : lastUpdate ? `Aggiornato: ${lastUpdate}` : ''}
            {allRows.length > 0 && ` · ${allRows.length.toLocaleString('it-IT')} risultati`}
            {stagioniOpts.length > 0 && ` · Stagioni: ${stagioniOpts.join(', ')}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" multiple className="hidden" onChange={handleFileChange} />
          <button onClick={() => fileInputRef.current?.click()} disabled={loadingFile}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-sb-blue text-white text-sm font-medium rounded-lg hover:bg-sb-blue/90 disabled:opacity-50 transition-colors">
            {loadingFile ? '⏳ Caricamento...' : '📂 Carica file xlsx'}
          </button>
          <button onClick={handleCloudLoad} disabled={cloudLoading}
            className="px-3 py-1.5 text-sm text-sb-blue border border-sb-blue/30 rounded-lg hover:bg-sb-blue/10 disabled:opacity-50 transition-colors">
            {cloudLoading ? '⏳' : '☁'} Da cloud
          </button>
          {allRows.length > 0 && (
            <button onClick={handleClear}
              className="px-3 py-1.5 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
              Pulisci
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>
      )}

      {/* Impostazioni */}
      <div className="bg-sb-panel border border-sb-sep rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sb-muted text-xs">⚙</span>
          <span className="text-xs font-semibold text-sb-muted uppercase tracking-widest">Impostazioni</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Stagione</label>
            <select value={stagione} onChange={e => setStagione(e.target.value)}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              <option value="">Tutte</option>
              {stagioniOpts.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Vasca</label>
            <select value={vasca} onChange={e => setVasca(e.target.value)}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              <option value="">Tutte</option>
              <option value="25m">25 m</option>
              <option value="50m">50 m</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Sesso</label>
            <select value={sesso} onChange={e => setSesso(e.target.value)}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              <option value="">Tutti</option>
              <option value="F">Femmine</option>
              <option value="M">Maschi</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Top N</label>
            <select value={topN} onChange={e => setTopN(Number(e.target.value))}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              {TOP_N_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Categoria</label>
            <select value={categoria} onChange={e => setCategoria(e.target.value)}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              <option value="">Tutte</option>
              {categorieOpts.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Specialità</label>
            <select value={specialita} onChange={e => setSpecialita(e.target.value)}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              <option value="">Tutte</option>
              {specialitaOpts.map(s => <option key={s} value={s}>{SPEC_LABEL[s] || s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-sb-muted mb-1 block">Distanza (m)</label>
            <select value={distanza} onChange={e => setDistanza(e.target.value)}
              className="w-full text-sm border border-sb-sep rounded-md px-2 py-1.5 bg-white text-sb-text">
              <option value="">Tutte</option>
              {distanzeOpts.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={bestPerAtleta} onChange={e => setBestPerAtleta(e.target.checked)}
                className="mt-0.5 rounded flex-shrink-0" />
              <span className="text-xs text-sb-text leading-tight">
                Miglior risultato per atleta<br />
                <span className="text-sb-muted">(Top FINA assoluto)</span>
              </span>
            </label>
          </div>
        </div>
        <div className="flex items-center gap-5 flex-wrap">
          <button onClick={handleGenera} disabled={!allRows.length}
            className="flex items-center gap-2 px-5 py-2 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 disabled:opacity-40 transition-colors text-sm">
            📊 GENERA GRADUATORIA
          </button>
          {graduatoria.length > 0 && (
            <div className="flex gap-4 text-xs text-sb-muted flex-wrap">
              <span>Risultati totali <strong className="text-sb-text">{stats.tot.toLocaleString('it-IT')}</strong></span>
              <span>Atleti <strong className="text-sb-text">{stats.atleti}</strong></span>
              <span>Gare <strong className="text-sb-text">{stats.gare}</strong></span>
              <span>In graduatoria <strong className="text-sb-text">{stats.inGrad}</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* Tabella */}
      <div className="bg-sb-panel border border-sb-sep rounded-xl overflow-hidden flex-1 min-h-0">
        <div className="bg-sb-blue/10 border-b border-sb-sep px-4 py-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-sb-blue uppercase tracking-wide">📋 Graduatoria</span>
          {graduatoria.length > 0 && (
            <span className="text-xs text-sb-muted ml-auto">{graduatoria.length} posizioni</span>
          )}
        </div>
        <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 440px)' }}>
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-sb-bg border-b border-sb-sep z-10">
              <tr>
                <SortTh col="posGrad" align="center">Pos</SortTh>
                <SortTh col="atleta">Atleta</SortTh>
                <SortTh col="societa">Società</SortTh>
                <SortTh col="categoria">Categoria</SortTh>
                <SortTh col="sesso" align="center">S</SortTh>
                <SortTh col="vasca" align="center">Vasca</SortTh>
                <SortTh col="tempoFmt" align="center">Tempo</SortTh>
                <SortTh col="fina" align="right">FINA</SortTh>
                <SortTh col="gara">Gara</SortTh>
                <SortTh col="data" align="center">Data</SortTh>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-16 text-sb-muted text-sm">
                    {allRows.length === 0
                      ? '📂 Carica un file GraduatorieSpeciali.xlsx per iniziare'
                      : 'Imposta i filtri e premi GENERA GRADUATORIA'}
                  </td>
                </tr>
              ) : displayRows.map((r, i) => (
                <tr key={`${r.id}-${i}`}
                  className={`border-b border-sb-sep/40 hover:bg-sb-blue/5 transition-colors ${rowCls(r.posGrad, i)}`}>
                  <td className="px-3 py-2 text-center font-bold text-sb-blue w-10">{r.posGrad}</td>
                  <td className="px-3 py-2 font-medium text-sb-text">{r.atleta}</td>
                  <td className="px-3 py-2 text-sb-muted text-xs">{r.societa}</td>
                  <td className="px-3 py-2 text-sb-muted text-xs">{r.categoria}</td>
                  <td className="px-3 py-2 text-center text-xs text-sb-muted">{r.sesso}</td>
                  <td className="px-3 py-2 text-center text-xs text-sb-muted">{r.vasca}</td>
                  <td className="px-3 py-2 text-center font-mono text-xs">{r.tempoFmt}</td>
                  <td className="px-3 py-2 text-right font-semibold text-sb-blue">{r.fina}</td>
                  <td className="px-3 py-2 text-xs text-sb-muted max-w-xs truncate" title={r.gara}>{r.gara}</td>
                  <td className="px-3 py-2 text-center text-xs text-sb-muted whitespace-nowrap">{r.data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Export */}
      <div className="flex gap-2 flex-wrap pb-2">
        <button onClick={handleExportXLSX} disabled={!displayRows.length}
          className="flex items-center gap-1.5 px-4 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-40 transition-colors">
          📗 Esporta XLSX
        </button>
        <button onClick={handleExportCSV} disabled={!displayRows.length}
          className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 text-white text-sm font-medium rounded-lg hover:bg-teal-700 disabled:opacity-40 transition-colors">
          📄 Esporta CSV
        </button>
        <button onClick={() => generateTopNExport(allRows, stagione, topN, bestPerAtleta)} disabled={!allRows.length}
          className="flex items-center gap-1.5 px-4 py-2 bg-sb-blue text-white text-sm font-medium rounded-lg hover:bg-sb-blue/90 disabled:opacity-40 transition-colors">
          🏅 Esporta Graduatorie Top {topN}
        </button>
        <button onClick={() => generateStaffetteExport(allRows, stagione)} disabled={!allRows.length}
          className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-40 transition-colors">
          🏊 Esporta Staffette
        </button>
      </div>

    </div>
  )
}
