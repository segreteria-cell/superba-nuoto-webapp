/**
 * parseProgramma.js
 * Estrae dal testo del PDF FIN il programma gare.
 *
 * FIN1: "I giornata - 4 agosto" + "Batterie 200 m dorso donne J/C/S"
 * FIN2: "Sezione femminile: 26-29 marzo" + "Giorno 1" + "1. 200 farfalla"
 * FIN3: "Batterie e Serie lente" + header "26 Giugno 27 Giugno ..." + eventi a colonne
 */

import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

// ── normalizzatori ────────────────────────────────────────────────────────────

function normSpec(s) {
  const u = s.toUpperCase()
  if (u.includes('STILE') || u.includes('LIBERO')) return 'STILE'
  if (u.includes('DORSO'))    return 'DORSO'
  if (u.includes('RANA'))     return 'RANA'
  if (u.includes('FARFALLA')) return 'FARFALLA'
  if (u.includes('MISTI'))    return 'MISTI'
  return u
}

function normSesso(s) {
  const u = s.toUpperCase()
  if (u === 'F' || u.includes('DONN') || u.includes('FEMM')) return 'Female'
  if (u === 'M' || u.includes('UOMIN') || u.includes('MASCH')) return 'Male'
  return null
}

function normCat(s) {
  if (!s) return null
  const u = s.toUpperCase().trim()
  if (u === 'R' || u.includes('RAGAZZI') || /^R\d/.test(u)) return 'RAGAZZI'
  if (u.includes('JUNIOR'))  return 'JUNIORES'
  if (u.includes('CADET'))   return 'CADETTI'
  if (u.includes('SENIOR'))  return 'SENIORES'
  if (u.includes('J/C/S') || u.includes('JCS')) return null
  return null
}

// ── estrai testo da PDF base64 ────────────────────────────────────────────────

export async function extractPdfText(base64) {
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pdf    = await pdfjsLib.getDocument({ data: bytes }).promise
  console.log('[PDF] pagine:', pdf.numPages)
  let text = ''
  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p)
    const content = await page.getTextContent()
    const byY = {}
    for (const item of content.items) {
      if (!item.str.trim()) continue
      const y = Math.round(item.transform[5])
      if (!byY[y]) byY[y] = []
      byY[y].push(item.str)
    }
    const sortedY = Object.keys(byY).map(Number).sort((a, b) => b - a)
    for (const y of sortedY) text += byY[y].join(' ') + '\n'
  }
  console.log('[PDF] testo estratto (prime 500 chars):', text.slice(0, 500))
  return text
}

// ── normalizza riga PDF ───────────────────────────────────────────────────────

function normalizeLine(line) {
  let s = line
    .replace(/J\s*\/\s*C\s*\/\s*S/gi, 'J/C/S')
    .replace(/J\s*\/\s*C/gi, 'J/C')
    .replace(/\s{2,}/g, ' ')
  // Merge digit-space-digit: "2 00 m" -> "200 m"  (due passaggi per "2 0 0")
  s = s.replace(/(\d)\s+(\d)/g, '$1$2')
  s = s.replace(/(\d)\s+(\d)/g, '$1$2')
  // Merge relay: "4 x200" o "4x 200" -> "4x200"
  s = s.replace(/(\d)\s*x\s*(\d)/gi, '$1x$2')
  return s
}

// ── utilita' condivise ────────────────────────────────────────────────────────

// Separa piu' gare dalla stessa riga (layout 2-3 colonne PDF)
function splitEventsLine(line) {
  const RE = /\d+\s*[.)]\s*(?:\d+x\d+|\d+)\s+(?:stile\s+libero|farfalla|dorso|rana|misti|misto)/gi
  const matches = []
  let m
  while ((m = RE.exec(line)) !== null) matches.push({ idx: m.index, text: m[0] })
  if (matches.length <= 1) return [line]
  return matches.map((mm, i) => {
    const end = matches[i + 1] ? matches[i + 1].idx : line.length
    return line.slice(mm.idx, end).trim()
  })
}

// "1. 200 farfalla" o "3 . 200 dorso donne J/C" -> { dist, spec, sesso, cat, catRaw }
function parseNumberedEvent(str) {
  const m = str.match(
    /^(\d+)\s*[.)]?\s*(\d+(?:x\d+)?)\s+([\waaeeeiioou ]+?)(?:\s+(F|M|femmine|maschi|donne|uomini))?(?:\s+(J\/C\/S|J\/C|S|R\d?\w*))?$/i
  )
  if (!m) return null
  const distRaw = m[2]
  const dist    = distRaw.toLowerCase().includes('x') ? distRaw : parseInt(distRaw)
  const spec    = normSpec(m[3].trim())
  const sesso   = m[4] ? normSesso(m[4]) : null
  const catRaw  = m[5] || ''
  const cat     = normCat(catRaw)
  return { dist, spec, sesso, catRaw, cat }
}

