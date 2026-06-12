/**
 * pdfExtractor.js
 * Port JavaScript di ficr_extractor_core.py v29.0_FIXES
 * Logica identica al Python: line reconstruction, society matching adiacente,
 * pick_by_split_base, gestione speciale 800m/1500m.
 */

import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

// ─── Regex ───────────────────────────────────────────────────────────────────
const RE_PUBBLICATA   = /\bPubblicata:\s*\d{2}\/\d{2}\/\d{4}\b/i
const RE_DATE         = /\b(\d{2}\/\d{2}\/\d{4})\b/i
const RE_ATLETA_START = /^(?!19\d{2}\b)(?!20\d{2}\b)\s*(\d{1,3})\s+/
const RE_TIME_ANY_G   = /\d{1,2}'\d{2}[.,]\d{2}|\d{1,2}:\d{2}[.,]\d{2}|\d{1,2}[.,]\d{2}/g
const RE_TIME_ANY     = /\d{1,2}'\d{2}[.,]\d{2}|\d{1,2}:\d{2}[.,]\d{2}|\d{1,2}[.,]\d{2}/
const RE_PREFIX_DASH  = /^\s*[oai]\s*-\s*/i
const RE_COUNTRY3     = /^[A-Z]{3}$/

const STOP_NAME_TOKENS = new Set([
  'ITA','SSD','ASD','SSDSRL','SRL','SPA',
  'NUOTO','SWIM','TEAM','CLUB','SPORT','SPORTIVA','DILETTANTISTICA',
])

const STYLE_PATTERNS = [
  ['SL', /\bStile\s+Libero\b/i],
  ['DO', /\bDorso\b/i],
  ['RA', /\bRana\b/i],
  ['FA', /\bFarfalla\b/i],
  ['MX', /\bMisti\b|\bMisto\b/i],
]
const RE_STYLE_ABBR = /\b(SL|DO|RA|FA|MX)\b/i

const PHASE_RULES = [
  ['FINALI',    /\bfinal[ie]\b|\bfinale\b/i],
  ['BATTERIE',  /\bbatterie\b|\beliminatorie\b|\bpreliminar[ie]\b/i],
  ['RIEPILOGO', /\briepilog[oh][io]?\b|\bclassifica\b|\brisultati\b/i],
  ['SERIE',     /\bserie\b/i],
]

const DIST_OK = new Set([50, 100, 200, 400, 800, 1500])

// ─── Utility ─────────────────────────────────────────────────────────────────
function normSpace(s) {
  return (s || '')
    .replace(/\xa0/g, ' ').replace(/[–—]/g, '-')
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ').trim()
}

