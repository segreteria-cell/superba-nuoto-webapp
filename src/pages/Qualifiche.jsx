import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import LZString from 'lz-string'
import * as XLSX from 'xlsx'
import XLSXStyle from 'xlsx-js-style'
import { ref as rtdbRef, set as rtdbSet, get as rtdbGet } from 'firebase/database'
import { rtdb } from '../lib/firebase'
import { ELENCO_ATLETI } from '../lib/elencoAtleti'
import { extractPdfText, parseProgramma, parseProgrammaVision, parseGraduatoriaLimiti } from '../lib/parseProgramma'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SEZIONE_FULL_TO_ABBR = {
  'NUOTATORI GENOVESI':    'NG',
  'IDEA SPORT':            'IS',
  'CROCERA STADIUM':       'CR',
  'RAPALLO NUOTO':         'RN',
  'LAVAGNA 90':            'LA',
  'AQUARIUM VALLESCRIVIA': 'AV',
  'AQUARIUM':              'AQ',
  'RARI NANTES SPEZIA':    'SP',
  'SUPERBANUOTO':          'AS',
}
const SEZIONE_ORDER    = ['NG', 'IS', 'SP', 'CR', 'RN', 'AQ', 'AV', 'LA', 'AS']
const SPEC_ABBR        = { STILE: 'SL', DORSO: 'DO', RANA: 'RA', FARFALLA: 'FA', MISTI: 'MX' }
const SPEC_LABEL       = { SL: 'STILE', DO: 'DORSO', RA: 'RANA', FA: 'FARFALLA', MX: 'MISTI' }
const SPEC_ORDER       = ['SL', 'DO', 'RA', 'FA', 'MX']
const CAT_ORDER        = ['RAGAZZI', 'JUNIORES', 'CADETTI', 'SENIORES', 'ASSOLUTI']
const CATEGORIE_ATLETA = [
  'RAGAZZI 1 Anno','RAGAZZI 2 Anno',
  'JUNIORES 1 Anno','JUNIORES 2 Anno',
  'CADETTI 1 Anno','CADETTI 2 Anno',
  'SENIORES','ASSOLUTI',
]
const SPECIALITA_LIST = ['Stile Libero','Dorso','Rana','Farfalla','Misti']
const DISTANZE        = [50, 100, 200, 400, 800, 1500]
const VASCHE          = ['25 metri','50 metri']

// ═══════════════════════════════════════════════════════════════════════════════
// FIREBASE
// ═══════════════════════════════════════════════════════════════════════════════

const LAST_COMP_KEY = 'qualifiche_last_comp'

function compToKey(nome) {
  if (!nome) return ''
  return nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

async function cloudSave(payload) {
  const key = compToKey(payload.competizione)
  if (!key) throw new Error('Seleziona una competizione prima di salvare')
  const compressed = LZString.compressToBase64(JSON.stringify(payload))
  await rtdbSet(rtdbRef(rtdb, `qualifiche/sessions/${key}`), {
    timestamp: new Date().toISOString(),
    data: compressed,
  })
}

async function cloudLoad(competizione) {
  const key = compToKey(competizione)
  if (!key) return null
  const snap = await rtdbGet(rtdbRef(rtdb, `qualifiche/sessions/${key}`))
  if (!snap.exists()) return null
  const val = snap.val()
  return { payload: JSON.parse(LZString.decompressFromBase64(val.data)), timestamp: val.timestamp }
}

async function cloudLoadRegolamenti() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/meta'))
  if (!snap.exists()) return []
  const val = snap.val()
  const dec = LZString.decompressFromBase64(val.data) || LZString.decompress(val.data)
  return JSON.parse(dec) || []
}

async function cloudLoadPdf(id) {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/files/' + id))
  if (!snap.exists()) return null
  return LZString.decompressFromBase64(snap.val()) // base64 del PDF
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function deriveSezione(atleta) {
  const sezFull = ELENCO_ATLETI[atleta] || ''
  return SEZIONE_FULL_TO_ABBR[sezFull] || (sezFull ? sezFull.slice(0, 3) : '?')
}

function normCat(cat) {
  const c = (cat || '').toUpperCase()
  for (const k of CAT_ORDER) { if (c.includes(k)) return k }
  return 'ALTRI'
}

function normalizeSpec(s) {
  const up = (s || '').toUpperCase()
  if (up.includes('STILE') || up === 'SL')     return 'STILE'
  if (up.includes('DORSO') || up === 'DO')     return 'DORSO'
  if (up.includes('RANA')  || up === 'RA')     return 'RANA'
  if (up.includes('FARFALLA') || up === 'FA')  return 'FARFALLA'
  if (up.includes('MISTI') || up === 'MX')     return 'MISTI'
  return s
}

// Converte "400 Stile Libero" / "100 Dorso" (formato _gara di Classifiche/GradPosizioni)
// in { distanza: 400, specialita: 'STILE' } (formato usato dalle righe xlsx in Qualifiche).
function parseGaraFin(garaStr) {
  const s = String(garaStr || '').trim()
  const m = s.match(/^(\d+)\s+(.+)$/)
  if (!m) return { distanza: 0, specialita: '' }
  return { distanza: parseInt(m[1], 10) || 0, specialita: normalizeSpec(m[2].trim()) }
}

// Legge le righe calcolate nella tab "Qualificati per Graduatoria" (salvate in
// localStorage sotto 'qg_grad_rows' da GradPosizioni.jsx) e le converte nel
// formato riga usato qui, escludendo rinunce/riserve non confermate.
function readGradRowsFromStorage() {
  try {
    const raw = localStorage.getItem('qg_grad_rows')
    if (!raw) return []
    const dec = LZString.decompress(raw)
    const parsed = JSON.parse(dec || raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

const SESSO_GRAD_TO_XLSX = { Maschi: 'Male', Femmine: 'Female' }

function normalizeTime(val) {
  if (val == null || val === '') return ''
  const txt = String(val).replace(',', '.').trim()
  const parts = txt.split(':')
  try {
    if (parts.length === 3) {
      const mm = parseInt(parts[0]) * 60 + parseInt(parts[1])
      return mm === 0 ? parts[2] : `${mm}:${parts[2]}`
    }
    if (parts.length === 2) {
      const mm = parseInt(parts[0])
      return mm === 0 ? parts[1] : `${mm}:${parts[1]}`
    }
  } catch { /**/ }
  return txt
}

function timeToSecs(val) {
  if (!val) return Infinity
  const t = String(val).replace(',', '.').trim()
  if (t.includes(':')) {
    const [m, s] = t.split(':')
    return (parseInt(m) || 0) * 60 + (parseFloat(s) || 0)
  }
  return parseFloat(t) || Infinity
}

function normKey(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
}

function getVal(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k]
    const nk = normKey(k)
    const found = Object.keys(row).find(rk => normKey(rk) === nk)
    if (found !== undefined && row[found] !== undefined && row[found] !== '') return row[found]
  }
  return ''
}

function parseExcelBuffer(buffer) {
  const wb  = XLSX.read(buffer, { type: 'array', cellDates: false })
  const ws  = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })
  return raw.map((r, idx) => {
    const nome    = String(getVal(r, 'Nome', 'nome') || '').trim()
    const cognome = String(getVal(r, 'Cognome', 'cognome') || '').trim()
    const atleta  = (cognome + ' ' + nome).trim()
    const spec    = normalizeSpec(String(getVal(r, 'Specialita', 'SPECIALITA') || '').trim())
    const dist    = parseInt(getVal(r, 'Distanza', 'DISTANZA', 'Dist') || 0)
    const vasca   = String(getVal(r, 'Vasca', 'VASCA') || '').trim()
    const sesso   = String(getVal(r, 'Sesso', 'SESSO') || '').trim()
    const cat     = String(getVal(r, 'Categoria Atleta', 'CategoriaAtleta', 'CATEGORIA') || '').trim()
    const tempo   = normalizeTime(getVal(r, 'Tempo', 'TEMPO') || '')
    const fina    = parseFloat(getVal(r, 'FINA', 'Fina', 'fina') || 0) || 0
    const id      = String(getVal(r, 'ID', 'Id', 'id') || ('row_' + idx))
    const societa = String(getVal(r, 'Societa', 'SOCIETA') || '').trim()
    return { _id: id, _source: 'xlsx', atleta, nome, cognome, societa,
      categoria: cat, sesso, vasca, specialita: spec, distanza: dist,
      tempo, fina, sezione: deriveSezione(atleta) }
  }).filter(r => r.atleta && r.atleta.trim() !== '')
}

