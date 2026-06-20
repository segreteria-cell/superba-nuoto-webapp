/**
 * pdfExtractorFIN.js
 * Estrattore PDF per risultati FIN formato regionale:
 *   "Xa Gara DIST STILE UNICA (Es.A,Rag,Jun,Cad+Sen) Maschi|Femmine"
 *
 * Compatibile con: Trofeo Chianciano Terme, gare regionali FIN toscane, ecc.
 * Output: compatibile con pdfExtractor.js (Firebase Firestore risultati/{stagione}/righe)
 * Campi extra rispetto a FICR: categoria, anno, stato, punti, record, motivo_squalifica
 */

import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

// ── Stroke mapping ────────────────────────────────────────────────────────────
const STROKE_MAP = [
  ['Stile Libero', 'SL'],
  ['Dorso',        'DO'],
  ['Rana',         'RA'],
  ['Farfalla',     'FA'],
  ['Misti',        'MX'],
]

function strokeAbbr(strokeFull) {
  const s = (strokeFull || '').toLowerCase()
  for (const [key, abbr] of STROKE_MAP) {
    if (s.includes(key.toLowerCase())) return abbr
  }
  return (strokeFull || '??').slice(0, 2).toUpperCase()
}

// ── Regex ─────────────────────────────────────────────────────────────────────
// Header: "22a Gara 100 Dorso UNICA (Es.A,...) Maschi"
const RACE_RE       = /^(\d+)a\s+Gara\s+(\d+)\s+(.+?)\s+UNICA\s+\(([^)]+)\)\s+(Maschi|Femmine)\s*$/i
// Prefisso atleta: numero, SQ o NC
const ATHLETE_PFX   = /^(\d+|SQ|NC)\s+/
// Anchor categoria+anno (EA prima di S/C/J/R)
const CAT_YEAR      = /\b(EA|S|C|J|R)\s+(\d{4})\s+/
// Tempo: 1'00.97 oppure 59.22
const TIME_RE       = /\b(\d+'\d+\.\d+|\d{1,3}\.\d{2})\b/
// Riga split: inizia con NNm TEMPO (diff)
const SPLIT_LINE    = /^\d+m\s+\d/
// Motivi squalifica noti
const MOTIVO_RE     = /(Nuot\.Irreg\.Fraz\.|Arrivo\s+Irr\.Fraz\.|Falsa\s+Partenza|Virata\s+Irr\.\s*Fraz\.|Gara\s+non\s+terminata|Nuotata\s+Irregolare)/i
// Separatori e footer
const SEPARATOR     = /^[-─={]{10,}/
const FOOTER_DATE   = /^Pagina\s+\d+\s+di\s+\d+/

// ── Utility ───────────────────────────────────────────────────────────────────
function normSpace(s) {
  return (s || '').replace(/\xa0/g, ' ').replace(/[''`]/g, "'").replace(/\s+/g, ' ').trim()
}

function parseTimeSec(t) {
  if (!t) return null
  if (t.includes("'")) {
    const [m, s] = t.split("'")
    return Math.round((parseInt(m, 10) * 60 + parseFloat(s)) * 100) / 100
  }
  return Math.round(parseFloat(t) * 100) / 100
}

function extractNaz(text) {
  const m = /\s*\(([A-Z]{2,4})\)\s*/.exec(text)
  if (m) {
    const code = m[1]
    const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()
    return [cleaned, code]
  }
  return [text.trim(), null]
}

function splitCognomeNome(fullName) {
  const words = fullName.split(' ')
  let idx = words.length
  for (let i = 0; i < words.length; i++) {
    const clean = words[i].replace(/['''`\-]/g, '')
    if (clean && clean !== clean.toUpperCase()) { idx = i; break }
  }
  return {
    cognome: words.slice(0, idx).join(' '),
    nome:    words.slice(idx).join(' '),
  }
}

function parseSplits(text) {
  const splits = {}
  const re = /(\d+)m\s+(\d+'\d+\.\d+|\d+\.\d{2})\s*\(([^)]*)\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const dist = parseInt(m[1], 10)
    splits[`${dist}m`] = m[2]
    const diff = m[3].trim()
    if (diff) splits[`diff_${dist}m`] = diff
  }
  return splits
}

// ── Parser riga atleta ────────────────────────────────────────────────────────
function parseAthleteLine(line) {
  const s = normSpace(line)
  if (!s) return null

  const pm = ATHLETE_PFX.exec(s)
  if (!pm) return null

  const prefix = pm[1]
  const rest = s.slice(pm[0].length)

  const cm = CAT_YEAR.exec(rest)
  if (!cm) return null

  const fullName  = rest.slice(0, cm.index).trim()
  const cat       = cm[1]
  const year      = parseInt(cm[2], 10)
  const afterYear = rest.slice(cm.index + cm[0].length)

  let stato = null, club = '', naz = null
  let tempo = null, punti = null
  let qualif = false, isRecord = false, motivo = null

  if (prefix === 'SQ') {
    stato = 'SQ'
    const mm = MOTIVO_RE.exec(afterYear)
    let clubRaw = afterYear
    if (mm) {
      motivo  = mm[0].trim()
      clubRaw = afterYear.slice(0, mm.index).trim().replace(/\s+DO\s*$/, '').trim()
    } else {
      clubRaw = afterYear.replace(/\s+DO\s*$/, '').trim()
    }
    const tm = TIME_RE.exec(clubRaw)
    if (tm) { tempo = tm[1]; clubRaw = clubRaw.slice(0, tm.index).trim() }
    ;[club, naz] = extractNaz(clubRaw)

  } else if (prefix === 'NC') {
    stato = 'NC'
    const tm = TIME_RE.exec(afterYear)
    if (tm) {
      [club, naz] = extractNaz(afterYear.slice(0, tm.index))
      tempo = tm[1]
    } else {
      ;[club, naz] = extractNaz(afterYear)
    }

  } else {
    const tm = TIME_RE.exec(afterYear)
    if (!tm) return null
    ;[club, naz] = extractNaz(afterYear.slice(0, tm.index))
    tempo = tm[1]
    const afterTime = afterYear.slice(tm.index + tm[0].length).trim()
    const ptsM = /([0-9]+,[0-9]+)\s*(\*+)?/.exec(afterTime)
    if (ptsM) {
      punti    = parseFloat(ptsM[1].replace(',', '.'))
      const q  = ptsM[2] || ''
      qualif   = q.length > 0
      isRecord = q.length > 1
    } else {
      const qm = /(\*+)/.exec(afterTime)
      if (qm) { qualif = true; isRecord = qm[1].length > 1 }
    }
  }

  const { cognome, nome } = splitCognomeNome(fullName)

  return {
    prefix,
    posizione:         prefix.match(/^\d+$/) ? parseInt(prefix, 10) : null,
    stato,
    cognome_nome:      fullName,
    cognome,
    nome,
    categoria:         cat,
    anno:              year,
    societa:           club.trim(),
    nazionalita:       naz,
    fisdir:            club.includes('FISDIR'),
    tempo,
    tempo_secondi:     parseTimeSec(tempo),
    punti,
    qualificato:       qualif,
    record:            isRecord,
    motivo_squalifica: motivo,
  }
}

// ── PDF → righe di testo ──────────────────────────────────────────────────────
// Stesso algoritmo di pdfExtractor.js (raggruppamento per Y con tolleranza)
const Y_TOL = 0.6

async function pdfToLines(arrayBuffer, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const allLines = []

  for (let p = 1; p <= pdf.numPages; p++) {
    if (onProgress) onProgress(p, pdf.numPages)
    const page    = await pdf.getPage(p)
    const height  = page.view[3]
    const content = await page.getTextContent()

    const items = content.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({
        ...i,
        top: height - i.transform[5] - (i.height || Math.abs(i.transform[3])),
      }))
    if (!items.length) continue
    items.sort((a, b) => a.top - b.top)

    const rows = []
    let cur = null
    for (const item of items) {
      if (!cur || item.top - cur.avgTop > Y_TOL) {
        cur = { avgTop: item.top, sumTop: item.top, count: 1, items: [item] }
        rows.push(cur)
      } else {
        cur.items.push(item)
        cur.sumTop += item.top
        cur.count++
        cur.avgTop = cur.sumTop / cur.count
      }
    }

    for (const row of rows) {
      row.items.sort((a, b) => a.transform[4] - b.transform[4])
      const text = normSpace(row.items.map(i => i.str).join(' '))
      if (text) allLines.push(text)
    }
  }
  return allLines
}