const MESI_IT = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                 'luglio','agosto','settembre','ottobre','novembre','dicembre']
function meseNum(s) { return MESI_IT.findIndex(m => s.toLowerCase().startsWith(m.slice(0,3))) }

// Genera array di date da startDate a endDate (inclusive)
function dateRange(startDate, endDate, anno) {
  const dates = []
  const d = new Date(anno, startDate.m, startDate.d)
  const e = new Date(anno, endDate.m, endDate.d)
  while (d <= e) {
    dates.push(`${d.getDate()} ${MESI_IT[d.getMonth()]} ${d.getFullYear()}`)
    d.setDate(d.getDate() + 1)
  }
  return dates
}

// "26-29 marzo 2026" o "30 marzo – 2 aprile 2026" o "4-7 agosto" -> ["26 marzo 2026", ...]
function expandDateRange(rangeStr) {
  // Range cross-mese: "30 marzo – 2 aprile 2026" o "30 marzo – 2 aprile"
  const cx = rangeStr.match(/(\d+)\s+(\w+)\s*[-–]\s*(\d+)\s+(\w+)(?:\s+(\d{4}))?/i)
  if (cx && meseNum(cx[2]) >= 0) {
    const anno    = cx[5] ? parseInt(cx[5]) : new Date().getFullYear()
    const startM  = meseNum(cx[2]), endM = meseNum(cx[4])
    if (startM >= 0 && endM >= 0)
      return dateRange({ d: parseInt(cx[1]), m: startM }, { d: parseInt(cx[3]), m: endM >= startM ? endM : endM + 12 }, anno)
  }
  // Range stesso mese con anno: "26-29 marzo 2026"
  const m = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)\s+(\d{4})/i)
  if (m && meseNum(m[3]) >= 0) {
    const mese = meseNum(m[3]), anno = parseInt(m[4])
    const start = parseInt(m[1]), end = m[2] ? parseInt(m[2]) : start
    return dateRange({ d: start, m: mese }, { d: end, m: mese }, anno)
  }
  // Senza anno
  const m2 = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)/i)
  if (m2 && meseNum(m2[3]) >= 0) {
    const mese = meseNum(m2[3]), anno = new Date().getFullYear()
    const start = parseInt(m2[1]), end = m2[2] ? parseInt(m2[2]) : start
    return dateRange({ d: start, m: mese }, { d: end, m: mese }, anno)
  }
  return []
}

// ── FIN1: "I giornata - 4 agosto" ────────────────────────────────────────────

function parseProgrammaFIN1(lines) {
  const result = []
  let curGiornata = null
  let curSessione = null

  const RE_GARA  = /^(Serie(?:\s+(?:lente|veloci))?|Batterie|Finali\s+singole)\s+(\d+)(?:x(\d+))?\s*m\s+([\waaeeeiioou\s]+?)\s+(F|M|donne|uomini|femmine|maschi)\s*(J\/C\/S|J\/C|S|R\d[-\d]*)?/i
  const RE_GIORN = /^(I{1,3}V?|VI{0,3}|IX|XI{0,3})\s+giornata\s*[–—\-]\s*(.+)/i
  const RE_SESS  = /^(Mattino|Mattina|Pomeriggio|MATTINO|POMERIGGIO)(?:\s+(?:Mattino|Mattina|Pomeriggio))?$/i

  for (const line of lines) {
    const mg = RE_GIORN.exec(line)
    if (mg) {
      curGiornata = { giornata: mg[1].trim(), data: mg[2].trim(), sessioni: [] }
      curSessione = null
      result.push(curGiornata)
      continue
    }
    const ms = RE_SESS.exec(line)
    if (ms) {
      const nome = ms[1].charAt(0).toUpperCase() + ms[1].slice(1).toLowerCase()
      curSessione = { nome, gare: [] }
      if (curGiornata) curGiornata.sessioni.push(curSessione)
      continue
    }
    const mc = RE_GARA.exec(line)
    if (mc && curSessione) {
      const tipo = mc[1].replace(/\s+/g, ' ').trim()
      if (/finali/i.test(tipo)) continue
      const dist   = mc[3] ? `${mc[2]}x${mc[3]}` : parseInt(mc[2])
      const spec   = normSpec(mc[4].trim())
      const sesso  = normSesso(mc[5])
      const catRaw = mc[6] || ''
      const cat    = normCat(catRaw)
      curSessione.gare.push({ tipo, dist, spec, sesso, cat, catRaw })
      continue
    }
    // Auto-sessione e fallback gara numerata
    if (curGiornata && !curSessione && /^\d+\s*[.)]/.test(line)) {
      curSessione = { nome: 'Mattina', gare: [] }
      curGiornata.sessioni.push(curSessione)
    }
    if (curSessione && /^\d+\s*[.)]/.test(line)) {
      for (const part of splitEventsLine(line)) {
        const ev = parseNumberedEvent(part)
        if (ev) curSessione.gare.push({ tipo: 'Batterie', dist: ev.dist, spec: ev.spec, sesso: ev.sesso, cat: ev.cat, catRaw: ev.catRaw })
      }
    }
  }
  return result
}