function applyFilters(rows, { vasca, sesso, soloUnNome, rinunce }) {
  let res = rows.filter(r => !rinunce.has(r._id))
  if (vasca !== 'Tutte') res = res.filter(r => r.vasca === vasca)
  if (sesso !== 'Tutti') res = res.filter(r => r.sesso === sesso)
  if (soloUnNome) {
    const best = {}
    for (const r of res) {
      const key = r.atleta + '|' + r.specialita + '|' + r.distanza + '|' + r.vasca
      if (!best[key] || r.fina > best[key].fina ||
        (r.fina === best[key].fina && timeToSecs(r.tempo) < timeToSecs(best[key].tempo)))
        best[key] = r
    }
    return Object.values(best)
  }
  return res
}

function computeStats(rows) {
  const male  = rows.filter(r => r.sesso === 'Male')
  const female = rows.filter(r => r.sesso === 'Female')
  const atletiM = new Set(male.map(r => r.atleta))
  const atletiF = new Set(female.map(r => r.atleta))
  const perSez = {}
  for (const r of rows) {
    const s = r.sezione || '?'
    if (!perSez[s]) perSez[s] = { gare: 0, atleti: new Set() }
    perSez[s].gare++; perSez[s].atleti.add(r.atleta)
  }
  const perSezFin = {}
  for (const [k, v] of Object.entries(perSez)) perSezFin[k] = { gare: v.gare, atleti: v.atleti.size }
  const perCat = {}
  for (const c of CAT_ORDER) perCat[c] = { M: 0, F: 0, gareM: 0, gareF: 0, _setM: new Set(), _setF: new Set() }
  for (const r of rows) {
    const c = normCat(r.categoria)
    if (perCat[c]) {
      if (r.sesso === 'Male')   { perCat[c]._setM.add(r.atleta); perCat[c].gareM++ }
      else if (r.sesso === 'Female') { perCat[c]._setF.add(r.atleta); perCat[c].gareF++ }
    }
  }
  for (const c of CAT_ORDER) {
    perCat[c].M = perCat[c]._setM.size
    perCat[c].F = perCat[c]._setF.size
    delete perCat[c]._setM; delete perCat[c]._setF
  }
  const perSpec = {}
  for (const s of SPEC_ORDER) perSpec[s] = { M: 0, F: 0 }
  for (const r of rows) {
    const abbr = SPEC_ABBR[r.specialita] || r.specialita
    if (perSpec[abbr]) { if (r.sesso === 'Male') perSpec[abbr].M++; else perSpec[abbr].F++ }
  }
  return {
    totGare:    { M: male.length, F: female.length, total: rows.length },
    totAtleti:  { M: atletiM.size, F: atletiF.size, total: atletiM.size + atletiF.size },
    perSezione: perSezFin, perCat, perSpec,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function exportExcel(rows, competizione) {
  const headers = ['Atleta','Sesso','Cat.','Sezione','Specialità','Dist.','Vasca','Tempo','FINA']
  const data = rows.map(r => [
    r.atleta, r.sesso === 'Male' ? 'M' : 'F', normCat(r.categoria),
    r.sezione, r.specialita, r.distanza, r.vasca, r.tempo, r.fina,
  ])
  const ws = XLSXStyle.utils.aoa_to_sheet([headers, ...data])
  const hStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0077C8' } },
    alignment: { horizontal: 'center' }, border: { bottom: { style: 'thin', color: { rgb: 'B8D8EC' } } } }
  headers.forEach((_, ci) => {
    const addr = XLSXStyle.utils.encode_cell({ r: 0, c: ci })
    if (!ws[addr]) ws[addr] = {}
    ws[addr].s = hStyle
  })
  const wb = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(wb, ws, 'Qualifiche')
  XLSXStyle.writeFile(wb, `Qualifiche_${(competizione || 'export').replace(/\s+/g, '_')}.xlsx`)
}

function wsCell(ws, r, c, val, s) {
  const ref = XLSXStyle.utils.encode_cell({ r, c })
  ws[ref] = { v: val == null ? '' : val, t: typeof val === 'number' ? 'n' : 's', s: s || {} }
}

function gEventCode(dist, spec) {
  const abbr = SPEC_ABBR[spec] || (spec || '').slice(0, 2)
  if (typeof dist === 'string' && dist.includes('x')) {
    const parts = dist.split('x')
    return `${parts[0]}x${parts[1]}${abbr}`
  }
  return `${dist}${abbr}`
}

function gCatAbbr(cat, catRaw) {
  const raw = (catRaw || '').toUpperCase()
  if (raw.includes('J/C/S') || raw.includes('JCS') || cat === 'JCS') return 'J/C/S'
  if (raw.includes('J/C')   || raw.includes('JC'))  return 'J/C'
  if (cat === 'RAGAZZI')  return 'R'
  if (cat === 'JUNIORES') return 'J'
  if (cat === 'CADETTI')  return 'C'
  if (cat === 'SENIORES') return 'S'
  return null
}

const JCS_CATS = new Set(['JUNIORES', 'CADETTI', 'SENIORES'])
function gFindAthletes(sessoRows, sesso, spec, dist, cat) {
  const isStaffetta = typeof dist === 'string' && dist.includes('x')
  const legDist = isStaffetta ? parseInt(dist.split('x')[1]) : dist
  return sessoRows.filter(r => {
    if (r.specialita !== spec) return false
    if (r.distanza !== legDist) return false
    if (cat === 'JCS') return JCS_CATS.has(normCat(r.categoria))
    if (cat && normCat(r.categoria) !== cat) return false
    return true
  }).sort((a, b) => b.fina - a.fina || timeToSecs(a.tempo) - timeToSecs(b.tempo))
}

function buildRiepilogo(rows) {
  const F = rows.filter(r => r.sesso === 'Female')
  const M = rows.filter(r => r.sesso === 'Male')
  const atletiF = new Set(F.map(r => r.atleta)).size
  const atletiM = new Set(M.map(r => r.atleta)).size
  const ws = {}; const merges = []; let row = 0

  const sTit  = { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1A6FBA' } }, alignment: { horizontal: 'center' } }
  const sHdr  = { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '37474F' } } }
  const sBold = { font: { bold: true } }

  wsCell(ws, row, 0, 'RIEPILOGO QUALIFICATI', sTit); wsCell(ws, row, 1, null, sTit); wsCell(ws, row, 2, null, sTit)
  merges.push({ s: {r:row,c:0}, e: {r:row,c:2} }); row++
  ;['SEZIONE','PRESENZE GARA','NUMERO ATLETI'].forEach((h, c) => wsCell(ws, row, c, h, sHdr)); row++
  wsCell(ws, row, 0, 'Femminile'); wsCell(ws, row, 1, F.length, {}); wsCell(ws, row, 2, atletiF, {}); row++
  wsCell(ws, row, 0, 'Maschile');  wsCell(ws, row, 1, M.length, {}); wsCell(ws, row, 2, atletiM, {}); row++
  wsCell(ws, row, 0, 'TOTALE COMPLESSIVO', sBold); wsCell(ws, row, 1, F.length + M.length, sBold); wsCell(ws, row, 2, atletiF + atletiM, sBold); row++
  row++

  wsCell(ws, row, 0, 'DETTAGLIO PER GARA', sBold); wsCell(ws, row, 1, null); wsCell(ws, row, 2, null)
  merges.push({ s: {r:row,c:0}, e: {r:row,c:2} }); row++

  for (const [label, sessoRows] of [['FEMMINILE', F], ['MASCHILE', M]]) {
    wsCell(ws, row, 0, `— ${label} —`, sHdr); wsCell(ws, row, 1, null, sHdr); wsCell(ws, row, 2, null, sHdr)
    merges.push({ s: {r:row,c:0}, e: {r:row,c:2} }); row++
    const ev = {}
    for (const r of sessoRows) { const c = gEventCode(r.distanza, r.specialita); ev[c] = (ev[c] || 0) + 1 }
    for (const [code, cnt] of Object.entries(ev).sort()) {
      wsCell(ws, row, 0, `  ${code}`); wsCell(ws, row, 1, cnt, {}); wsCell(ws, row, 2, null, {}); row++
    }
  }

  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }]
  ws['!merges'] = merges
  ws['!ref'] = XLSXStyle.utils.encode_range({ s: {r:0,c:0}, e: {r:row-1,c:2} })
  return ws
}

