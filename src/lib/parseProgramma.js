/**
 * parseProgramma.js
 * Estrae dal testo del PDF FIN:
 *  - programma: [{giornata, data, sessioni:[{nome, gare:[{tipo,dist,spec,sesso,cat}]}]}]
 *  - graduatoriaLimiti: { "50|STILE|F|RAGAZZI": 60, ... }
 *
 * Supporta tre formati FIN:
 *  FIN1: "I giornata - 4 agosto" + "Batterie/Serie/Finali singole 200 m dorso donne J/C/S"
 *  FIN2: "Sezione femminile: 26-29 marzo" + "Giorno 1" + "1. 200 farfalla donne J/C/S"
 *  FIN3: "Programma - gare" + "26 Giugno 27 Giugno 28 Giugno" + "1. 100 dorso m  11. 100 farfalla f"
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
  const u = s.toUpperCase()
  if (u.includes('RAGAZZI') || u === 'R14' || u === 'R1' || u === 'R2') return 'RAGAZZI'
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
  // Merge digit-space-digit (artefatti PDF: "2 00 m" -> "200 m")
  // Doppio passaggio per "2 0 0"
  s = s.replace(/(\d)\s+(\d)/g, '$1$2')
  s = s.replace(/(\d)\s+(\d)/g, '$1$2')
  return s
}

// ── utilita' condivise ────────────────────────────────────────────────────────

// Separa piu' gare dalla stessa riga (layout 2-3 colonne PDF)
// Es: "4. 200 rana 7. 200 misti" -> ["4. 200 rana", "7. 200 misti"]
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

// "1. 200 farfalla" o "1 200 farfalla donne J/C/S" -> { dist, spec, sesso, cat, catRaw }
function parseNumberedEvent(str) {
  const m = str.match(
    /^(\d+)\s*[.)]?\s*(\d+(?:x\d+)?)\s+([\waaeeeiioou ]+?)(?:\s+(F|M|femmine|maschi|donne|uomini))?(?:\s+(J\/C\/S|J\/C|S|R\d\w*))?$/i
  )
  if (!m) return null
  const distRaw = m[2]
  const dist    = distRaw.includes('x') ? distRaw : parseInt(distRaw)
  const spec    = normSpec(m[3].trim())
  const sesso   = m[4] ? normSesso(m[4]) : null
  const catRaw  = m[5] || ''
  const cat     = catRaw ? normCat(catRaw) : null
  return { dist, spec, sesso, catRaw, cat }
}

// "26-29 marzo 2026" o "4-7 agosto" -> ["26 marzo 2026", ...]
function expandDateRange(rangeStr) {
  // Con anno
  const m = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)\s+(\d{4})/)
  if (m) {
    const start = parseInt(m[1]), end = m[2] ? parseInt(m[2]) : start
    const mese = m[3], anno = m[4]
    const dates = []
    for (let d = start; d <= end; d++) dates.push(`${d} ${mese} ${anno}`)
    return dates
  }
  // Senza anno
  const m2 = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)/)
  if (m2) {
    const start = parseInt(m2[1]), end = m2[2] ? parseInt(m2[2]) : start
    const mese = m2[3]
    const dates = []
    for (let d = start; d <= end; d++) dates.push(`${d} ${mese}`)
    return dates
  }
  return []
}

// ── FIN1: "I giornata - 4 agosto" ────────────────────────────────────────────

function parseProgrammaFIN1(lines) {
  const result = []
  let curGiornata = null
  let curSessione = null

  const RE_GARA = /^(Serie(?:\s+(?:lente|veloci))?|Batterie|Finali\s+singole)\s+(\d+)(?:x(\d+))?\s*m\s+([\waaeeeiioou\s]+?)\s+(F|M|donne|uomini|femmine|maschi)\s*(J\/C\/S|J\/C|S|R\d[-\d]*)?/i
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
      const dist = mc[3] ? `${mc[2]}x${mc[3]}` : parseInt(mc[2])
      const spec = normSpec(mc[4].trim())
      const sesso = normSesso(mc[5])
      const catRaw = mc[6] || ''
      const cat = normCat(catRaw)
      if (/finali/i.test(tipo)) continue
      curSessione.gare.push({ tipo, dist, spec, sesso, cat, catRaw })
      continue
    }
    // Auto-sessione se manca e arriva una gara numerata
    if (curGiornata && !curSessione && /^\d+\s*[.)]/.test(line)) {
      curSessione = { nome: 'Mattina', gare: [] }
      curGiornata.sessioni.push(curSessione)
    }
    // Fallback gara numerata "1. 200 farfalla F J/C"
    if (curSessione && /^\d+\s*[.)]/.test(line)) {
      const parts = splitEventsLine(line)
      for (const part of parts) {
        const ev = parseNumberedEvent(part)
        if (ev) curSessione.gare.push({ tipo: 'Batterie', dist: ev.dist, spec: ev.spec, sesso: ev.sesso, cat: ev.cat, catRaw: ev.catRaw })
      }
    }
  }
  return result
}

// ── FIN2: "Sezione femminile" + "Giorno N" ───────────────────────────────────

function isFormatoFIN2(lines) {
  return lines.some(l =>
    /^giorno\s+\d+/i.test(l) ||
    /sezione\s+(femminile|maschile)/i.test(l)
  )
}

function parseProgrammaFIN2(lines) {
  const result    = []
  let curSesso    = null
  let sectionDates = []
  let curGiornata = null
  let curSessione = null

  const RE_SECTION = /sezione\s+(femminile|maschile)\s*[:\-–]?\s*(.*)/i
  const RE_GIORNO  = /^giorno\s+(\d+)(?:\s*[:\-–]\s*(.+))?/i

  for (const line of lines) {
    const ms = RE_SECTION.exec(line)
    if (ms) {
      curSesso = normSesso(ms[1])
      sectionDates = expandDateRange(ms[2].trim())
      curGiornata = null; curSessione = null
      continue
    }
    const mg = RE_GIORNO.exec(line)
    if (mg) {
      const n = parseInt(mg[1])
      const dataInline = mg[2]?.trim() || null
      const data = dataInline || sectionDates[n - 1] || null
      const existing = result.find(g => g.giornata === String(n))
      if (existing) {
        curGiornata = existing
        if (data && !curGiornata.data) curGiornata.data = data
      } else {
        curGiornata = { giornata: String(n), data, sessioni: [] }
        result.push(curGiornata)
      }
      curSessione = null
      continue
    }
    // Sessione MATTINO/POMERIGGIO
    if (/mattino|mattina|pomeriggio/i.test(line) && !/\d/.test(line)) {
      if (curGiornata) {
        const nomeSess = /mattino|mattina/i.test(line) ? 'Mattino' : 'Pomeriggio'
        curSessione = curGiornata.sessioni.find(s => s.nome === nomeSess)
        if (!curSessione) {
          curSessione = { nome: nomeSess, gare: [] }
          curGiornata.sessioni.push(curSessione)
        }
      }
      continue
    }
    // Gara numerata
    if (/^\d+\s*[.)]/.test(line) && curGiornata) {
      if (!curSessione) {
        curSessione = { nome: 'Pomeriggio', gare: [] }
        curGiornata.sessioni.push(curSessione)
      }
      const parts = splitEventsLine(line)
      for (const part of parts) {
        const ev = parseNumberedEvent(part)
        if (!ev) continue
        const sesso = ev.sesso || curSesso
        curSessione.gare.push({ tipo: 'Batterie', dist: ev.dist, spec: ev.spec, sesso, cat: ev.cat, catRaw: ev.catRaw })
      }
    }
  }
  return result
}

// ── FIN3: "Programma - gare" colonne per giornata ────────────────────────────
// Formato: header colonne "26 Giugno 27 Giugno 28 Giugno"
//          righe eventi   "1. 100 dorso m  11. 100 farfalla f  23. 50 stile libero f"

const MESI_IT = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                 'luglio','agosto','settembre','ottobre','novembre','dicembre']

function isFormatoFIN3(lines) {
  const hasBatterie = lines.some(l => /^batterie\s+e\s+serie\s+lente/i.test(l))
  const hasCols = lines.some(l => {
    const hits = [...l.matchAll(/(\d+)\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/gi)]
    return hits.length >= 2
  })
  return hasBatterie && hasCols
}

function parseProgrammaFIN3(lines) {
  const giorni    = []   // [{data, sessione:{gare:[]}}]
  let dayStarts   = []   // [firstEventNum per giornata]
  let inBatterie  = false
  let headerFound = false

  const RE_DAY_COL = /(\d+)\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/gi
  const RE_BATTERIE = /^batterie\s+e\s+serie\s+lente/i
  const RE_FINALI   = /^finali/i

  for (const line of lines) {
    if (RE_BATTERIE.test(line)) { inBatterie = true; continue }
    if (RE_FINALI.test(line))   { inBatterie = false; continue }

    // Header colonne: "26 Giugno 27 Giugno 28 Giugno"
    if (!headerFound) {
      const hits = [...line.matchAll(RE_DAY_COL)]
      if (hits.length >= 2) {
        headerFound = true
        for (let i = 0; i < hits.length; i++) {
          giorni.push({
            giornata: String(i + 1),
            data: `${hits[i][1]} ${hits[i][2]}`,
            sessioni: [{ nome: 'Batterie', gare: [] }]
          })
        }
        continue
      }
    }

    // Righe eventi (solo nella sezione Batterie)
    if (inBatterie && giorni.length > 0 && /^\d+\s*[.]/.test(line)) {
      const parts = splitEventsLine(line)

      // Prima riga completa: stabilisce i numeri iniziali per ogni colonna
      if (dayStarts.length === 0 && parts.length === giorni.length) {
        dayStarts = parts.map(p => {
          const m = p.match(/^(\d+)/)
          return m ? parseInt(m[1]) : 0
        })
      }

      for (const part of parts) {
        const ev = parseNumberedEvent(part)
        if (!ev) continue
        const evNum = parseInt((part.match(/^(\d+)/) || [])[1] || '0')
        // Trova la giornata: l'ultima con dayStart <= evNum
        let dayIdx = 0
        for (let i = dayStarts.length - 1; i >= 0; i--) {
          if (evNum >= dayStarts[i]) { dayIdx = i; break }
        }
        if (giorni[dayIdx]?.sessioni[0]) {
          giorni[dayIdx].sessioni[0].gare.push({
            tipo: 'Batterie',
            dist: ev.dist,
            spec: ev.spec,
            sesso: ev.sesso,
            cat: ev.cat,
            catRaw: ev.catRaw
          })
        }
      }
    }
  }

  // Restituisci solo giornate con almeno una gara
  return giorni.filter(g => g.sessioni[0].gare.length > 0)
}

// ── entry point ───────────────────────────────────────────────────────────────

export function parseProgramma(text) {
  const lines = text.split(/[\n\r]+/).map(l => normalizeLine(l.trim())).filter(Boolean)

  // FIN3 ha priorita' se rilevato (evita falsi positivi FIN1/FIN2)
  if (isFormatoFIN3(lines)) return parseProgrammaFIN3(lines)

  // FIN1: formato classico con giornate romane
  const fin1 = parseProgrammaFIN1(lines)
  if (fin1.length > 0) return fin1

  // FIN2: formato Giorno N / Sezione femminile
  if (isFormatoFIN2(lines)) return parseProgrammaFIN2(lines)

  return []
}

// ── parse tabella graduatoria limiti ─────────────────────────────────────────

export function parseGraduatoriaLimiti(text) {
  const limiti = {}
  const startIdx = text.indexOf('ammessi dalle graduatorie')
  if (startIdx === -1) return limiti

  const block = text.slice(startIdx, startIdx + 3000)
  const lines  = block.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)

  let colHeaders = null
  const RE_HDR = /^(femmine|maschi|donne|uomini)/i
  const RE_ROW = /^(\d+)\s+(stile\s+libero|dorso|rana|farfalla|misti)\s+([\d\s]+)$/i

  for (const line of lines) {
    if (RE_HDR.test(line)) {
      colHeaders = line.split(/\s+/).map(h => h.toUpperCase())
      continue
    }
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