// ── FIN2: "Sezione femminile/maschile" + "Giorno N" ──────────────────────────
// Ogni sezione ha Giorno 1..N separati: NON si mergiano tra sezioni diverse.

function isFormatoFIN2(lines) {
  return lines.some(l =>
    /^giorno\s+\d+/i.test(l) ||
    /sezione\s+(femminile|maschile)/i.test(l)
  )
}

function parseProgrammaFIN2(lines) {
  const result     = []
  let curSesso     = null
  let sectionDates = []
  let curGiornata  = null
  let curSessione  = null
  let sectionId    = 0   // incrementa per ogni sezione: evita merge Giorno 1 F + Giorno 1 M

  const RE_SECTION = /^sezione\s+(femminile|maschile)\s*[:\-–]?\s*(.*)/i
  const RE_GIORNO  = /^giorno\s+(\d+)(?:\s*[:\-–]\s*(.+))?/i

  for (const line of lines) {
    // Nuova sezione femminile/maschile
    const ms = RE_SECTION.exec(line)
    if (ms) {
      curSesso     = normSesso(ms[1])
      sectionDates = expandDateRange(ms[2].trim())
      curGiornata  = null
      curSessione  = null
      sectionId++
      continue
    }

    // Giorno N
    const mg = RE_GIORNO.exec(line)
    if (mg) {
      const n          = parseInt(mg[1])
      const dataInline = mg[2]?.trim() || null
      const data       = dataInline || sectionDates[n - 1] || null
      const sKey       = `${sectionId}-${n}`  // chiave univoca per sezione+numero
      const existing   = result.find(g => g._sKey === sKey)
      if (existing) {
        curGiornata = existing
        if (data && !curGiornata.data) curGiornata.data = data
      } else {
        curGiornata = { giornata: String(n), data, sessioni: [], _sKey: sKey }
        result.push(curGiornata)
      }
      curSessione = null
      continue
    }

    // Sessione MATTINO/POMERIGGIO (anche "MATTINO POMERIGGIO" su stessa riga)
    if (/mattino|mattina|pomeriggio/i.test(line) && !/\d/.test(line) && curGiornata) {
      const nomeSess = /mattino|mattina/i.test(line) ? 'Mattino' : 'Pomeriggio'
      curSessione = curGiornata.sessioni.find(s => s.nome === nomeSess)
      if (!curSessione) {
        curSessione = { nome: nomeSess, gare: [] }
        curGiornata.sessioni.push(curSessione)
      }
      continue
    }

    // Gare numerate
    if (/^\d+\s*[.)]/.test(line) && curGiornata) {
      if (!curSessione) {
        curSessione = { nome: 'Gare', gare: [] }
        curGiornata.sessioni.push(curSessione)
      }
      const parts = splitEventsLine(line)
      // Se la riga ha 2 parti (MATTINO | POMERIGGIO), split su sessioni separate
      let sess0 = curSessione
      let sess1 = curSessione
      if (parts.length >= 2) {
        sess0 = ensureSession(curGiornata, 'Mattino')
        sess1 = ensureSession(curGiornata, 'Pomeriggio')
        curSessione = sess0
      }
      parts.forEach((part, i) => {
        const ev = parseNumberedEvent(part)
        if (!ev) return
        const sesso = ev.sesso || curSesso
        const sess  = parts.length >= 2 ? (i === 0 ? sess0 : sess1) : sess0
        sess.gare.push({ tipo: 'Batterie', dist: ev.dist, spec: ev.spec, sesso, cat: ev.cat, catRaw: ev.catRaw })
      })
    }
  }
  return result
}