function buildGrigliaSheet(rows, sesso, programma) {
  const ws = {}; const merges = []
  const sessoLabel = sesso === 'Female' ? 'FEMMINILE' : 'MASCHILE'
  const sessoRows  = rows.filter(r => r.sesso === sesso)
  const giorni = programma.filter(g => g.sessioni.some(s => s.gare.some(ga => !ga.sesso || ga.sesso === sesso)))
  const nCols = giorni.length

  // fallback: nessun giorno trovato O nessun atleta di questo sesso nell'xlsx
  if (nCols === 0 || !sessoRows.length) {
    ws['A1'] = { v: sessoRows.length === 0
      ? 'Nessun atleta qualificato per questo sesso'
      : 'Nessuna gara nel programma per questo sesso', t: 's', s: {} }
    ws['!ref'] = 'A1'; return ws
  }

  ws['!cols'] = giorni.map(() => ({ wch: 26 }))

  const STL = {
    title: { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1A6FBA' } }, alignment: { horizontal: 'center' } },
    day:   { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E3F0FA' } }, alignment: { horizontal: 'center' } },
    sess:  { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '37474F' } } },
    event: { font: { bold: true, sz: 10 } },
    atl:   { font: { sz: 10 } },
    noatl: { font: { sz: 9, italic: true, color: { rgb: '999999' } } },
    fraz:  { font: { sz: 10, color: { rgb: '555555' } } },
  }

  for (let c = 0; c < nCols; c++) wsCell(ws, 0, c, c === 0 ? `GRIGLIA GARE  —  ${sessoLabel}` : null, STL.title)
  if (nCols > 1) merges.push({ s: {r:0,c:0}, e: {r:0,c:nCols-1} })
  giorni.forEach((g, ci) => wsCell(ws, 1, ci, `GIORNO ${g.giornata}  •  ${g.data}`, STL.day))

  const plans = giorni.map(g => {
    const plan = []
    for (const sess of g.sessioni) {
      const gare = sess.gare.filter(ga => !ga.sesso || ga.sesso === sesso)
      if (!gare.length) continue
      plan.push({ text: `▸  ${sess.nome.toUpperCase()}`, style: STL.sess })
      for (const gara of gare) {
        const code  = gEventCode(gara.dist, gara.spec)
        const abbr  = gCatAbbr(gara.cat, gara.catRaw)
        const label = abbr ? `  ${code}  [${abbr}]` : `  ${code}`
        plan.push({ text: label, style: STL.event })
        const isStaff  = typeof gara.dist === 'string' && gara.dist.includes('x')
        const athletes = gFindAthletes(sessoRows, sesso, gara.spec, gara.dist, gara.cat || null)
        if (isStaff) {
          const top4 = athletes.slice(0, 4)
          for (let i = 0; i < 4; i++) {
            plan.push({ text: `  FRAZ ${i + 1}`, style: STL.fraz })
            if (top4[i]) plan.push({ text: `  ${top4[i].atleta}`, style: STL.atl })
          }
        } else if (!athletes.length) {
          plan.push({ text: 'nessun qualificato', style: STL.noatl })
        } else {
          for (const a of athletes) plan.push({ text: `  ${a.atleta}`, style: STL.atl })
        }
      }
      plan.push({ text: '', style: {} })
    }
    return plan
  })

  // Se tutti gli eventi del programma non hanno atleti, aggiungi colonna fallback con dati xlsx
  const allEmpty = plans.every(plan =>
    plan.every(item => !item.text || item.text === 'nessun qualificato' || item.text.startsWith('▸') || item.text === ''))
  if (allEmpty && sessoRows.length > 0) {
    // crea una colonna extra con gli atleti dall'xlsx per questo sesso
    const byEvent = {}
    for (const r of sessoRows) {
      const code = gEventCode(r.distanza, r.specialita)
      if (!byEvent[code]) byEvent[code] = []
      byEvent[code].push(r)
    }
    const fallback = [{ text: '(gare non in programma)', style: STL.noatl }]
    for (const [code, atls] of Object.entries(byEvent).sort()) {
      fallback.push({ text: `  ${code}`, style: STL.event })
      for (const a of atls.sort((x,y) => y.fina - x.fina))
        fallback.push({ text: `  ${a.atleta}`, style: STL.atl })
      fallback.push({ text: '', style: {} })
    }
    const totalCols = nCols + 1
    ws['!cols'] = [...giorni.map(() => ({ wch: 26 })), { wch: 26 }]
    wsCell(ws, 0, nCols, null, STL.title)
    wsCell(ws, 1, nCols, 'Qualifiche (fuori programma)', STL.day)
    fallback.forEach((item, ri) => wsCell(ws, 2 + ri, nCols, item.text, item.style))
    if (nCols > 0) merges.push({ s: {r:0,c:0}, e: {r:0,c:totalCols-1} })
    const maxRows2 = Math.max(...plans.map(p => p.length), fallback.length)
    plans.forEach((plan, ci) => plan.forEach((item, ri) => wsCell(ws, 2 + ri, ci, item.text, item.style)))
    ws['!merges'] = merges
    ws['!ref'] = XLSXStyle.utils.encode_range({ s: {r:0,c:0}, e: {r:2+maxRows2,c:totalCols-1} })
    return ws
  }

  const maxRows = Math.max(...plans.map(p => p.length))
  plans.forEach((plan, ci) => plan.forEach((item, ri) => wsCell(ws, 2 + ri, ci, item.text, item.style)))

  ws['!merges'] = merges
  ws['!ref'] = XLSXStyle.utils.encode_range({ s: {r:0,c:0}, e: {r:2+maxRows,c:nCols-1} })
  return ws
}