function normSoft(s) {
  return (s || '').toLowerCase()
    .replace(/\xa0/g, ' ').replace(/[’`]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function extractTimes(line) {
  return normSpace(line || '').match(RE_TIME_ANY_G) || []
}

function findDateAnywhere(text) {
  const m = RE_DATE.exec(text || '')
  return m ? m[1] : ''
}

function findDistAny(text) {
  const rx = /\b(\d{2,4})\s*m\b|\b(\d{2,4})m\b/gi
  let m
  while ((m = rx.exec(text || '')) !== null) {
    const d = parseInt(m[1] || m[2])
    if (DIST_OK.has(d)) return d
  }
  return null
}

function findStyle(text) {
  for (const [abbr, rx] of STYLE_PATTERNS) {
    if (rx.test(text)) return abbr
  }
  const m = RE_STYLE_ABBR.exec(text)
  return m ? m[1].toUpperCase() : null
}

function sessoFromText(t) {
  const x = (t || '').toLowerCase()
  if (x.includes('femm')) return 'F'
  if (x.includes('masch')) return 'M'
  return ''
}

function societaTokensMatch(text) {
  const s = normSoft(text || '')
  return s.includes('superba') && s.includes('nuoto')
}

// ─── Conversione tempi ────────────────────────────────────────────────────────
function timeToSeconds(t) {
  if (!t) return Infinity
  const x = normSpace(t).replace(',', '.').trim()
  if (x.includes("'")) {
    const [m, r] = x.split("'")
    return parseFloat(m) * 60 + parseFloat(r)
  }
  if (x.includes(':')) {
    const [m, r] = x.split(':')
    return parseFloat(m) * 60 + parseFloat(r)
  }
  // formato MM.SS.cc (due punti decimali)
  if ((x.match(/\./g) || []).length === 2) {
    const parts = x.split('.')
    try { return parseFloat(parts[0]) * 60 + parseFloat(parts[1] + '.' + parts[2]) }
    catch (_) { }
  }
  return parseFloat(x)
}

function sanitizeCumulatives(times) {
  const out = []
  let prev = -Infinity
  for (const t of times) {
    const v = timeToSeconds(t)
    if (isFinite(v) && v >= prev - 1e-9) { out.push(t); prev = v }
    else break
  }
  return out
}

// ─── Header gara ──────────────────────────────────────────────────────────────
function parseHeaderRobusto(text, lastDate) {
  let txt = normSpace(text)
  if (!txt) return null
  txt = txt.replace(RE_PREFIX_DASH, '')
  const style = findStyle(txt)
  if (!style) return null
  const dist = findDistAny(txt)
  if (!dist) return null
  if (!txt.includes('-')) return null
  const categoria = normSpace(txt.split('-').slice(1).join('-'))
  const dInTxt = findDateAnywhere(txt)
  return {
    gara: dist + style,
    dist,
    sesso: sessoFromText(categoria),
    data_gara: dInTxt || lastDate || '',
    categoria,
  }
}

function parseHeaderSliding(prev, line, next, lastDate) {
  const candidates = [
    line,
    (prev + ' ' + line).trim(),
    (line + ' ' + next).trim(),
    (prev + ' ' + line + ' ' + next).trim(),
  ]
  for (const txt of candidates) {
    const h = parseHeaderRobusto(txt, lastDate)
    if (h) return h
  }
  // Fallback senza trattino
  for (const txt of candidates) {
    const t = normSpace(txt)
    if (!t) continue
    const style = findStyle(t)
    if (!style) continue
    const dist = findDistAny(t)
    if (!dist) continue
    const dInTxt = findDateAnywhere(t)
    const styleRx = /\bStile\s+Libero\b|\bDorso\b|\bRana\b|\bFarfalla\b|\bMisti\b|\bMisto\b|\bSL\b|\bDO\b|\bRA\b|\bFA\b|\bMX\b/i
    const si = t.search(styleRx)
    const categoria = si >= 0 ? normSpace(t.slice(si)) : ''
    return {
      gara: dist + style,
      dist,
      sesso: sessoFromText(categoria),
      data_gara: dInTxt || lastDate || '',
      categoria,
    }
  }
  return null
}

function looksLikeHeaderLine(line) {
  let ln = normSpace(line)
  if (!ln) return false
  ln = ln.replace(RE_PREFIX_DASH, '')
  return !!(findStyle(ln) && findDistAny(ln) && ln.includes('-'))
}

// ─── Riga atleta ──────────────────────────────────────────────────────────────
function cleanAtletaName(nome) {
  nome = (nome || '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim()
  return nome.split(' ').filter(t => {
    const up = t.toUpperCase().replace('.', '')
    if (RE_COUNTRY3.test(up) && up === 'ITA') return false
    if (STOP_NAME_TOKENS.has(up)) return false
    return true
  }).join(' ').trim()
}

function parseAthleteLine(line) {
  const ln = normSpace(line)
  if (!RE_ATLETA_START.test(ln)) return null
  const tokens = ln.split(/\s+/)
  if (tokens.length < 3) return null
  let firstTimeIdx = null
  for (let i = 1; i < tokens.length; i++) {
    if (RE_TIME_ANY.test(tokens[i])) { firstTimeIdx = i; break }
  }
  if (firstTimeIdx === null) return null
  const pos = tokens[0]
  const nameToks = []
  for (let i = 1; i < firstTimeIdx; i++) {
    const up = tokens[i].toUpperCase().replace('.', '')
    if (RE_COUNTRY3.test(up)) break
    if (STOP_NAME_TOKENS.has(up)) break
    nameToks.push(tokens[i])
  }
  const atleta = cleanAtletaName(nameToks.join(' '))
  const times = extractTimes(ln)
  if (!pos || !atleta) return null
  const alphaCount = atleta.split(' ').filter(tok => /[a-zA-ZÀ-ÿ]/.test(tok)).length
  if (alphaCount < 2) return null
  return { pos, atleta, times }
}

// ─── Society matching ─────────────────────────────────────────────────────────
function isBoundaryForSocSearch(ln) {
  if (!ln) return true
  if (RE_PUBBLICATA.test(ln)) return true
  const p = parseAthleteLine(ln)
  return !!(p && p.times.length > 0)
}

function matchSocietaGeneral(allLines, idx) {
  if (societaTokensMatch(allLines[idx])) return true
  if (idx + 1 >= allLines.length) return false
  const line1 = allLines[idx + 1]
  if (isBoundaryForSocSearch(line1)) return false
  if (societaTokensMatch(line1)) return true
  if (idx + 2 < allLines.length) {
    const line2 = allLines[idx + 2]
    if (!isBoundaryForSocSearch(line2)) {
      if (societaTokensMatch(line1 + ' ' + line2)) return true
    }
  }
  return false
}

function matchSocietaSplit25Under(allLines, idx) {
  const collected = []
  for (let k = 1; k <= 4; k++) {
    const j = idx + k
    if (j >= allLines.length) break
    if (isBoundaryForSocSearch(allLines[j])) break
    collected.push(allLines[j])
  }
  if (!collected.length) return false
  if (collected.some(societaTokensMatch)) return true
  return societaTokensMatch(collected.join(' '))
}

// ─── Righe tempi sotto l'atleta ───────────────────────────────────────────────
function isCumulativeTimeLine(times) {
  if (!times || times.length < 2) return false
  if (times.some(t => t.includes("'") || t.includes(':'))) return true
  try { return Math.max(...times.map(timeToSeconds)) > 60 } catch (_) { return false }
}

function collectTimeLinesUnder(allLines, idx, lastDate) {
  const timeLines = []
  let jdx = idx + 1
  while (jdx < allLines.length) {
    const ln = allLines[jdx]
    if (RE_PUBBLICATA.test(ln)) break
    if (looksLikeHeaderLine(ln)) {
      const p = jdx > 0 ? allLines[jdx - 1] : ''
      const n = jdx + 1 < allLines.length ? allLines[jdx + 1] : ''
      if (parseHeaderSliding(p, ln, n, lastDate)) break
    }
    const ap = parseAthleteLine(ln)
    if (ap && ap.times.length > 0) break
    if (societaTokensMatch(ln)) { jdx++; continue }
    const ts = extractTimes(ln)
    if (ts.length) timeLines.push(ts)
    jdx++
  }
  return timeLines
}

// ─── 1500m ───────────────────────────────────────────────────────────────────
function build1500Times(timesAthleteLine, timeLinesUnder) {
  const finale = timesAthleteLine.length ? timesAthleteLine[timesAthleteLine.length - 1] : ''
  const cumulativeLines = []
  if (timesAthleteLine.length) {
    const ts0 = timesAthleteLine.slice(0, -1)
    if (ts0.length && isCumulativeTimeLine(ts0)) cumulativeLines.push(ts0)
  }
  for (const ts of timeLinesUnder) {
    if (isCumulativeTimeLine(ts)) cumulativeLines.push(ts)
  }
  if (!cumulativeLines.length) return finale ? [[finale], finale] : [[], '']
  const splits = []
  cumulativeLines.slice(0, 4).forEach((ts, i) => {
    splits.push(...(i < 3 ? ts.slice(0, 8) : ts))
  })
  const cumul = [...splits]
  if (finale) cumul.push(finale)
  return [cumul, finale]
}

// ─── Pick parziali ────────────────────────────────────────────────────────────
function pickBySplitBase(dist, cumul, splitBase, maxParziali) {
  const parziali = new Array(maxParziali).fill('')
  let finale = ''
  if (dist !== 1500) cumul = sanitizeCumulatives(cumul)
  if (!cumul.length) return [parziali, finale]

  if (dist === 1500) {
    cumul.slice(0, maxParziali).forEach((t, k) => { parziali[k] = t })
    finale = cumul[cumul.length - 1]
    return [parziali, finale]
  }

  if (splitBase === 25) {
    if (dist === 50) {
      finale = cumul.length >= 3 ? cumul[2] : cumul[cumul.length - 1]
      return [parziali, finale]
    }
    if (dist === 100) {
      parziali[0] = cumul.length >= 2 ? cumul[1] : ''
      finale = cumul.length >= 4 ? cumul[3] : cumul[cumul.length - 1]
      return [parziali, finale]
    }
    if (dist === 200) {
      const sel = cumul.filter((_, i) => i % 2 === 1)
      if (!sel.length) { finale = cumul[cumul.length - 1]; return [parziali, finale] }
      sel.slice(0, -1).forEach((t, k) => { if (k < maxParziali) parziali[k] = t })
      finale = sel[sel.length - 1]
      return [parziali, finale]
    }
    cumul.slice(0, -1).forEach((t, k) => { if (k < maxParziali) parziali[k] = t })
    finale = cumul[cumul.length - 1]
    return [parziali, finale]
  }

  // splitBase = 50
  if (dist === 50) { finale = cumul[cumul.length - 1]; return [parziali, finale] }
  if (dist === 100) {
    if (cumul.length >= 3)      { parziali[0] = cumul[0]; finale = cumul[2] }
    else if (cumul.length >= 2) { parziali[0] = cumul[0]; finale = cumul[cumul.length - 1] }
    else                        { finale = cumul[cumul.length - 1] }
    return [parziali, finale]
  }
  cumul.slice(0, -1).forEach((t, k) => { if (k < maxParziali) parziali[k] = t })
  finale = cumul[cumul.length - 1]
  return [parziali, finale]
}

// ─── PDF → righe testo ────────────────────────────────────────────────────────
async function pdfToLines(arrayBuffer, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const allLines = []

  for (let p = 1; p <= pdf.numPages; p++) {
    if (onProgress) onProgress(p, pdf.numPages)
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()

    // Raggruppa per y con tolleranza ~0.5pt (come pdfplumber word-box y_tolerance=0.6)
    const byRow = {}
    for (const item of content.items) {
      if (!item.str) continue
      const y = Math.round(item.transform[5] * 2) / 2
      if (!byRow[y]) byRow[y] = []
      byRow[y].push(item)
    }

    // Y decrescente = ordine top→bottom
    const ys = Object.keys(byRow).map(Number).sort((a, b) => b - a)
    const seen = new Set()

    for (const y of ys) {
      const items = byRow[y].sort((a, b) => a.transform[4] - b.transform[4])
      const text = normSpace(items.map(i => i.str).join(' '))
      if (!text) continue
      const key = normSoft(text)
      if (seen.has(key)) continue
      seen.add(key)
      allLines.push(text)
    }
  }
  return allLines
}

// ─── Estrazione principale ────────────────────────────────────────────────────
export async function extractPDF({
  arrayBuffer,
  filename,
  splitBase = 50,
  maxParziali = 30,
  onLog,
  onProgress,
}) {
  const log = msg => { if (onLog) onLog(msg) }
  log('▶ Estrazione: ' + filename)

  const allLines = await pdfToLines(arrayBuffer, (p, tot) => {
    log('  Pagina ' + p + '/' + tot)
    if (onProgress) onProgress(p, tot)
  })
  log('  Righe ricostruite: ' + allLines.length)

  const parzialiCols = Array.from({ length: maxParziali }, (_, i) => 'parziale_' + ((i + 1) * 50) + 'm')

  const rows = []
  const seenRows = new Set()
  let current = null
  let lastDate = ''
  let currentPhase = ''
  let attesaNuovaGara = false

  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx]
    const prev = idx > 0 ? allLines[idx - 1] : ''
    const next = idx + 1 < allLines.length ? allLines[idx + 1] : ''

    // Fase
    for (const [phase, rx] of PHASE_RULES) {
      if (rx.test(line)) { currentPhase = phase; break }
    }

    // Data
    const dHere = findDateAnywhere(line)
    if (dHere) lastDate = dHere

    // Pubblicata
    if (RE_PUBBLICATA.test(line)) {
      current = null; attesaNuovaGara = true; currentPhase = ''
      continue
    }

    const athleteParsed = parseAthleteLine(line)

    // Header gara
    const hdr = parseHeaderSliding(prev, line, next, lastDate)
    if (hdr) {
      current = hdr
      attesaNuovaGara = false
      if (hdr.data_gara) lastDate = hdr.data_gara
      log('  Gara: ' + hdr.gara + ' ' + hdr.sesso + ' ' + hdr.data_gara)
      if (!athleteParsed) continue
    }

    if ((attesaNuovaGara && !current) || !current) continue
    if (!athleteParsed) continue

    const { pos, atleta, times: cumul } = athleteParsed
    const dist = current.dist

    // Filtro società
    let okSoc
    if (splitBase === 25 && [200, 400, 800, 1500].includes(dist)) {
      okSoc = matchSocietaSplit25Under(allLines, idx)
    } else {
      okSoc = matchSocietaGeneral(allLines, idx)
    }
    if (!okSoc) continue

    let finalCumul = [...cumul]
    let finaleOverride = ''

    if (dist === 1500) {
      const under = collectTimeLinesUnder(allLines, idx, lastDate)
      const [c1500, fin] = build1500Times(cumul, under)
      finalCumul = c1500
      finaleOverride = fin
    } else if (dist === 800) {
      const under = collectTimeLinesUnder(allLines, idx, lastDate)
      const filtered = under.filter(isCumulativeTimeLine)
      if (splitBase === 25) {
        let take = true
        for (const ts of filtered) { if (take) finalCumul.push(...ts); take = !take }
      } else {
        for (const ts of filtered) finalCumul.push(...ts)
      }
    }

    let [parziali, tempoFinale] = pickBySplitBase(dist, finalCumul, splitBase, maxParziali)
    if (dist === 1500 && finaleOverride) tempoFinale = finaleOverride

    // Dedup (senza pos — FIX-8)
    const dedupKey = current.gara + '|' + (current.data_gara || '') + '|' + atleta + '|' + currentPhase
    if (seenRows.has(dedupKey)) continue
    seenRows.add(dedupKey)

    const row = {
      fonte_pdf:    filename,
      gara:         current.gara,
      sesso:        current.sesso || '',
      data_gara:    current.data_gara || '',
      fase:         currentPhase || 'ELIMINATORIE',
      posizione:    pos,
      atleta,
      societa:      'Superba Nuoto ssd',
      tempo_finale: tempoFinale,
    }
    parziali.forEach((t, i) => { if (t) row[parzialiCols[i]] = t })
    rows.push(row)
  }

  log('✓ Estratti: ' + rows.length + ' risultati')
  return rows
}