function ensureSession(giornata, nome) {
  let s = giornata.sessioni.find(x => x.nome === nome)
  if (!s) { s = { nome, gare: [] }; giornata.sessioni.push(s) }
  return s
}

// ── FIN3: "Batterie e Serie lente" + colonne "26 Giugno 27 Giugno ..." ───────

function isFormatoFIN3(lines) {
  const hasBatterie = lines.some(l => /^batterie\s+e\s+serie\s+lente/i.test(l))
  const hasCols = lines.some(l => {
    const hits = [...l.matchAll(/(\d+)\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/gi)]
    return hits.length >= 2
  })
  return hasBatterie && hasCols
}

function parseProgrammaFIN3(lines) {
  const giorni   = []
  let dayStarts  = []
  let inBatterie = false
  let headerDone = false

  const RE_DAY_COL  = /(\d+)\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/gi
  const RE_BATTERIE = /^batterie\s+e\s+serie\s+lente/i
  const RE_FINALI   = /^finali/i

  for (const line of lines) {
    if (RE_BATTERIE.test(line)) { inBatterie = true; continue }
    if (RE_FINALI.test(line))   { inBatterie = false; continue }

    // Header colonne "26 Giugno 27 Giugno 28 Giugno"
    if (!headerDone) {
      const hits = [...line.matchAll(RE_DAY_COL)]
      if (hits.length >= 2) {
        headerDone = true
        hits.forEach((h, i) => {
          giorni.push({
            giornata: String(i + 1),
            data: `${h[1]} ${h[2]}`,
            sessioni: [{ nome: 'Batterie', gare: [] }]
          })
        })
        continue
      }
    }

    // Righe eventi (solo in sezione Batterie)
    if (inBatterie && giorni.length > 0 && /^\d+\s*[.]/.test(line)) {
      const parts = splitEventsLine(line)
      if (dayStarts.length === 0 && parts.length === giorni.length) {
        dayStarts = parts.map(p => parseInt((p.match(/^(\d+)/) || [])[1] || '0'))
      }
      for (const part of parts) {
        const ev = parseNumberedEvent(part)
        if (!ev) continue
        const evNum = parseInt((part.match(/^(\d+)/) || [])[1] || '0')
        let dayIdx = 0
        for (let i = dayStarts.length - 1; i >= 0; i--) {
          if (evNum >= dayStarts[i]) { dayIdx = i; break }
        }
        if (giorni[dayIdx]?.sessioni[0]) {
          giorni[dayIdx].sessioni[0].gare.push({
            tipo: 'Batterie', dist: ev.dist, spec: ev.spec,
            sesso: ev.sesso, cat: ev.cat, catRaw: ev.catRaw
          })
        }
      }
    }
  }
  return giorni.filter(g => g.sessioni[0].gare.length > 0)
}

// ── entry point ───────────────────────────────────────────────────────────────

export function parseProgramma(text) {
  const lines = text.split(/[\n\r]+/).map(l => normalizeLine(l.trim())).filter(Boolean)
  if (isFormatoFIN3(lines)) return parseProgrammaFIN3(lines)
  const fin1 = parseProgrammaFIN1(lines)
  if (fin1.length > 0) return fin1
  if (isFormatoFIN2(lines)) return parseProgrammaFIN2(lines)
  return []
}

// ── parse tabella graduatoria limiti ─────────────────────────────────────────

export function parseGraduatoriaLimiti(text) {
  const limiti   = {}
  const startIdx = text.indexOf('ammessi dalle graduatorie')
  if (startIdx === -1) return limiti
  const block = text.slice(startIdx, startIdx + 3000)
  const lines  = block.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
  const RE_HDR = /^(femmine|maschi|donne|uomini)/i
  const RE_ROW = /^(\d+)\s+(stile\s+libero|dorso|rana|farfalla|misti)\s+([\d\s]+)$/i
  for (const line of lines) {
    if (RE_HDR.test(line)) continue
    const m = RE_ROW.exec(line)
    if (m) {
      const dist = parseInt(m[1])
      const spec = normSpec(m[2])
      const nums = m[3].trim().split(/\s+/).map(Number)
      if (nums[0] !== undefined) limiti[`${dist}|${spec}|Female`] = nums[0]
      if (nums[1] !== undefined) limiti[`${dist}|${spec}|Male`]   = nums[1]
      if (nums[2] !== undefined && nums[2] > (limiti[`${dist}|${spec}|Male`] || 0))
        limiti[`${dist}|${spec}|Male`] = nums[2]
    }
  }
  return limiti
}
