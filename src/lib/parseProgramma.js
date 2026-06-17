/**
 * parseProgramma.js
 * Estrae dal testo del PDF FIN:
 *  - programma: [{giornata, data, sessioni:[{nome, gare:[{tipo,dist,spec,sesso,cat}]}]}]
 *  - graduatoriaLimiti: { "50|STILE|F|RAGAZZI": 60, "50|STILE|M|RAGAZZI": 20, ... }
 */

import * as pdfjsLib from 'pdfjs-dist'
// Worker via CDN - evita problemi Vite/GitHub Pages con new URL()
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

// ── normalizzatori ─────────────────────────────────────────────────────────────

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
  if (u.includes('J/C/S') || u.includes('JCS')) return null // multi-cat
  return null
}

// ── estrai testo da PDF base64 ─────────────────────────────────────────────────

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
    // Ricostruisce le righe raggruppando per y-position
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

// ── parser formato FIN-2 (Giorno N, Sezione femminile/maschile) ───────────────
// Formato: "Sezione femminile: 26-29 marzo 2026" → "Giorno 1" → "1. 200 farfalla"
// Layout PDF a 2 colonne (MATTINO / POMERIGGIO): il testo estratto può avere
// due eventi sulla stessa riga ("4. 200 rana   7. 200 misti") — li separiamo.

function isFormatoFIN2(lines) {
  return lines.some(l =>
    /^giorno\s+\d+/i.test(l) ||
    /sezione\s+(femminile|maschile)/i.test(l) ||
    /programma.?gare/i.test(l)
  )
}

// "26-29 marzo 2026" → ["26 marzo 2026", "27 marzo 2026", ...]
function expandDateRange(rangeStr) {
  const m = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)\s+(\d{4})/)
  if (!m) return []
  const start = parseInt(m[1])
  const end   = m[2] ? parseInt(m[2]) : start
  const mese  = m[3]; const anno = m[4]
  const dates = []
  for (let d = start; d <= end; d++) dates.push(`${d} ${mese} ${anno}`)
  return dates
}

// Separa più gare dalla stessa riga (layout 2 colonne)
// Es: "4. 200 rana 7. 200 misti" → ["4. 200 rana", "7. 200 misti"]
function splitEventsLine(line) {
  const RE = /\d+\s*[.)]\s*(?:\d+x\d+|\d+)\s+(?:stile\s+libero|farfalla|dorso|rana|misti|misto)/gi
  const matches = []
  let m
  while ((m = RE.exec(line)) !== null) matches.push({ idx: m.index, text: m[0] })
  if (matches.length <= 1) return [line]
  // estrai ciascun match fino al successivo
  return matches.map((m, i) => {
    const end = matches[i + 1] ? matches[i + 1].idx : line.length
    return line.slice(m.idx, end).trim()
  })
}

// "1. 200 farfalla" o "1 200 farfalla" → { num, dist, spec }
function parseNumberedEvent(str) {
  const m = str.match(/^(\d+)\s*[.)]?\s*(\d+(?:x\d+)?)\s+([\wàèéìòù ]+?)(?:\s+(F|M|femmine|maschi|donne|uomini))?(?:\s+(J\/C\/S|J\/C|S|R\d\w*))?$/i)
  if (!m) return null
  const distRaw = m[2]
  const dist = distRaw.includes('x') ? distRaw : parseInt(distRaw)
  const spec = normSpec(m[3].trim())
  const sessoRaw = m[4] || null
  const sesso = sessoRaw ? normSesso(sessoRaw) : null   // null = usa sesso sezione
  const catRaw = m[5] || ''
  const cat = catRaw ? normCat(catRaw) : null
  return { dist, spec, sesso, catRaw, cat }
}

