/**
 * parseProgramma.js
 * Estrae dal testo del PDF FIN:
 *  - programma: [{giornata, data, sessioni:[{nome, gare:[{tipo,dist,spec,sesso,cat}]}]}]
 *  - graduatoriaLimiti: { "50|STILE|F|RAGAZZI": 60, "50|STILE|M|RAGAZZI": 20, ... }
 */

import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

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
  let text = ''
  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p)
    const content = await page.getTextContent()
    text += content.items.map(i => i.str).join(' ') + '\n'
  }
  return text
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