function buildElencoSheet(rows, sesso) {
  const label = sesso === 'Female' ? 'FEMMINE' : 'MASCHI'
  const sessoRows = rows.filter(r => r.sesso === sesso)
  const byAtleta = {}
  for (const r of sessoRows) {
    if (!byAtleta[r.atleta]) byAtleta[r.atleta] = []
    byAtleta[r.atleta].push(r)
  }

  const ws = {}; const merges = []; let row = 0; const NC = 6

  const STL = {
    tit:  { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1A6FBA' } }, alignment: { horizontal: 'center' } },
    hdr:  { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '37474F' } } },
    name: { font: { bold: true, sz: 10 } },
    dat:  { font: { sz: 10 } },
    tl:   { font: { sz: 10, color: { rgb: '1A6FBA' } } },
    grad: { font: { sz: 10, color: { rgb: '2E7D32' } } },
  }

  for (let c = 0; c < NC; c++) wsCell(ws, row, c, c === 0 ? `ELENCO ${label} — Atleti qualificati` : null, STL.tit)
  merges.push({ s: {r:row,c:0}, e: {r:row,c:NC-1} }); row++
  ;['Atleta','Categoria','Gara','Tempo','FINA','Tipo qualifica'].forEach((h, c) => wsCell(ws, row, c, h, STL.hdr)); row++

  for (const [atleta, gare] of Object.entries(byAtleta).sort(([a],[b]) => a.localeCompare(b, 'it'))) {
    const sorted = [...gare].sort((a, b) => gEventCode(a.distanza, a.specialita).localeCompare(gEventCode(b.distanza, b.specialita)))
    for (let i = 0; i < sorted.length; i++) {
      const g = sorted[i]
      const code = gEventCode(g.distanza, g.specialita)
      const tipo = (g._source === 'xlsx' || g._source === 'TL') ? 'Tempo Limite' : 'Graduatoria'
      wsCell(ws, row, 0, i === 0 ? atleta : '', i === 0 ? STL.name : STL.dat)
      wsCell(ws, row, 1, i === 0 ? normCat(g.categoria) : '', STL.dat)
      wsCell(ws, row, 2, code, STL.dat)
      wsCell(ws, row, 3, g.tempo, STL.dat)
      wsCell(ws, row, 4, g.fina || '', STL.dat)
      wsCell(ws, row, 5, tipo, tipo === 'Tempo Limite' ? STL.tl : STL.grad)
      row++
    }
    row++
  }

  ws['!cols'] = [{ wch: 26 }, { wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 15 }]
  ws['!merges'] = merges
  ws['!ref'] = XLSXStyle.utils.encode_range({ s: {r:0,c:0}, e: {r:row-1,c:NC-1} })
  return ws
}

