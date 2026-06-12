/**
 * pdfExtractor.js
 * Port JavaScript della logica ficr_extractor_core.py (v30)
 * Estrae risultati gara dai PDF genovagare.it / FIN / Ligure
 */

import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`

// ─── Regex ─────────────────────────────────────────────────────────────────
const RE_TIME   = /\d{1,2}['']\d{2}[.,]\d{2}|\d{1,2}:\d{2}[.,]\d{2}|\d{1,2}[.,]\d{2}/g
const RE_DATE   = /\b(\d{2}\/\d{2}\/\d{4})\b/
const RE_POS    = /^(\d{1,3})\s+/
const RE_YEAR4  = /\b(19|20)\d{2}\b/
const RE_PUBL   = /\bPubblicata:\s*\d{2}\/\d{2}\/\d{4}\b/i
const RE_SKIP   = /\bProgramma\s+gare\b|\bClassifica\s+punti\s+FINA\b/i
const RE_DIST   = /\b(\d{2,4})\s*m\b|\b(\d{2,4})m\b/gi
const DIST_OK   = new Set([50,100,200,400,800,1500])

const STYLES = [
  ['SL', /\bStile\s+Libero\b/i],
  ['DO', /\bDorso\b/i],
  ['RA', /\bRana\b/i],
  ['FA', /\bFarfalla\b/i],
  ['MX', /\bMisti\b|\bMisto\b/i],
  ['SL', /\bSL\b/], ['DO', /\bDO\b/], ['RA', /\bRA\b/],
  ['FA', /\bFA\b/], ['MX', /\bMX\b/],
]
const PHASES = [
  ['FINALI',    /\bfinal[ie]\b/i],
  ['BATTERIE',  /\bbatterie\b|\beliminatorie\b/i],
  ['SERIE',     /\bserie\b/i],
]

// ─── Utility ────────────────────────────────────────────────────────────────
function norm(s) { return (s||'').replace(/\s+/g,' ').trim() }

function findDate(s)  { const m=RE_DATE.exec(s||''); return m?m[1]:'' }

function findDist(s) {
  const rx = /\b(\d{2,4})\s*m\b|\b(\d{2,4})m\b/gi
  let m
  while ((m=rx.exec(s||''))!==null) {
    const d=parseInt(m[1]||m[2]); if(DIST_OK.has(d)) return d
  }
  return null
}

function findStyle(s) {
  for(const [abbr,rx] of STYLES) { if(rx.test(s)) return abbr }
  return null
}

function detectPhase(line, cur) {
  for(const [ph,rx] of PHASES) { if(rx.test(line)) return ph }
  return cur
}

function sexFromLine(s) {
  const x=(s||'').toLowerCase()
  if(/\bfemm|\bf\b/.test(x)) return 'F'
  if(/\bmasch|\bm\b/.test(x)) return 'M'
  return ''
}

function sexFromFilename(name) {
  const m=/[_-]([A-Z]{2,3})([FM])(?:\.pdf)?$/i.exec(name||'')
  return m ? m[2].toUpperCase() : ''
}

function extractTimes(s) {
  return (s||'').match(RE_TIME) || []
}

function timeToSec(t) {
  if(!t) return Infinity
  const x=norm(t).replace(',','.')
  if(x.includes("'")) { const[m,r]=x.split("'"); return parseFloat(m)*60+parseFloat(r) }
  if(x.includes(':')) { const[m,r]=x.split(':'); return parseFloat(m)*60+parseFloat(r) }
  return parseFloat(x)
}

function sanitizeCumulative(times) {
  const out=[]; let prev=-Infinity
  for(const t of times) {
    const v=timeToSec(t)
    if(v>=prev-1e-9) { out.push(t); prev=v } else break
  }
  return out
}

// ─── Header parsing ─────────────────────────────────────────────────────────
function parseHeader(prev, line, next, lastDate) {
  for(const candidate of [line, prev+' '+line, line+' '+next]) {
    const txt=norm(candidate)
    if(!txt || !txt.includes('-')) continue
    const style=findStyle(txt); if(!style) continue
    const dist=findDist(txt); if(!dist) continue
    // Non dev'essere una riga atleta con tempi
    if(/^\s*\d{1,3}\s+/.test(txt) && extractTimes(txt).length>0) continue
    const catPart=txt.split('-').slice(1).join('-')
    return {
      gara: `${dist}${style}`,
      dist,
      sesso: sexFromLine(catPart),
      data_gara: findDate(txt)||lastDate,
    }
  }
  return null
}

// ─── Athlete line parsing ────────────────────────────────────────────────────
function parseAthleteLine(line, splitBase) {
  const ln=norm(line)
  const mPos=RE_POS.exec(ln)
  if(!mPos) return null
  if(/^(19|20)\d{2}\b/.test(ln)) return null

  const pos=mPos[1]
  const rest=ln.slice(mPos[0].length)
  const times=extractTimes(rest)
  if(!times.length) return null

  const firstTimeIdx=rest.search(RE_TIME)
  const beforeTime=firstTimeIdx>0 ? rest.slice(0,firstTimeIdx).trim() : ''

  // Cerca anno di nascita nel blocco pre-tempo
  const yearMatch=RE_YEAR4.exec(beforeTime)
  let nome='', societa=''
  if(yearMatch) {
    nome=norm(beforeTime.slice(0,yearMatch.index))
    societa=norm(beforeTime.slice(yearMatch.index+yearMatch[0].length))
  } else {
    // Senza anno: prendi le prime 2-3 parole come nome, il resto come società
    const toks=beforeTime.split(/\s+/).filter(Boolean)
    nome=toks.slice(0,3).join(' ')
    societa=toks.slice(3).join(' ')
  }

  // Clean nome
  nome=norm(nome.replace(/[^A-Za-zÀ-ÿ'\s-]/g,''))
  if(nome.split(/\s+/).length<1 || nome.length<2) return null

  const cumul=sanitizeCumulative(times)
  const tempoFinale=cumul[cumul.length-1]||''
  const parziali=cumul.slice(0,-1)

  return { pos, nome, societa, tempoFinale, parziali }
}

// ─── PDF → linee di testo ───────────────────────────────────────────────────
async function pdfToLines(arrayBuffer, onProgress) {
  const pdf=await pdfjsLib.getDocument({data:arrayBuffer}).promise
  const lines=[]
  for(let p=1;p<=pdf.numPages;p++) {
    if(onProgress) onProgress(p,pdf.numPages)
    const page=await pdf.getPage(p)
    const content=await page.getTextContent()
    const byRow={}
    for(const item of content.items) {
      const y=Math.round(item.transform[5])
      if(!byRow[y]) byRow[y]=[]
      byRow[y].push(item)
    }
    const ys=Object.keys(byRow).map(Number).sort((a,b)=>b-a)
    for(const y of ys) {
      const text=norm(byRow[y].sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str).join(' '))
      if(text) lines.push(text)
    }
  }
  return lines
}

// ─── Estrazione principale ───────────────────────────────────────────────────
export async function extractPDF({ arrayBuffer, filename, societaFilter='', splitBase=50, onLog, onProgress }) {
  const log = msg => { if(onLog) onLog(msg) }

  log(`Inizio estrazione: ${filename}`)
  const lines = await pdfToLines(arrayBuffer, (p,tot) => {
    log(`  Pagina ${p}/${tot}`)
    if(onProgress) onProgress(p,tot)
  })
  log(`Righe estratte dal PDF: ${lines.length}`)

  const rows=[]
  let current=null, lastDate='', phase=''
  const sexFile=sexFromFilename(filename)

  for(let i=0;i<lines.length;i++) {
    const line=lines[i], prev=lines[i-1]||'', next=lines[i+1]||''

    if(RE_PUBL.test(line)) { current=null; phase=''; continue }
    if(RE_SKIP.test(line))  { current=null; continue }

    phase=detectPhase(line,phase)
    const d=findDate(line); if(d) lastDate=d

    const hdr=parseHeader(prev,line,next,lastDate)
    if(hdr) {
      if(!hdr.sesso && sexFile) hdr.sesso=sexFile
      current=hdr
      log(`  Gara: ${hdr.gara} ${hdr.sesso} ${hdr.data_gara}`)
      continue
    }

    if(!current) continue

    const atl=parseAthleteLine(line, splitBase)
    if(!atl) continue

    // Filtro società
    if(societaFilter) {
      const filt=societaFilter.toLowerCase().replace(/\s+/g,'').slice(0,8)
      const soc=(atl.societa||'').toLowerCase().replace(/\s+/g,'')
      const nome=(atl.nome||'').toLowerCase().replace(/\s+/g,'')
      if(!soc.includes(filt) && !nome.includes(filt)) continue
    }

    const row={
      fonte_pdf: filename,
      gara: current.gara,
      sesso: current.sesso||sexFile,
      data_gara: current.data_gara||lastDate,
      fase: phase||'ELIMINATORIE',
      posizione: atl.pos,
      atleta: atl.nome,
      societa: atl.societa,
      tempo_finale: atl.tempoFinale,
    }
    atl.parziali.forEach((t,idx) => {
      row[`parziale_${(idx+1)*splitBase}m`]=t
    })
    rows.push(row)
  }

  log(`Estrazione completata: ${rows.length} righe`)
  return rows
}

// ─── Genera CSV ─────────────────────────────────────────────────────────────
export function rowsToCSV(rows, delimiter=';') {
  if(!rows.length) return ''
  const keys=Object.keys(rows[0])
  const escape=v=>`"${String(v||'').replace(/"/g,'""')}"`
  const header=keys.join(delimiter)
  const body=rows.map(r=>keys.map(k=>escape(r[k]??'')).join(delimiter)).join('\n')
  return header+'\n'+body
}