// ── Rilevamento formato ───────────────────────────────────────────────────────
/**
 * Rileva se le righe del PDF sono in formato FIN ("Xa Gara ...") o FICR.
 * Chiama pdfToLines sulle prime 4 pagine per la detection.
 */
export async function detectFormat(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const maxPages = Math.min(4, pdf.numPages)
  const sample = []

  for (let p = 1; p <= maxPages; p++) {
    const page    = await pdf.getPage(p)
    const content = await page.getTextContent()
    const text    = content.items.map(i => i.str).join(' ')
    sample.push(text)
  }

  const joined = sample.join('\n')
  if (/\d+a\s+Gara\s+\d+/.test(joined)) return 'FIN'
  return 'FICR'
}

// ── Estrazione principale ─────────────────────────────────────────────────────
/**
 * Estrae i risultati da un PDF in formato FIN regionale.
 *
 * @param {ArrayBuffer} arrayBuffer   - contenuto del PDF
 * @param {string}      filename      - nome file (per metadata)
 * @param {string|null} filterClub    - filtra per società (es. 'SUPERBA NUOTO'), null = tutti
 * @param {Function}    onLog         - callback log(msg)
 * @param {Function}    onProgress    - callback progress(page, total)
 * @returns {Array}  righe compatibili con schema Firebase Estrazione
 */