function exportGrigliaGare(rows, competizione, programma) {
  const wb = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(wb, buildRiepilogo(rows), 'Riepilogo')
  if (programma && programma.length > 0) {
    XLSXStyle.utils.book_append_sheet(wb, buildGrigliaSheet(rows, 'Female', programma), 'Femminile')
    XLSXStyle.utils.book_append_sheet(wb, buildGrigliaSheet(rows, 'Male',   programma), 'Maschile')
  }
  XLSXStyle.utils.book_append_sheet(wb, buildElencoSheet(rows, 'Female'), 'Elenco Femmine')
  XLSXStyle.utils.book_append_sheet(wb, buildElencoSheet(rows, 'Male'),   'Elenco Maschi')
  XLSXStyle.writeFile(wb, `GrigliaGare_${(competizione || 'export').replace(/\s+/g, '_')}.xlsx`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: AGGIUNGI ATLETA ESTERO
// ═══════════════════════════════════════════════════════════════════════════════

function ModalAggiungiEstero({ onClose, onAdd }) {
  const [tipo, setTipo]       = useState('TL')
  const [nome, setNome]       = useState('')
  const [cognome, setCognome] = useState('')
  const [societa, setSocieta] = useState('')
  const [sesso, setSesso]     = useState('Male')
  const [cat, setCat]         = useState('JUNIORES')
  const [spec, setSpec]       = useState('Stile Libero')
  const [dist, setDist]       = useState(100)
  const [vasca, setVasca]     = useState('25 metri')
  const [tempo, setTempo]     = useState('')
  const [fina, setFina]       = useState('')

  function handleAdd() {
    if (!nome || !cognome) return
    const atleta = (cognome.trim() + ' ' + nome.trim()).toUpperCase()
    const entry = {
      _id: 'est_' + Date.now(),
      _source: tipo,
      atleta, nome: nome.trim(), cognome: cognome.trim(), societa,
      categoria: cat, sesso, vasca, specialita: normalizeSpec(spec),
      distanza: parseInt(dist), tempo: normalizeTime(tempo),
      fina: parseFloat(fina) || 0, sezione: deriveSezione(atleta),
    }
    onAdd(entry)
    onClose()
  }

  const inp = 'w-full bg-sb-bg border border-sb-sep rounded px-3 py-1.5 text-sm text-sb-text focus:outline-none focus:border-sb-blue'
  const lbl = 'block text-xs font-semibold text-sb-muted mb-1'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Aggiungi Atleta Estero</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <div className="p-6 space-y-4">
          {/* Tipo */}
          <div>
            <label className={lbl}>Tipo qualifica</label>
            <div className="flex gap-4">
              {['TL', 'GRAD'].map(t => (
                <label key={t} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="radio" name="tipo" value={t} checked={tipo === t} onChange={() => setTipo(t)} className="accent-sb-blue" />
                  {t === 'TL' ? 'Tempo Limite' : 'Graduatoria'}
                </label>
              ))}
            </div>
          </div>
          {/* Nome/Cognome */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lbl}>Cognome *</label><input className={inp} value={cognome} onChange={e => setCognome(e.target.value)} /></div>
            <div><label className={lbl}>Nome *</label><input className={inp} value={nome} onChange={e => setNome(e.target.value)} /></div>
          </div>
          <div><label className={lbl}>Società</label><input className={inp} value={societa} onChange={e => setSocieta(e.target.value)} /></div>
          {/* Sesso / Cat */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Sesso</label>
              <select className={inp} value={sesso} onChange={e => setSesso(e.target.value)}>
                <option value="Male">Maschile</option>
                <option value="Female">Femminile</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Categoria</label>
              <select className={inp} value={cat} onChange={e => setCat(e.target.value)}>
                {CATEGORIE_ATLETA.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          {/* Gara */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={lbl}>Specialità</label>
              <select className={inp} value={spec} onChange={e => setSpec(e.target.value)}>
                {SPECIALITA_LIST.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Distanza</label>
              <select className={inp} value={dist} onChange={e => setDist(e.target.value)}>
                {DISTANZE.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Vasca</label>
              <select className={inp} value={vasca} onChange={e => setVasca(e.target.value)}>
                {VASCHE.map(v => <option key={v}>{v}</option>)}
              </select>
            </div>
          </div>
          {/* Tempo / FINA */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lbl}>Tempo</label><input className={inp} value={tempo} onChange={e => setTempo(e.target.value)} placeholder="es. 1:02.34" /></div>
            <div><label className={lbl}>Punti FINA</label><input className={inp} type="number" value={fina} onChange={e => setFina(e.target.value)} /></div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-sb-sep">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-bg text-sb-muted hover:bg-sb-sep">Annulla</button>
          <button onClick={handleAdd} className="px-4 py-2 text-sm rounded bg-sb-blue text-white hover:bg-sb-hover font-semibold">Aggiungi</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: GESTISCI ESTERI
// ═══════════════════════════════════════════════════════════════════════════════

function ModalGestisciEsteri({ esteri, onClose, onRemove }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Gestisci Atleti Esteri ({esteri.length})</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4">
          {esteri.length === 0 ? (
            <p className="text-center text-sb-muted py-8">Nessun atleta estero aggiunto</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-sb-muted border-b border-sb-sep">
                  <th className="pb-2 font-semibold">Atleta</th>
                  <th className="pb-2 font-semibold">Tipo</th>
                  <th className="pb-2 font-semibold">Gara</th>
                  <th className="pb-2 font-semibold">Tempo</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {esteri.map(e => (
                  <tr key={e._id} className="border-b border-sb-sep/50 hover:bg-sb-bg/50">
                    <td className="py-2 font-medium text-sb-text">{e.atleta}</td>
                    <td className="py-2"><span className={`px-1.5 py-0.5 rounded text-xs font-bold ${e._source === 'TL' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>{e._source}</span></td>
                    <td className="py-2 text-sb-muted">{e.distanza}m {e.specialita}</td>
                    <td className="py-2 text-sb-muted">{e.tempo}</td>
                    <td className="py-2">
                      <button onClick={() => onRemove(e._id)} className="text-red-400 hover:text-red-600 text-xs font-semibold">Rimuovi</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex justify-end px-6 py-4 border-t border-sb-sep">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-blue text-white hover:bg-sb-hover font-semibold">Chiudi</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: RINUNCE TL
// ═══════════════════════════════════════════════════════════════════════════════

function ModalRinunce({ allRows, rinunce, onClose, onSave }) {
  const [sel, setSel] = useState(new Set(rinunce))
  const tlRows = allRows.filter(r => r._source === 'xlsx' || r._source === 'TL')

  function toggle(id) {
    setSel(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[660px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Rinunce TL</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <p className="px-6 py-2 text-xs text-sb-muted">Seleziona gli atleti qualificati per TL che hanno rinunciato alla partecipazione.</p>
        <div className="overflow-y-auto flex-1 px-4 pb-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-sb-muted border-b border-sb-sep sticky top-0 bg-white">
                <th className="py-2 w-8"></th>
                <th className="py-2">Atleta</th>
                <th className="py-2">Gara</th>
                <th className="py-2">Vasca</th>
                <th className="py-2">Tempo</th>
              </tr>
            </thead>
            <tbody>
              {tlRows.map(r => (
                <tr key={r._id} className={`border-b border-sb-sep/50 hover:bg-sb-bg/30 cursor-pointer ${sel.has(r._id) ? 'bg-red-50' : ''}`} onClick={() => toggle(r._id)}>
                  <td className="py-1.5 pl-2"><input type="checkbox" checked={sel.has(r._id)} onChange={() => toggle(r._id)} className="accent-red-500" /></td>
                  <td className="py-1.5 font-medium text-sb-text">{r.atleta}</td>
                  <td className="py-1.5 text-sb-muted">{r.distanza}m {r.specialita}</td>
                  <td className="py-1.5 text-sb-muted text-xs">{r.vasca}</td>
                  <td className="py-1.5 text-sb-muted">{r.tempo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center px-6 py-4 border-t border-sb-sep">
          <span className="text-sm text-sb-muted">{sel.size} rinuncia/e selezionate</span>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-bg text-sb-muted hover:bg-sb-sep">Annulla</button>
            <button onClick={() => { onSave(sel); onClose() }} className="px-4 py-2 text-sm rounded bg-red-500 text-white hover:bg-red-600 font-semibold">Salva Rinunce</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: ANALISI SEZIONE
// ═══════════════════════════════════════════════════════════════════════════════

function ModalAnalisiSezione({ rows, onClose }) {
  const bySezione = {}
  for (const r of rows) {
    const s = r.sezione || '?'
    if (!bySezione[s]) bySezione[s] = { atleti: new Set(), gare: [], M: new Set(), F: new Set() }
    bySezione[s].atleti.add(r.atleta)
    bySezione[s].gare.push(r)
    r.sesso === 'Male' ? bySezione[s].M.add(r.atleta) : bySezione[s].F.add(r.atleta)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[700px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Analisi per Sezione</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {SEZIONE_ORDER.filter(s => bySezione[s]).map(s => {
            const d = bySezione[s]
            return (
              <div key={s} className="rounded-lg border border-sb-sep overflow-hidden">
                <div className="flex items-center justify-between bg-sb-blue/10 px-4 py-2">
                  <span className="font-bold text-sb-blue text-sm">{s}</span>
                  <div className="flex gap-4 text-xs text-sb-muted">
                    <span><strong className="text-sb-text">{d.atleti.size}</strong> atleti</span>
                    <span><strong className="text-sb-text">{d.gare.length}</strong> gare</span>
                    <span>M: <strong className="text-sb-text">{d.M.size}</strong></span>
                    <span>F: <strong className="text-sb-text">{d.F.size}</strong></span>
                  </div>
                </div>
                <div className="px-4 py-2">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-sb-muted border-b border-sb-sep">
                        <th className="text-left py-1">Atleta</th>
                        <th className="text-left py-1">Sesso</th>
                        <th className="text-left py-1">Gara</th>
                        <th className="text-left py-1">Tempo</th>
                        <th className="text-right py-1">FINA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.gare.sort((a, b) => b.fina - a.fina).map((r, i) => (
                        <tr key={r._id + i} className="border-b border-sb-sep/30">
                          <td className="py-0.5 font-medium text-sb-text">{r.atleta}</td>
                          <td className="py-0.5 text-sb-muted">{r.sesso === 'Male' ? 'M' : 'F'}</td>
                          <td className="py-0.5 text-sb-muted">{r.distanza}m {r.specialita}</td>
                          <td className="py-0.5 text-sb-muted">{r.tempo}</td>
                          <td className="py-0.5 text-right text-sb-muted">{r.fina}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end px-6 py-4 border-t border-sb-sep">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-blue text-white hover:bg-sb-hover font-semibold">Chiudi</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function Qualifiche() {
  const fileInputRef = useRef(null)

  // core state
  const [xlsxRows, setXlsxRows]         = useState([])   // raw from Excel
  const [esteri, setEsteri]              = useState([])   // manually added foreign athletes
  const [rinunce, setRinunce]            = useState(new Set())
  const [competizione, setCompetizione]  = useState('')
  const [regolamenti, setRegolamenti]    = useState([])
  const [fileName, setFileName]          = useState('')

  // programma dal PDF del regolamento
  const [programma, setProgramma]               = useState([])   // [{giornata,data,sessioni}]
  const [graduatoriaLimiti, setGraduatoriaLimiti] = useState({}) // {dist|spec|sesso: max}
  const [pdfLoading, setPdfLoading]             = useState(false)
  const [inclusiGraduatoria, setInclusiGraduatoria] = useState(false)

  // filters
  const [filterVasca, setFilterVasca]     = useState('Tutte')
  const [filterSesso, setFilterSesso]     = useState('Tutti')
  const [soloUnNome, setSoloUnNome]       = useState(true)

  // modals
  const [showAggEstero, setShowAggEstero]       = useState(false)
  const [showGestEsteri, setShowGestEsteri]     = useState(false)
  const [showRinunce, setShowRinunce]           = useState(false)
  const [showAnalisi, setShowAnalisi]           = useState(false)

  // ui status
  const [status, setStatus]   = useState('')
  const [saving, setSaving]   = useState(false)
  const [loading, setLoading] = useState(false)

  // Load regolamenti on mount + ripristina ultima competizione selezionata
  useEffect(() => {
    cloudLoadRegolamenti()
      .then(regs => {
        setRegolamenti(regs)
        const lastComp = localStorage.getItem(LAST_COMP_KEY)
        if (lastComp) setCompetizione(lastComp)
      })
      .catch(() => {})
  }, [])

  // Auto-carica sessione quando cambia la competizione
  useEffect(() => {
    if (!competizione) return
    localStorage.setItem(LAST_COMP_KEY, competizione)
    setXlsxRows([])
    setEsteri([])
    setRinunce(new Set())
    setFileName('')
    setStatus('')
    cloudLoad(competizione).then(res => {
      if (!res) return
      const p = res.payload
      setXlsxRows(p.xlsxRows || [])
      setEsteri(p.esteri || [])
      setRinunce(new Set(p.rinunce || []))
      setFilterVasca(p.filterVasca || 'Tutte')
      setFilterSesso(p.filterSesso || 'Tutti')
      setSoloUnNome(p.soloUnNome ?? true)
      if (p.xlsxRows?.length) setFileName('(sessione salvata)')
      setStatus(`Sessione caricata per: ${competizione}`)
    }).catch(() => {})
  }, [competizione])

  // Carica e parsa il PDF del regolamento quando cambia la competizione
  useEffect(() => {
    if (!competizione || regolamenti.length === 0) return
    const reg = regolamenti.find(r => r.nome === competizione)
    if (!reg) return
    setPdfLoading(true)
    setProgramma([])
    setGraduatoriaLimiti({})
    cloudLoadPdf(reg.id).then(async base64 => {
      if (!base64) return
      try {
        const text = await extractPdfText(base64)
        let giorni = parseProgramma(text)
        const totGare = giorni.reduce((s, g) => s + g.sessioni.reduce((s2, sess) => s2 + sess.gare.length, 0), 0)
        if (totGare < 10 && import.meta.env.VITE_ANTHROPIC_KEY) {
          console.log('[Vision] parser testuale: poche gare, uso Claude vision...')
          giorni = await parseProgrammaVision(base64)
        }
        setProgramma(giorni)
        setGraduatoriaLimiti(parseGraduatoriaLimiti(text))
      } catch (e) { console.warn('Errore parsing PDF:', e) }
    }).catch(e => console.warn('Errore caricamento PDF:', e))
      .finally(() => setPdfLoading(false))
  }, [competizione, regolamenti])

  // Righe qualificate per graduatoria (tab "Qualificati per Graduatoria"), incluse
  // solo se il toggle "Includi Graduatoria" è attivo, se sono state calcolate per
  // la STESSA competizione qui selezionata, e non già coperte da una qualifica TL.
  const gradInfo = useMemo(() => {
    if (!inclusiGraduatoria) return { rows: [], stato: 'off' }

    const compCalcolata = (localStorage.getItem('qg_comp') || '').trim()
    if (!competizione) return { rows: [], stato: 'no_comp' }
    if (!compCalcolata || compCalcolata !== competizione.trim()) {
      return { rows: [], stato: 'comp_mismatch', compCalcolata }
    }

    const gradRowsRaw = readGradRowsFromStorage()
    if (!gradRowsRaw.length) return { rows: [], stato: 'no_data' }

    // Esclude: aventi diritto che hanno rinunciato, riserve non confermate per rinuncia
    const gradRows = gradRowsRaw.filter(r =>
      !r._rinuncia_grad && !((r._extra || r._riserva) && !r._rinuncia)
    )

    const tlKeys = new Set(
      [...xlsxRows, ...esteri].map(r => `${r.atleta.trim().toLowerCase()}|${r.specialita}|${r.distanza}`)
    )

    const seen = new Set()
    const rows = []
    for (const r of gradRows) {
      const atleta = (r.ATLETA || '').trim()
      if (!atleta) continue
      const { distanza, specialita } = parseGaraFin(r.GARA)
      if (!specialita || !distanza) continue
      const key = `${atleta.toLowerCase()}|${specialita}|${distanza}`
      if (tlKeys.has(key) || seen.has(key)) continue
      seen.add(key)
      rows.push({
        _id: `grad_${key}`,
        _source: 'GRAD',
        atleta, nome: '', cognome: atleta, societa: '',
        categoria: r.CATEGORIA || '',
        sesso: SESSO_GRAD_TO_XLSX[r.SESSO] || r.SESSO || '',
        vasca: String(r.VASCA || '').includes('50') ? '50 metri' : '25 metri',
        specialita, distanza,
        tempo: r.TEMPO || '',
        fina: parseFloat(r.PTFINA || 0) || 0,
        sezione: deriveSezione(atleta),
      })
    }
    return { rows, stato: 'ok' }
  }, [inclusiGraduatoria, competizione, xlsxRows, esteri])

  // Derived: all rows merged (xlsx + esteri + eventuale graduatoria), then filtered
  const allRows = useMemo(
    () => [...xlsxRows, ...esteri, ...gradInfo.rows],
    [xlsxRows, esteri, gradInfo]
  )
  const filtered = useMemo(
    () => applyFilters(allRows, { vasca: filterVasca, sesso: filterSesso, soloUnNome, rinunce }),
    [allRows, filterVasca, filterSesso, soloUnNome, rinunce]
  )
  const stats = useMemo(() => computeStats(filtered), [filtered])

  // ── FILE IMPORT ──────────────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return
    setFileName(file.name)
    try {
      const buf = await file.arrayBuffer()
      const parsed = parseExcelBuffer(new Uint8Array(buf))
      setXlsxRows(parsed)
      setStatus(`Importati ${parsed.length} record da ${file.name}`)
    } catch (e) {
      setStatus('Errore lettura file: ' + e.message)
    }
  }

  function onDrop(e) {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    if (f) handleFile(f)
  }

  // ── CLOUD SAVE / LOAD ────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true); setStatus('')
    try {
      await cloudSave({ competizione, xlsxRows, esteri, rinunce: [...rinunce],
        filterVasca, filterSesso, soloUnNome })
      setStatus('Sessione salvata su cloud.')
    } catch (e) { setStatus('Errore salvataggio: ' + e.message) }
    finally { setSaving(false) }
  }

  async function handleLoad() {
    if (!competizione) { setStatus('Seleziona prima una competizione.'); return }
    setLoading(true); setStatus('')
    try {
      const res = await cloudLoad(competizione)
      if (!res) { setStatus('Nessuna sessione trovata per questa competizione.'); return }
      const p = res.payload
      setXlsxRows(p.xlsxRows || [])
      setEsteri(p.esteri || [])
      setRinunce(new Set(p.rinunce || []))
      setFilterVasca(p.filterVasca || 'Tutte')
      setFilterSesso(p.filterSesso || 'Tutti')
      setSoloUnNome(p.soloUnNome ?? true)
      if (p.xlsxRows?.length) setFileName('(sessione salvata)')
      setStatus(`Sessione caricata (${new Date(res.timestamp).toLocaleString('it-IT')})`)
    } catch (e) { setStatus('Errore caricamento: ' + e.message) }
    finally { setLoading(false) }
  }

  // ── RENDER ───────────────────────────────────────────────────────────────────
  const btnBase   = 'px-3 py-1.5 rounded text-sm font-semibold transition-colors'
  const btnPrimary = `${btnBase} bg-sb-blue text-white hover:bg-sb-hover`
  const btnSecond  = `${btnBase} bg-sb-panel text-sb-text border border-sb-sep hover:bg-sb-bg`
  const btnDanger  = `${btnBase} bg-red-500 text-white hover:bg-red-600`

  return (
    <div>
      {/* ── STICKY TOP BAR ── */}
      <div className="sticky top-0 z-20 bg-sb-bg border-b border-sb-sep -mx-5 -mt-5 px-5 py-3 space-y-2">
        {/* Riga 1: titolo + competizione */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-sb-text">Qualifiche</h1>
          <div className="flex items-center gap-2 flex-1">
            <select
              className="bg-white border border-sb-sep rounded px-3 py-1.5 text-sm text-sb-text focus:outline-none focus:border-sb-blue"
              value={competizione} onChange={e => setCompetizione(e.target.value)}
            >
              <option value="">— Seleziona competizione —</option>
              {regolamenti.map(r => <option key={r.id} value={r.nome}>{r.nome}</option>)}
            </select>
            {pdfLoading && <span className="text-xs text-sb-muted animate-pulse">⏳ Caricamento PDF…</span>}
            {!pdfLoading && programma.length > 0 && <span className="text-xs text-sb-green">✓ Programma ({programma.length} giorni)</span>}
            {!pdfLoading && competizione && programma.length === 0 && <span className="text-xs text-sb-muted">⚠ Nessun programma nel PDF</span>}
          </div>
        </div>
        {/* Riga 2: bottoni azione */}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => exportExcel(filtered, competizione)} disabled={filtered.length === 0} className={btnPrimary + ' disabled:opacity-40'}>
            📊 Esporta Excel
          </button>
          <button onClick={() => exportGrigliaGare(filtered, competizione, programma)} disabled={filtered.length === 0} className={btnPrimary + ' disabled:opacity-40'}>
            📋 Genera Griglia Gare {programma.length > 0 && <span className="text-xs opacity-70">({programma.length}gg)</span>}
          </button>
          <button onClick={() => setShowAnalisi(true)} disabled={filtered.length === 0} className={btnSecond + ' disabled:opacity-40'}>
            📈 Analisi Sezione
          </button>
          <div className="flex-1" />
          <button onClick={handleLoad} disabled={loading} className={btnSecond + ' disabled:opacity-40'}>
            {loading ? '⏳ Caricamento…' : '☁️ Carica Sessione'}
          </button>
          <button onClick={handleSave} disabled={saving || allRows.length === 0} className={btnPrimary + ' disabled:opacity-40'}>
            {saving ? '⏳ Salvataggio…' : '💾 Salva'}
          </button>
          <a href="https://aqt.ficr.it" target="_blank" rel="noopener noreferrer"
            className={`${btnSecond} no-underline inline-flex items-center gap-1`}>
            🔍 Verifica su AQT
          </a>
        </div>
      </div>

      <div className="space-y-5 pt-5">

      {/* ── IMPORT AREA ── */}
      <div
        className="border-2 border-dashed border-sb-sep rounded-xl p-6 text-center cursor-pointer hover:border-sb-blue hover:bg-sb-bg/50 transition-colors"
        onDragOver={e => e.preventDefault()} onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={e => handleFile(e.target.files?.[0])} />
        {fileName ? (
          <p className="text-sb-blue font-semibold text-sm">📂 {fileName}</p>
        ) : (
          <>
            <p className="text-sb-muted text-sm">Trascina qui il file Excel delle qualifiche</p>
            <p className="text-sb-muted/60 text-xs mt-1">oppure clicca per selezionare</p>
          </>
        )}
      </div>

      {/* ── FILTER BAR ── */}
      <div className="flex flex-wrap items-center gap-4 bg-sb-panel rounded-xl px-4 py-3 border border-sb-sep">
        <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-sb-text">
          <input type="checkbox" checked={soloUnNome} onChange={e => setSoloUnNome(e.target.checked)} className="accent-sb-blue w-4 h-4" />
          Un nome per atleta
        </label>
        <div className="flex items-center gap-2 text-sm text-sb-muted">
          Vasca:
          {['Tutte', '25 metri', '50 metri'].map(v => (
            <button key={v} onClick={() => setFilterVasca(v)}
              className={`px-2 py-0.5 rounded text-xs font-semibold ${filterVasca === v ? 'bg-sb-blue text-white' : 'bg-sb-bg text-sb-muted hover:bg-sb-sep'}`}>
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-sb-muted">
          Sesso:
          {['Tutti', 'Male', 'Female'].map(s => (
            <button key={s} onClick={() => setFilterSesso(s)}
              className={`px-2 py-0.5 rounded text-xs font-semibold ${filterSesso === s ? 'bg-sb-blue text-white' : 'bg-sb-bg text-sb-muted hover:bg-sb-sep'}`}>
              {s === 'Male' ? 'M' : s === 'Female' ? 'F' : 'Tutti'}
            </button>
          ))}
        </div>
        <div className="flex gap-2 ml-auto">
          <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-sb-text">
            <input type="checkbox" checked={inclusiGraduatoria} onChange={e => setInclusiGraduatoria(e.target.checked)} className="accent-sb-green w-4 h-4" />
            <span className="text-sb-green font-semibold">Includi Graduatoria</span>
            {inclusiGraduatoria && gradInfo.stato === 'ok' && (
              <span className="text-xs text-sb-muted">(+{gradInfo.rows.length} da graduatoria)</span>
            )}
            {inclusiGraduatoria && gradInfo.stato === 'no_comp' && (
              <span className="text-xs text-orange-600">seleziona prima una competizione</span>
            )}
            {inclusiGraduatoria && gradInfo.stato === 'comp_mismatch' && (
              <span className="text-xs text-orange-600" title={`Calcolata per: ${gradInfo.compCalcolata}`}>
                ⚠ graduatoria calcolata per un'altra competizione
              </span>
            )}
            {inclusiGraduatoria && gradInfo.stato === 'no_data' && (
              <span className="text-xs text-orange-600">
                ⚠ vai in "Qualificati per Graduatoria" e premi CALCOLA
              </span>
            )}
          </label>
          <button onClick={() => setShowAggEstero(true)} className={btnSecond}>+ Aggiungi Estero</button>
          {esteri.length > 0 && (
            <button onClick={() => setShowGestEsteri(true)} className={btnSecond}>
              Gestisci Esteri ({esteri.length})
            </button>
          )}
          <button onClick={() => setShowRinunce(true)} className={`${btnBase} bg-orange-100 text-orange-700 border border-orange-200 hover:bg-orange-200`}>
            Rinunce TL {rinunce.size > 0 && `(${rinunce.size})`}
          </button>
        </div>
      </div>

      {/* ── STATS ── */}
      {filtered.length > 0 && (() => {
        const CAT_COLORS = { RAGAZZI: '#378ADD', JUNIORES: '#D4537E', CADETTI: '#7F77DD', SENIORES: '#1D9E75', ASSOLUTI: '#888780' }
        const SPEC_STYLE = {
          SL: { bg: '#E6F1FB', color: '#185FA5' },
          DO: { bg: '#EAF3DE', color: '#3B6D11' },
          RA: { bg: '#FBEAF0', color: '#993556' },
          FA: { bg: '#FAEEDA', color: '#854F0B' },
          MX: { bg: '#EEEDFE', color: '#534AB7' },
        }
        const SPEC_NAMES = { SL: 'Stile libero', DO: 'Dorso', RA: 'Rana', FA: 'Farfalla', MX: 'Misti' }
        const maxSezGare = Math.max(...SEZIONE_ORDER.filter(s => stats.perSezione[s]).map(s => stats.perSezione[s].gare), 1)
        return (
          <div className="flex flex-col gap-3">
            {/* Hero row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl p-5 relative overflow-hidden" style={{ background: '#185FA5' }}>
                <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'rgba(255,255,255,0.65)' }}>Gare totali</div>
                <div className="text-5xl font-medium" style={{ color: '#fff', lineHeight: 1 }}>{stats.totGare.total}</div>
                <div className="flex gap-4 mt-3">
                  <span className="text-sm" style={{ color: 'rgba(255,255,255,0.7)' }}><span style={{ color: '#fff', fontWeight: 500 }}>{stats.totGare.M}</span> maschili</span>
                  <span className="text-sm" style={{ color: 'rgba(255,255,255,0.7)' }}><span style={{ color: '#fff', fontWeight: 500 }}>{stats.totGare.F}</span> femminili</span>
                </div>
              </div>
              <div className="rounded-xl p-5 relative overflow-hidden" style={{ background: '#993556' }}>
                <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'rgba(255,255,255,0.65)' }}>Atleti qualificati</div>
                <div className="text-5xl font-medium" style={{ color: '#fff', lineHeight: 1 }}>{stats.totAtleti.total}</div>
                <div className="flex gap-4 mt-3">
                  <span className="text-sm" style={{ color: 'rgba(255,255,255,0.7)' }}><span style={{ color: '#fff', fontWeight: 500 }}>{stats.totAtleti.M}</span> maschi</span>
                  <span className="text-sm" style={{ color: 'rgba(255,255,255,0.7)' }}><span style={{ color: '#fff', fontWeight: 500 }}>{stats.totAtleti.F}</span> femmine</span>
                </div>
              </div>
            </div>

            {/* Categorie strip */}
            <div className="grid grid-cols-4 gap-3">
              {CAT_ORDER.map(c => {
                const d = stats.perCat[c] || { M: 0, F: 0, gareM: 0, gareF: 0 }
                const totAtleti = d.M + d.F
                const totGare = (d.gareM || 0) + (d.gareF || 0)
                if (!totAtleti) return null
                return (
                  <div key={c} className="bg-sb-panel rounded-xl border border-sb-sep p-3 flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: CAT_COLORS[c] || '#888' }} />
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-sb-muted">{c}</div>
                      <div className="text-xl font-medium text-sb-text leading-tight">{totAtleti}</div>
                      <div className="text-[10px] text-sb-muted">{totGare} gare · M:{d.M} F:{d.F}</div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Sezione + Specialità */}
            <div className="grid grid-cols-2 gap-3">
              {/* Per sezione */}
              <div className="bg-sb-panel rounded-xl border border-sb-sep p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-sb-muted mb-3">Per sezione</div>
                <div className="flex gap-3 mb-3">
                  <span className="flex items-center gap-1.5 text-xs text-sb-muted"><span className="inline-block w-2 h-2 rounded-full" style={{ background: '#378ADD' }}/>Maschile</span>
                  <span className="flex items-center gap-1.5 text-xs text-sb-muted"><span className="inline-block w-2 h-2 rounded-full" style={{ background: '#D4537E' }}/>Femminile</span>
                </div>
                <div className="flex flex-col gap-2">
                  {SEZIONE_ORDER.filter(s => stats.perSezione[s]).map(s => {
                    const d = stats.perSezione[s]
                    const pct = (v) => Math.round((v / maxSezGare) * 100)
                    return (
                      <div key={s} className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-sb-text w-5">{s}</span>
                        <div className="flex-1 h-5 rounded bg-sb-bg overflow-hidden relative flex">
                          <div className="h-full rounded-l" style={{ width: `${pct(Math.ceil(d.gare * (stats.totGare.M / (stats.totGare.total || 1))))}%`, background: '#378ADD' }} />
                          <div className="h-full" style={{ width: `${pct(Math.floor(d.gare * (stats.totGare.F / (stats.totGare.total || 1))))}%`, background: '#D4537E' }} />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-sb-muted">{d.atleti} at · {d.gare} g</span>
                        </div>
                        <span className="text-xs font-medium text-sb-text w-5 text-right">{d.gare}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Per specialità */}
              <div className="bg-sb-panel rounded-xl border border-sb-sep p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-sb-muted mb-3">Per specialità</div>
                <div className="flex flex-col gap-2.5">
                  {SPEC_ORDER.map(s => {
                    const d = stats.perSpec[s] || { M: 0, F: 0 }
                    if (!d.M && !d.F) return null
                    const st = SPEC_STYLE[s] || { bg: '#f0f0f0', color: '#666' }
                    return (
                      <div key={s} className="flex items-center gap-2.5">
                        <span className="text-xs font-semibold w-7 text-center py-0.5 rounded" style={{ background: st.bg, color: st.color }}>{s}</span>
                        <span className="text-sm text-sb-text flex-1">{SPEC_NAMES[s] || s}</span>
                        <div className="flex gap-1">
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: '#E6F1FB', color: '#185FA5' }}>{d.M}</span>
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: '#FBEAF0', color: '#993556' }}>{d.F}</span>
                        </div>
                        <span className="text-sm font-medium text-sb-text w-5 text-right">{d.M + d.F}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── TABLE ── */}
      {filtered.length > 0 && (
        <div className="rounded-xl border border-sb-sep overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-sb-blue text-white text-xs">
                  {['Atleta','Sez.','Cat.','S','Vasca','Specialità','Dist.','Tempo','FINA','Tipo'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r._id + i} className={`border-b border-sb-sep/50 ${i % 2 === 0 ? 'bg-white' : 'bg-sb-bg/30'} hover:bg-sb-hover/5`}>
                    <td className="px-3 py-1.5 font-medium text-sb-text">{r.atleta}</td>
                    <td className="px-3 py-1.5 font-bold text-sb-blue text-xs">{r.sezione}</td>
                    <td className="px-3 py-1.5 text-sb-muted text-xs">{normCat(r.categoria)}</td>
                    <td className="px-3 py-1.5 text-sb-muted text-xs">{r.sesso === 'Male' ? 'M' : 'F'}</td>
                    <td className="px-3 py-1.5 text-sb-muted text-xs">{r.vasca?.replace(' metri', 'm')}</td>
                    <td className="px-3 py-1.5 text-sb-muted">{r.specialita}</td>
                    <td className="px-3 py-1.5 text-sb-muted">{r.distanza}</td>
                    <td className="px-3 py-1.5 font-mono text-sb-text">{r.tempo}</td>
                    <td className="px-3 py-1.5 text-sb-muted">{r.fina}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${r._source === 'xlsx' ? 'bg-blue-100 text-blue-600' : r._source === 'TL' ? 'bg-purple-100 text-purple-600' : 'bg-green-100 text-green-600'}`}>
                        {r._source === 'xlsx' ? 'TL' : r._source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filtered.length === 0 && xlsxRows.length === 0 && (
        <div className="text-center py-16 text-sb-muted">
          <p className="text-4xl mb-3">🏊</p>
          <p className="font-semibold">Nessuna qualifica caricata</p>
          <p className="text-xs mt-1">Importa un file Excel o carica una sessione salvata</p>
        </div>
      )}

      {/* ── STATUS ── */}
      {status && (
        <div className={`text-sm px-4 py-2 rounded-lg ${status.startsWith('Errore') ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
          {status}
        </div>
      )}

      {/* ── MODALS ── */}
      {showAggEstero && (
        <ModalAggiungiEstero
          onClose={() => setShowAggEstero(false)}
          onAdd={e => setEsteri(prev => [...prev, e])}
        />
      )}
      {showGestEsteri && (
        <ModalGestisciEsteri
          esteri={esteri}
          onClose={() => setShowGestEsteri(false)}
          onRemove={id => setEsteri(prev => prev.filter(e => e._id !== id))}
        />
      )}
      {showRinunce && (
        <ModalRinunce
          allRows={allRows}
          rinunce={rinunce}
          onClose={() => setShowRinunce(false)}
          onSave={sel => setRinunce(sel)}
        />
          )}
      {showAnalisi && (
        <ModalAnalisiSezione
          rows={filtered}
          onClose={() => setShowAnalisi(false)}
        />
      )}
    </div>
  </div>
  )
}