function parseProgrammaFIN2(lines) {
  const result = []
  let curSesso   = null   // Female | Male | null
  let sectionDates = []   // array di date per i giorni della sezione
  let curGiornata  = null
  let curSessione  = null
  let dayIndex     = 0    // indice giornata dentro la sezione corrente

  const RE_SECTION  = /sezione\s+(femminile|maschile)\s*[:\-–]?\s*(.*)/i
  const RE_GIORNO   = /^giorno\s+(\d+)/i
  const RE_SESSION  = /^(mattino|mattina|pomeriggio)$/i
  const RE_NUMBERED = /^\d+\s*[.)]/

  for (const line of lines) {
    // Sezione femminile/maschile
    const ms = RE_SECTION.exec(line)
    if (ms) {
      curSesso = normSesso(ms[1])
      sectionDates = expandDateRange(ms[2].trim())
      dayIndex = 0
      curGiornata = null; curSessione = null
      continue
    }

    // "Giorno N"
    const mg = RE_GIORNO.exec(line)
    if (mg) {
      const n = parseInt(mg[1])
      const data = sectionDates[n - 1] || `Giorno ${n}`
      // Se già esiste un giornata con stessa data, riusa
      const existing = result.find(g => g.data === data)
      if (existing) {
        curGiornata = existing
      } else {
        curGiornata = { giornata: String(n), data, sessioni: [] }
        result.push(curGiornata)
      }
      // Sessione di default se non ancora creata
      curSessione = null
      dayIndex++
      continue
    }

    // Sessione MATTINO / POMERIGGIO (può apparire combinata nella stessa riga)
    if (/mattino|mattina|pomeriggio/i.test(line) && !/\d/.test(line)) {
      const parts = line.split(/\s{2,}/)
      // crea sessioni nell'ordine in cui appaiono (MATTINO prima, POMERIGGIO dopo)
      // ma non sovrascriviamo curSessione qui: la prossima gara finirà nella sessione corrente
      // Usiamo la prima sessione citata come corrente
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
    if (RE_NUMBERED.test(line) && curGiornata) {
      // può contenere due gare (layout 2 colonne)
      const parts = splitEventsLine(line)
      for (const part of parts) {
        const ev = parseNumberedEvent(part)
        if (!ev) continue
        const sesso = ev.sesso || curSesso   // fallback al sesso della sezione
        // Se non c'è sessione corrente, crea "Pomeriggio" di default
        if (!curSessione) {
          curSessione = { nome: 'Pomeriggio', gare: [] }
          curGiornata.sessioni.push(curSessione)
        }
        curSessione.gare.push({ tipo: 'Batterie', dist: ev.dist, spec: ev.spec, sesso, cat: ev.cat, catRaw: ev.catRaw })
      }
    }
  }

  return result
}


// ── parse programma gare ───────────────────────────────────────────────────────

export function parseProgramma(text) {
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
  const result = []
  let curGiornata = null
  let curSessione = null

  // Regex per riga gara tipo Ragazzi: "Serie 200 m misti F"
  // o J/C/S: "Batterie 50 m farfalla donne J/C/S"
  const RE_GARA = /^(Serie(?:\s+(?:lente|veloci))?|Batterie|Finali\s+singole)\s+(\d+)(?:x(\d+))?\s*m\s+([\wàèéìòù\s]+?)\s+(F|M|donne|uomini|femmine|maschi)\s*(J\/C\/S|J\/C|S|R\d[-\d]*)?/i

  // Giornata: "I giornata – 31 luglio" o "II giornata – 1° agosto"
  const RE_GIORN = /^(I{1,3}V?|V?I{0,3})\s+giornata\s*[–-]\s*(.+)/i

  // Sessione
  const RE_SESS = /^(Mattino|Mattina|Pomeriggio)$/i

  for (const line of lines) {
    const mg = RE_GIORN.exec(line)
    if (mg) {
      curGiornata = { giornata: mg[1], data: mg[2].trim(), sessioni: [] }
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
      // Salta "Finali singole" (già coperto dalla batteria)
      if (/finali/i.test(tipo)) continue
      curSessione.gare.push({ tipo, dist, spec, sesso, cat, catRaw })
    }
  }

  // Se il formato classico non ha estratto nulla, prova formato FIN-2
  if (result.length === 0 && isFormatoFIN2(lines)) {
    return parseProgrammaFIN2(lines)
  }

  return result
}

// ── parse tabella graduatoria limiti ──────────────────────────────────────────

export function parseGraduatoriaLimiti(text) {
  /**
   * Cerca sezioni tipo:
   * "Numero massimo di atleti, a completamento, ammessi dalle graduatorie..."
   * poi righe come: "50 stile libero  60  20  60"
   * Colonne: gara | femmine | maschi R14 | maschi R1-R2
   * (o varianti per altre categorie)
   */
  const limiti = {}

  // Trova il blocco dopo "ammessi dalle graduatorie"
  const startIdx = text.indexOf('ammessi dalle graduatorie')
  if (startIdx === -1) return limiti

  const block = text.slice(startIdx, startIdx + 3000)
  const lines  = block.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)

  // Header riga con "femmine maschi..."
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
      const dist  = parseInt(m[1])
      const spec  = normSpec(m[2])
      const nums  = m[3].trim().split(/\s+/).map(Number)
      // nums[0] = femmine, nums[1] = maschi (prima col), nums[2] = maschi (seconda col) se presente
      if (nums[0] !== undefined) limiti[`${dist}|${spec}|Female`] = nums[0]
      if (nums[1] !== undefined) limiti[`${dist}|${spec}|Male`]   = nums[1]
      // Prendi il massimo per maschi se ci sono due colonne maschili
      if (nums[2] !== undefined && nums[2] > (limiti[`${dist}|${spec}|Male`] || 0))
        limiti[`${dist}|${spec}|Male`] = nums[2]
    }
  }

  return limiti
}
