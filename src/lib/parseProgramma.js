/**
 * parseProgramma.js
 * Estrae dal testo del PDF FIN il programma gare.
 *
 * FIN1: "I giornata - 4 agosto" + "Batterie 200 m dorso donne J/C/S"
 * FIN2: "Sezione femminile: 26-29 marzo" + "Giorno 1" + "1. 200 farfalla"
 * FIN3: "Batterie e Serie lente" + header "26 Giugno 27 Giugno ..." + eventi col.
 * FIN4: "Programma - gare" + "12 Dicembre a.m." + "50 farfalla m" (no numeri)
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
  if (u === 'J/C/S' || u === 'JCS' || u === 'J/C') return 'JCS'
  return null
}

// ── estrai testo da PDF (con colonne separate da TAB) ─────────────────────────
// Gli elementi sullo stesso Y ma con gap X > 20 pt sono separati da \t.
// Questo permette ai parser di riconoscere le colonne delle tabelle.

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
    for (const y of sortedY) {
      text += byY[y].join(' ') + '\n'
    }
  }
  console.log('[PDF] testo estratto (prime 500 chars):', text.slice(0, 500))
  return text
}

// ── normalizza riga PDF ───────────────────────────────────────────────────────
// Processa ogni colonna (separata da \t) separatamente, poi ricongiunge.

function normalizeCol(col) {
  let s = col
    .replace(/J\s*\/\s*C\s*\/\s*S/gi, 'J/C/S')
    .replace(/J\s*\/\s*C/gi, 'J/C')
    .replace(/\s{2,}/g, ' ')
  // Merge digit-space-digit: "2 00" -> "200"
  s = s.replace(/(\d)\s+(\d)/g, '$1$2')
  s = s.replace(/(\d)\s+(\d)/g, '$1$2')
  // Merge relay: "4 x200" -> "4x200"
  s = s.replace(/(\d)\s*x\s*(\d)/gi, '$1x$2')
  // Normalizza nomi mese splittati dal PDF: "Dic embre" -> "Dicembre"
  s = s.replace(/Gen\s+naio/gi,    'Gennaio')
       .replace(/Feb\s+braio/gi,   'Febbraio')
       .replace(/Mar\s+zo/gi,      'Marzo')
       .replace(/Apr\s+ile/gi,     'Aprile')
       .replace(/Mag\s+gio/gi,     'Maggio')
       .replace(/Giu\s+gno/gi,     'Giugno')
       .replace(/Lug\s+lio/gi,     'Luglio')
       .replace(/Ago\s+sto/gi,     'Agosto')
       .replace(/Set\s+tembre/gi,  'Settembre')
       .replace(/Ott\s+obre/gi,    'Ottobre')
       .replace(/Nov\s+embre/gi,   'Novembre')
       .replace(/Dic\s+embre/gi,   'Dicembre')
       .replace(/Dice\s+mbre/gi,   'Dicembre')
  // Normalizza "a .m." / "p .m." -> "a.m." / "p.m."
  s = s.replace(/\b([ap])\s*\.\s*m\s*\./gi, '$1.m.')
  return s.trim()
}

function normalizeLine(line) {
  return normalizeCol(line)
}

// ── utilita' condivise ────────────────────────────────────────────────────────

// Separa piu' gare numerate dalla stessa colonna (layout 2-3 colonne PDF)
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

// "1. 200 farfalla" -> { dist, spec, sesso, cat, catRaw }
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

// "50 farfalla m" (senza numero) -> { dist, spec, sesso }
function parseUnnumberedEvent(str) {
  const m = str.match(/^(\d+(?:x\d+)?)\s+(stile\s+libero|farfalla|dorso|rana|misti|misto)\s+(m|f)/i)
  if (!m) return null
  const dist = m[1].toLowerCase().includes('x') ? m[1] : parseInt(m[1])
  return { dist, spec: normSpec(m[2]), sesso: normSesso(m[3]), cat: null, catRaw: '' }
}

const MESI_IT = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                 'luglio','agosto','settembre','ottobre','novembre','dicembre']
function meseNum(s) { return MESI_IT.findIndex(m => s.toLowerCase().startsWith(m.slice(0,3))) }

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

function expandDateRange(rangeStr) {
  // Cross-mese: "30 marzo - 2 aprile 2026"
  const cx = rangeStr.match(/(\d+)\s+(\w+)\s*[-–]\s*(\d+)\s+(\w+)(?:\s+(\d{4}))?/i)
  if (cx && meseNum(cx[2]) >= 0) {
    const anno = cx[5] ? parseInt(cx[5]) : new Date().getFullYear()
    const sm = meseNum(cx[2]), em = meseNum(cx[4])
    if (sm >= 0 && em >= 0)
      return dateRange({ d: parseInt(cx[1]), m: sm }, { d: parseInt(cx[3]), m: em >= sm ? em : em + 12 }, anno)
  }
  // Stesso mese con anno: "26-29 marzo 2026"
  const m = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)\s+(\d{4})/i)
  if (m && meseNum(m[3]) >= 0) {
    const mese = meseNum(m[3]), anno = parseInt(m[4])
    return dateRange({ d: parseInt(m[1]), m: mese }, { d: m[2] ? parseInt(m[2]) : parseInt(m[1]), m: mese }, anno)
  }
  // Senza anno
  const m2 = rangeStr.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s+(\w+)/i)
  if (m2 && meseNum(m2[3]) >= 0) {
    const mese = meseNum(m2[3]), anno = new Date().getFullYear()
    return dateRange({ d: parseInt(m2[1]), m: mese }, { d: m2[2] ? parseInt(m2[2]) : parseInt(m2[1]), m: mese }, anno)
  }
  return []
}

// ── FIN1: "I giornata - 4 agosto" ────────────────────────────────────────────

function parseProgrammaFIN1(lines) {
  const result = []
  let curGiornata = null
  let curSessione = null
  let curSezione  = null  // 'RAGAZZI' | 'JCS' | null

  const RE_GARA    = /^(Serie(?:\s+(?:lente|veloci))?|Batterie|Finali\s+singole)\s+(\d+)(?:x(\d+))?\s*m\s+([\waaeeeiioou\s]+?)\s+(F|M|donne|uomini|femmine|maschi)\s*(J\/C\/S|J\/C|S|R\d[-\d]*)?/i
  const RE_GIORN   = /^(I{1,3}V?|VI{0,3}|IX|XI{0,3})\s+giornata\s*[–—\-]\s*(.+)/i
  const RE_SESS    = /^(Mattino|Mattina|Pomeriggio|MATTINO|POMERIGGIO)(?:\s+(?:Mattino|Mattina|Pomeriggio))?$/i
  const RE_SEZIONE = /programma.gare della sezione\s+(ragazzi|junior|cadet|senior)/i

  for (const line of lines) {
    const firstCol = line.split('\t')[0]
    const mSez = RE_SEZIONE.exec(firstCol)
    if (mSez) {
      curSezione = /ragazzi/i.test(mSez[1]) ? 'RAGAZZI' : 'JCS'
      continue
    }
    const mg = RE_GIORN.exec(firstCol)
    if (mg) {
      curGiornata = { giornata: mg[1].trim(), data: mg[2].trim(), sessioni: [] }
      curSessione = null
      result.push(curGiornata)
      continue
    }
    const ms = RE_SESS.exec(firstCol)
    if (ms) {
      const nome = ms[1].charAt(0).toUpperCase() + ms[1].slice(1).toLowerCase()
      curSessione = { nome, gare: [] }
      if (curGiornata) curGiornata.sessioni.push(curSessione)
      continue
    }
    const mc = RE_GARA.exec(firstCol)
    if (mc && curSessione) {
      const tipo = mc[1].replace(/\s+/g, ' ').trim()
      if (/finali/i.test(tipo)) continue
      const dist   = mc[3] ? `${mc[2]}x${mc[3]}` : parseInt(mc[2])
      const spec   = normSpec(mc[4].trim())
      const sesso  = normSesso(mc[5])
      const catRaw = mc[6] || ''
      let cat = normCat(catRaw)
      // Se il parser non ha trovato categoria esplicita, usa la sezione corrente
      if (!cat && curSezione) cat = curSezione
      curSessione.gare.push({ tipo, dist, spec, sesso, cat, catRaw })
      continue
    }
    if (curGiornata && !curSessione && /^\d+\s*[.)]/.test(firstCol)) {
      curSessione = { nome: 'Mattina', gare: [] }
      curGiornata.sessioni.push(curSessione)
    }
    if (curSessione && /^\d+\s*[.)]/.test(firstCol)) {
      for (const part of splitEventsLine(firstCol)) {
        const ev = parseNumberedEvent(part)
        if (ev) curSessione.gare.push({ tipo: 'Batterie', dist: ev.dist, spec: ev.spec, sesso: ev.sesso, cat: ev.cat, catRaw: ev.catRaw })
      }
    }
  }
  return result
}

// ── FIN2: "Sezione femminile/maschile" + "Giorno N" ──────────────────────────

function isFormatoFIN2(lines) {
  return lines.some(l => {
    const f = l.split('\t')[0]
    return /^giorno\s+\d+/i.test(f) || /^sezione\s+(femminile|maschile)/i.test(f)
  })
}

function ensureSession(giornata, nome) {
  let s = giornata.sessioni.find(x => x.nome === nome)
  if (!s) { s = { nome, gare: [] }; giornata.sessioni.push(s) }
  return s
}

function parseProgrammaFIN2(lines) {
  const result     = []
  let curSesso     = null
  let sectionDates = []
  let curGiornata  = null
  let curSessione  = null
  let sectionId    = 0

  const RE_SECTION = /^sezione\s+(femminile|maschile)\s*[:\-–]?\s*(.*)/i
  const RE_GIORNO  = /^giorno\s+(\d+)(?:\s*[:\-–]\s*(.+))?/i

  for (const line of lines) {
    const firstCol = line.split('\t')[0]
    const ms = RE_SECTION.exec(firstCol)
    if (ms) {
      curSesso = normSesso(ms[1]); sectionDates = expandDateRange(ms[2].trim())
      curGiornata = null; curSessione = null; sectionId++
      continue
    }
    const mg = RE_GIORNO.exec(firstCol)
    if (mg) {
      const n = parseInt(mg[1])
      const data = mg[2]?.trim() || sectionDates[n - 1] || null
      const sKey = `${sectionId}-${n}`
      const existing = result.find(g => g._sKey === sKey)
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
    if (/mattino|mattina|pomeriggio/i.test(firstCol) && !/\d/.test(firstCol) && curGiornata) {
      const nomeSess = /mattino|mattina/i.test(firstCol) ? 'Mattino' : 'Pomeriggio'
      curSessione = ensureSession(curGiornata, nomeSess)
      continue
    }
    if (/^\d+\s*[.)]/.test(firstCol) && curGiornata) {
      if (!curSessione) { curSessione = { nome: 'Gare', gare: [] }; curGiornata.sessioni.push(curSessione) }
      const cols = line.split('\t')
      const parts0 = splitEventsLine(cols[0] || '')
      const parts1 = cols.length > 1 ? splitEventsLine(cols[1] || '') : []
      if (parts1.length > 0) {
        // Due colonne: MATTINO | POMERIGGIO
        const s0 = ensureSession(curGiornata, 'Mattino')
        const s1 = ensureSession(curGiornata, 'Pomeriggio')
        for (const p of parts0) { const ev = parseNumberedEvent(p); if (ev) s0.gare.push({ tipo:'Batterie', dist:ev.dist, spec:ev.spec, sesso:ev.sesso||curSesso, cat:ev.cat, catRaw:ev.catRaw }) }
        for (const p of parts1) { const ev = parseNumberedEvent(p); if (ev) s1.gare.push({ tipo:'Batterie', dist:ev.dist, spec:ev.spec, sesso:ev.sesso||curSesso, cat:ev.cat, catRaw:ev.catRaw }) }
      } else {
        for (const p of parts0) { const ev = parseNumberedEvent(p); if (ev) curSessione.gare.push({ tipo:'Batterie', dist:ev.dist, spec:ev.spec, sesso:ev.sesso||curSesso, cat:ev.cat, catRaw:ev.catRaw }) }
      }
    }
  }
  return result
}

// ── FIN3: "Batterie e Serie lente" + header colonne date ────────────────────

function isFormatoFIN3(lines) {
  const hasBatterie = lines.some(l => /^batterie\s+e\s+serie\s+lente/i.test(l.split('\t')[0]))
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
    const firstCol = line.split('\t')[0]
    if (RE_BATTERIE.test(firstCol)) { inBatterie = true; continue }
    if (RE_FINALI.test(firstCol))   { inBatterie = false; continue }

    if (!headerDone) {
      const hits = [...line.matchAll(RE_DAY_COL)]
      if (hits.length >= 2) {
        headerDone = true
        hits.forEach((h, i) => giorni.push({
          giornata: String(i + 1), data: `${h[1]} ${h[2]}`,
          sessioni: [{ nome: 'Batterie', gare: [] }]
        }))
        continue
      }
    }

    if (inBatterie && giorni.length > 0 && /^\d+\s*[.]/.test(firstCol)) {
      // Usa le colonne TAB per assegnare eventi ai giorni
      const tabCols = line.split('\t')
      if (dayStarts.length === 0 && tabCols.length === giorni.length) {
        dayStarts = tabCols.map(c => parseInt((c.match(/^(\d+)/) || [])[1] || '0'))
      }
      tabCols.forEach((col, ci) => {
        for (const part of splitEventsLine(col)) {
          const ev = parseNumberedEvent(part)
          if (!ev) continue
          const evNum = parseInt((part.match(/^(\d+)/) || [])[1] || '0')
          let dayIdx = ci < giorni.length ? ci : 0
          if (dayStarts.length > 0) {
            dayIdx = 0
            for (let i = dayStarts.length - 1; i >= 0; i--)
              if (evNum >= dayStarts[i]) { dayIdx = i; break }
          }
          if (giorni[dayIdx]?.sessioni[0])
            giorni[dayIdx].sessioni[0].gare.push({ tipo:'Batterie', dist:ev.dist, spec:ev.spec, sesso:ev.sesso, cat:ev.cat, catRaw:ev.catRaw })
        }
      })
    }
  }
  return giorni.filter(g => g.sessioni[0].gare.length > 0)
}

// ── FIN4: "Programma - gare" + "12 Dicembre a.m." + eventi senza numero ─────
// Tabella multi-colonna con header "DD Mese a.m.|p.m." e righe "50 farfalla m"

function isFormatoFIN4(lines) {
  const hasProg = lines.some(l => /programma\s*[-–]\s*gare/i.test(l))
  const hasAmPm = lines.some(l => /\b(a\.m\.|p\.m\.)/i.test(l) && MESI_IT.some(m => l.toLowerCase().includes(m)))
  return hasProg && hasAmPm
}

function parseProgrammaFIN4(lines) {
  const result   = []
  let inProgramma = false
  let curSessions = []   // sessioni (oggetti {gare:[]}) per le colonne correnti

  const RE_PROGRAMMA = /programma\s*[-–]\s*gare/i
  const RE_DAY_SESS  = /(\d+)\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(a\.m\.|p\.m\.)/gi
  const RE_EVENT     = /^(\d+(?:x\d+)?)\s+(stile\s+libero|farfalla|dorso|rana|misti|misto)\s+(m|f)/i

  for (const line of lines) {
    if (RE_PROGRAMMA.test(line)) { inProgramma = true; continue }
    if (!inProgramma) continue

    // Header colonne: "12 Dicembre a.m. [TAB] 13 Dicembre a.m."
    const dayHits = [...line.matchAll(RE_DAY_SESS)]
    if (dayHits.length > 0) {
      curSessions = dayHits.map(h => {
        const data = `${h[1]} ${h[2]}`
        const nomeSess = /a\.m\./i.test(h[3]) ? 'Mattino' : 'Pomeriggio'
        let g = result.find(x => x.data === data)
        if (!g) {
          g = { giornata: String(result.length + 1), data, sessioni: [] }
          result.push(g)
        }
        return ensureSession(g, nomeSess)
      })
      continue
    }

    // Righe eventi (tab-separate per colonne)
    if (curSessions.length > 0) {
      const tabCols = line.split('\t')
      tabCols.forEach((col, ci) => {
        const ev = parseUnnumberedEvent(col.trim())
        if (!ev || ci >= curSessions.length) return
        curSessions[ci].gare.push({ tipo:'Batterie', dist:ev.dist, spec:ev.spec, sesso:ev.sesso, cat:null, catRaw:'' })
      })
    }
  }

  // Ordina giornate per data
  result.sort((a, b) => {
    const da = new Date(a.data.replace(/(\d+)\s+(\w+)\s+(\d+)/, '$3-$2-$1').replace(/\w+/, m => {
      const i = MESI_IT.indexOf(m.toLowerCase()); return i >= 0 ? String(i+1).padStart(2,'0') : '01'
    }))
    const db = new Date(b.data.replace(/(\d+)\s+(\w+)\s+(\d+)/, '$3-$2-$1').replace(/\w+/, m => {
      const i = MESI_IT.indexOf(m.toLowerCase()); return i >= 0 ? String(i+1).padStart(2,'0') : '01'
    }))
    return da - db
  })
  return result
}

// ── entry point (parser testuale) ────────────────────────────────────────────

// Post-processing: se alcuni giorni hanno gare con catRaw J/C/S e altri no,
// assegna 'JCS' o 'RAGAZZI' a tutte le gare prive di categoria esplicita.
function inferCatFromDays(giorni) {
  for (const g of giorni) {
    const hasJCS = g.sessioni.some(s => s.gare.some(ga => ga.catRaw && /J\/C/i.test(ga.catRaw)))
    const hasCatNull = g.sessioni.some(s => s.gare.some(ga => !ga.cat))
    if (!hasCatNull) continue
    const inferred = hasJCS ? 'JCS' : 'RAGAZZI'
    for (const s of g.sessioni)
      for (const ga of s.gare)
        if (!ga.cat) ga.cat = inferred
  }
  return giorni
}

export function parseProgramma(text) {
  const lines = text.split(/[\n\r]+/).map(l => normalizeLine(l)).filter(l => l.replace(/\t/g,'').trim())
  if (isFormatoFIN3(lines)) return parseProgrammaFIN3(lines)
  if (isFormatoFIN4(lines)) return parseProgrammaFIN4(lines)
  const fin1 = parseProgrammaFIN1(lines)
  if (fin1.length > 0) return inferCatFromDays(fin1)
  if (isFormatoFIN2(lines)) return parseProgrammaFIN2(lines)
  return []
}

// ── vision parser: usa Claude API per leggere il PDF come immagine ────────────
// Chiamato come fallback quando parseProgramma restituisce 0 giornate.
// Richiede VITE_ANTHROPIC_KEY nel .env.local

const VISION_PROMPT = `Sei un assistente per una società di nuoto italiana.
Questa immagine contiene il programma gare di una manifestazione di nuoto FIN.
Estrai tutte le gare e restituisci SOLO un array JSON (nessun testo prima o dopo).

Struttura richiesta:
[
  {
    "giornata": "1",
    "data": "12 Dicembre",
    "sessioni": [
      {
        "nome": "Mattino",
        "gare": [
          { "dist": 100, "spec": "DORSO", "sesso": "Female", "cat": null }
        ]
      }
    ]
  }
]

Regole:
- "dist" è un numero intero (es. 50, 100, 200, 400, 800, 1500) oppure stringa per staffette (es. "4x100")
- "spec" è uno di: STILE, DORSO, RANA, FARFALLA, MISTI
- "sesso" è "Female" o "Male"
- "cat" è null oppure: "RAGAZZI", "JUNIORES", "CADETTI", "SENIORES"
- "nome" sessione è "Mattino" o "Pomeriggio"
- Se non c'è distinzione di sessione usa "Mattino"
- Includi TUTTE le gare visibili nell'immagine
- Se ci sono più giornate crea un oggetto per ciascuna`

export async function parseProgrammaVision(pdfBase64) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_KEY
  if (!apiKey) throw new Error('VITE_ANTHROPIC_KEY non configurata in .env.local')

  const binary = atob(pdfBase64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pdf    = await pdfjsLib.getDocument({ data: bytes }).promise

  const images = []
  for (let p = 1; p <= Math.min(pdf.numPages, 4); p++) {
    const page     = await pdf.getPage(p)
    const viewport = page.getViewport({ scale: 2 })
    const canvas   = document.createElement('canvas')
    canvas.width   = viewport.width
    canvas.height  = viewport.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    images.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
  }

  const imageContent = images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: img }
  }))

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [...imageContent, { type: 'text', text: VISION_PROMPT }]
      }]
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error('Claude API error ' + res.status + ': ' + err)
  }

  const data = await res.json()
  const raw  = data.content?.[0]?.text || ''
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('Claude non ha restituito JSON valido')
  return JSON.parse(match[0])
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
      const dist = parseInt(m[1]), spec = normSpec(m[2])
      const nums = m[3].trim().split(/\s+/).map(Number)
      if (nums[0] !== undefined) limiti[dist+'|'+spec+'|Female'] = nums[0]
      if (nums[1] !== undefined) limiti[dist+'|'+spec+'|Male']   = nums[1]
      if (nums[2] !== undefined && nums[2] > (limiti[dist+'|'+spec+'|Male'] || 0))
        limiti[dist+'|'+spec+'|Male'] = nums[2]
    }
  }
  return limiti
}

// ── parse tabelle graduatoria limiti PER CATEGORIA ───────────────────────────
// Il "Campionato Italiano di Categoria" ha 4 tabelle separate (Ragazzi,
// Juniores, Cadetti, Seniores), ciascuna con numeri diversi per gara/sesso.
// La tabella Ragazzi maschi ha inoltre 2 sotto-colonne: "R14" (RAGAZZI 1° Anno,
// i più giovani) e "R1-R2" (RAGAZZI 2° Anno + RAGAZZI 3° Anno, stesso numero
// per entrambi). Chiave risultato: "dist|SPEC|Sesso|CATEGORIA".

const RAGAZZI_FEMMINE  = ['RAGAZZI 1° Anno', 'RAGAZZI 2° Anno']
const RAGAZZI_R14      = ['RAGAZZI 1° Anno']
const RAGAZZI_R1R2     = ['RAGAZZI 2° Anno', 'RAGAZZI 3° Anno']
const CAT_JUNIORES     = ['JUNIORES 1° Anno', 'JUNIORES 2° Anno']
const CAT_CADETTI      = ['CADETTI']
const CAT_SENIORES     = ['SENIORES']

export function parseGraduatoriaLimitiPerCategoria(text) {
  const limiti = {}

  function addEntry(dist, spec, sesso, categorie, val) {
    if (val === undefined || isNaN(val)) return
    for (const cat of categorie) limiti[`${dist}|${spec}|${sesso}|${cat}`] = val
  }

  const RE_ROW3 = /^(\d+)\s*m?\s+(stile\s+libero|dorso|rana|farfalla|misti)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i
  const RE_ROW2 = /^(\d+)\s*m?\s+(stile\s+libero|dorso|rana|farfalla|misti)\s+(\d+)\s+(\d+)\s*$/i

  // Trova tutte le intestazioni di categoria presenti, ordinate per posizione
  // nel testo: ogni sezione viene delimitata dall'inizio della successiva (non
  // da una finestra di caratteri fissa), per evitare che una sezione "sconfini"
  // nella tabella della categoria seguente quando sono ravvicinate nel PDF.
  const HEADINGS = [
    { key: 'ragazzi', re: /Categoria\W{0,3}Ragazzi/i },
    { key: 'junior',  re: /Categoria\W{0,3}Junior/i },
    { key: 'cadetti', re: /Categoria\W{0,3}Cadetti/i },
    { key: 'senior',  re: /Categoria\W{0,3}Senior/i },
  ]
  const found = HEADINGS
    .map(h => ({ ...h, idx: text.search(h.re) }))
    .filter(h => h.idx !== -1)
    .sort((a, b) => a.idx - b.idx)

  for (let i = 0; i < found.length; i++) {
    const { key, idx } = found[i]
    const idxAmm = text.indexOf('graduatorie in vasca', idx)
    if (idxAmm === -1) continue
    // Fine sezione = inizio della prossima intestazione trovata, o un margine
    // ampio se è l'ultima sezione del documento.
    const idxNext = (i + 1 < found.length) ? found[i + 1].idx : (idxAmm + 4000)
    const block   = text.slice(idxAmm, idxNext)
    const lines   = block.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)

    if (key === 'ragazzi') {
      for (const line of lines) {
        const m = RE_ROW3.exec(line)
        if (!m) continue
        const dist = parseInt(m[1], 10), spec = normSpec(m[2])
        addEntry(dist, spec, 'Female', RAGAZZI_FEMMINE, Number(m[3]))
        addEntry(dist, spec, 'Male',   RAGAZZI_R14,     Number(m[4]))
        addEntry(dist, spec, 'Male',   RAGAZZI_R1R2,    Number(m[5]))
      }
    } else {
      const cats = key === 'junior' ? CAT_JUNIORES : key === 'cadetti' ? CAT_CADETTI : CAT_SENIORES
      for (const line of lines) {
        const m = RE_ROW2.exec(line)
        if (!m) continue
        const dist = parseInt(m[1], 10), spec = normSpec(m[2])
        addEntry(dist, spec, 'Female', cats, Number(m[3]))
        addEntry(dist, spec, 'Male',   cats, Number(m[4]))
      }
    }
  }

  return limiti
}