export async function extractPDFFIN({
  arrayBuffer,
  filename,
  filterClub = 'SUPERBA NUOTO',
  onLog,
  onProgress,
}) {
  const log = msg => { if (onLog) onLog(msg) }
  log('▶ Estrazione FIN: ' + filename)

  const allLines = await pdfToLines(arrayBuffer, (p, tot) => {
    log(`  Pagina ${p}/${tot}`)
    if (onProgress) onProgress(p, tot)
  })
  log(`✓ Righe ricostruite: ${allLines.length}`)

  const rows      = []
  let currentRace = null
  let lastRow     = null   // ultima riga aggiunta a rows (per attributo split)
  let lastSeen    = null   // ultimo atleta visto (anche se filtrato, per non perdere split)

  // Metadati evento
  let dataEvento = ''
  const MESE = { Gennaio:1,Febbraio:2,Marzo:3,Aprile:4,Maggio:5,Giugno:6,
                 Luglio:7,Agosto:8,Settembre:9,Ottobre:10,Novembre:11,Dicembre:12 }

  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx]
    const s    = normSpace(line)
    if (!s) continue
    if (SEPARATOR.test(s)) continue
    if (s.includes('federnuoto.toscana.it')) continue
    if (FOOTER_DATE.test(s)) continue

    // Estrai data evento dalla prima occorrenza utile
    if (!dataEvento) {
      const dm = /\b(\d{1,2})\s+(Gennaio|Febbraio|Marzo|Aprile|Maggio|Giugno|Luglio|Agosto|Settembre|Ottobre|Novembre|Dicembre)\s+(\d{4})/.exec(s)
      if (dm) {
        const dd  = String(dm[1]).padStart(2, '0')
        const mm2 = String(MESE[dm[2]] || 1).padStart(2, '0')
        dataEvento = `${dd}/${mm2}/${dm[3]}`
      }
    }

    // ── Header gara ─────────────────────────────────────────────────────────
    const rm = RACE_RE.exec(s)
    if (rm) {
      const dist      = parseInt(rm[2], 10)
      const strokeFull = rm[3].trim()
      const abbr      = strokeAbbr(strokeFull)
      currentRace = {
        numero:    parseInt(rm[1], 10),
        distanza:  dist,
        stile:     strokeFull,
        gara:      `${dist}${abbr}`,      // es. "100DO"
        categorie: rm[4],
        sesso:     rm[5] === 'Maschi' ? 'M' : 'F',
      }
      lastRow  = null
      lastSeen = null
      log(`  Gara ${rm[1]}: ${dist} ${strokeFull} ${rm[5]}`)
      continue
    }

    if (!currentRace) continue

    // ── Riga split ───────────────────────────────────────────────────────────
    if (SPLIT_LINE.test(s)) {
      if (lastRow) {
        const sp = parseSplits(s)
        Object.assign(lastRow, sp)
      }
      continue
    }

    // ── Riga atleta ──────────────────────────────────────────────────────────
    const ath = parseAthleteLine(s)
    if (!ath) continue

    lastSeen = ath   // traccia sempre per gestire split dell'atleta successivo

    // Filtro club
    if (filterClub) {
      const clubUp = (ath.societa || '').toUpperCase()
      if (!clubUp.includes(filterClub.toUpperCase())) {
        lastRow = null  // split di questo atleta non vengono salvati
        continue
      }
    }

    const row = {
      // ── campi compatibili con schema FICR ──
      fonte_pdf:    filename,
      gara:         currentRace.gara,
      sesso:        currentRace.sesso,
      data_gara:    dataEvento,
      fase:         'FINALI',
      posizione:    ath.posizione,
      atleta:       ath.cognome_nome,
      societa:      'Superba Nuoto ssd',
      tempo_finale: ath.tempo,
      // ── campi extra FIN ──
      formato:      'FIN',
      categoria:    ath.categoria,
      anno:         ath.anno,
      cognome:      ath.cognome,
      nome:         ath.nome,
      nazionalita:  ath.nazionalita,
      stato:        ath.stato,
      punti:        ath.punti,
      record:       ath.record,
      qualificato:  ath.qualificato,
      motivo_squalifica: ath.motivo_squalifica,
      fisdir:       ath.fisdir,
      // (splits vengono aggiunte direttamente sul row man mano)
    }

    rows.push(row)
    lastRow = row
  }

  // Log per gara
  const byGara = {}
  rows.forEach(r => { byGara[r.gara] = (byGara[r.gara] || 0) + 1 })
  Object.keys(byGara).sort().forEach(g => log(`  ${g}: ${byGara[g]}`))
  log(`✓ Estratti: ${rows.length} risultati${filterClub ? ` (filtro: ${filterClub})` : ''}`)
  return rows
}
