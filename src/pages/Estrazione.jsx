import { useState, useRef } from 'react'
import { db } from '../lib/firebase'
import { collection, doc, writeBatch, getDocs } from 'firebase/firestore'
import { extractPDF, rowsToCSV } from '../lib/pdfExtractor'

const COLS_SHOW = ['gara','sesso','data_gara','fase','posizione','atleta','societa','tempo_finale']

const TAG_COLORS = {
  head: 'text-white font-bold',
  ok:   'text-green-400',
  err:  'text-red-400',
  info: 'text-blue-300',
  warn: 'text-yellow-400',
}

export default function Estrazione() {
  const [files, setFiles]       = useState([])   // {name, buffer}
  const [societa, setSocieta]   = useState('Superba Nuoto ssd')
  const [split, setSplit]       = useState(50)
  const [stagione, setStagione] = useState('2025/2026')
  const [rows, setRows]         = useState([])
  const [log, setLog]           = useState([])
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState({cur:0,tot:0})
  const [saving, setSaving]     = useState(false)
  const [savedCount, setSaved]  = useState(null)
  const [filter, setFilter]     = useState({atleta:'',gara:''})
  const fileRef = useRef()
  const logEndRef = useRef()
  const cancelRef = useRef(false)

  function addLog(msg, tag='info') {
    setLog(p=>[...p,{msg,tag,id:Date.now()+Math.random()}])
    setTimeout(()=>logEndRef.current?.scrollIntoView({behavior:'smooth'}),30)
  }

  function onFilePick(e) {
    const picked=Array.from(e.target.files)
    Promise.all(picked.map(f=>f.arrayBuffer().then(buf=>({name:f.name,buffer:buf}))))
      .then(loaded=>{
        setFiles(loaded)
        setRows([]); setLog([]); setSaved(null)
        addLog(`${loaded.length} file caricati: ${loaded.map(f=>f.name).join(', ')}`, 'ok')
      })
    e.target.value=''
  }

  async function runExtraction() {
    if(!files.length) { addLog('Nessun PDF caricato.','warn'); return }
    cancelRef.current=false
    setRunning(true); setRows([]); setSaved(null)
    addLog(`─── Estrazione ${files.length} PDF ───`,'head')

    let allRows=[]
    for(let i=0;i<files.length;i++) {
      if(cancelRef.current) { addLog('Annullato.','warn'); break }
      const f=files[i]
      addLog(`[${i+1}/${files.length}] ${f.name}`,'head')
      try {
        const extracted=await extractPDF({
          arrayBuffer: f.buffer,
          filename: f.name,
          societaFilter: societa,
          splitBase: split,
          onLog: msg=>addLog('  '+msg,'info'),
          onProgress:(p,tot)=>setProgress({cur:p,tot}),
        })
        addLog(`  ✓ ${extracted.length} righe estratte`,'ok')
        allRows=[...allRows,...extracted]
      } catch(e) {
        addLog(`  ✗ Errore: ${e.message}`,'err')
      }
    }
    setRows(allRows)
    setProgress({cur:0,tot:0})
    setRunning(false)
    if(allRows.length) addLog(`Totale: ${allRows.length} righe`,'ok')
  }

  function downloadCSV() {
    if(!rows.length) return
    const csv=rowsToCSV(rows)
    const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'})
    const a=document.createElement('a')
    a.href=URL.createObjectURL(blob)
    a.download=`Superba_Risultati.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  async function saveToFirebase() {
    if(!rows.length) return
    setSaving(true)
    try {
      const colRef=collection(db,'risultati',stagione,'righe')
      const snap=await getDocs(colRef)
      let db1=writeBatch(db); let dc=0
      for(const d of snap.docs) {
        db1.delete(d.ref); dc++
        if(dc===400){await db1.commit();db1=writeBatch(db);dc=0}
      }
      if(dc>0) await db1.commit()
      let wb=writeBatch(db); let wc=0
      for(const row of rows) {
        wb.set(doc(colRef),{...row,_stagione:stagione}); wc++
        if(wc===400){await wb.commit();wb=writeBatch(db);wc=0}
      }
      if(wc>0) await wb.commit()
      setSaved(rows.length)
      addLog(`✓ ${rows.length} righe salvate su Firebase (${stagione})`,'ok')
    } catch(e) {
      addLog('Errore Firebase: '+e.message,'err')
    } finally { setSaving(false) }
  }

  const filtered=rows.filter(r=>
    (!filter.atleta||r.atleta?.toLowerCase().includes(filter.atleta.toLowerCase()))&&
    (!filter.gara||r.gara?.toLowerCase().includes(filter.gara.toLowerCase()))
  )

  const uniqueAtleti=[...new Set(rows.map(r=>r.atleta).filter(Boolean))].length
  const uniqueGare=[...new Set(rows.map(r=>r.gara).filter(Boolean))].length

  return (
    <div className="flex flex-col gap-3 h-full" style={{minHeight:0}}>

      {/* Impostazioni */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-aqua"/>
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-bold text-sb-aqua uppercase tracking-wider mb-3">⚙ Impostazioni Estrazione</p>
          <div className="flex flex-wrap gap-4 items-end">

            {/* Sorgente PDF */}
            <div className="flex-1 min-w-48">
              <label className="block text-xs text-sb-muted font-medium mb-1">Sorgente PDF</label>
              <div className="flex gap-2">
                <div className="flex-1 border border-sb-sep rounded-lg px-3 py-1.5 text-sm text-sb-muted bg-sb-bg truncate">
                  {files.length===0 ? 'Nessun file selezionato'
                    : files.length===1 ? files[0].name
                    : `${files.length} file PDF`}
                </div>
                <button onClick={()=>fileRef.current?.click()}
                  className="px-4 py-1.5 bg-sb-blue text-white text-sm font-medium rounded-lg hover:bg-blue-700 whitespace-nowrap">
                  📂 Sfoglia
                </button>
                <input ref={fileRef} type="file" accept=".pdf" multiple className="hidden" onChange={onFilePick}/>
              </div>
            </div>

            {/* Società */}
            <div className="min-w-52">
              <label className="block text-xs text-sb-muted font-medium mb-1">Società da estrarre</label>
              <input value={societa} onChange={e=>setSocieta(e.target.value)}
                className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"/>
            </div>

            {/* Split */}
            <div>
              <label className="block text-xs text-sb-muted font-medium mb-1">Split parziali</label>
              <div className="flex gap-1 bg-sb-bg rounded-lg p-1 border border-sb-sep">
                {[50,25].map(v=>(
                  <button key={v} onClick={()=>setSplit(v)}
                    className={`px-4 py-1 rounded text-sm font-medium transition-all
                      ${split===v?'bg-sb-blue text-white shadow':'text-sb-muted hover:text-sb-text'}`}>
                    {v}m
                  </button>
                ))}
              </div>
            </div>

            {/* Stagione */}
            <div>
              <label className="block text-xs text-sb-muted font-medium mb-1">Stagione (Firebase)</label>
              <select value={stagione} onChange={e=>setStagione(e.target.value)}
                className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
                {['2025/2026','2024/2025','2023/2024','2026/2027'].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Barra avanzamento + pulsanti */}
        <div className="px-5 pb-4 pt-2 border-t border-sb-sep mt-2">
          <div className="flex items-center gap-3">
            <button onClick={runExtraction} disabled={running||!files.length}
              className="px-6 py-2 bg-sb-green text-white rounded-lg text-sm font-bold hover:opacity-90 disabled:opacity-40 transition-opacity">
              {running ? '⏳ Estrazione in corso…' : '▶ Avvia Estrazione'}
            </button>
            {running && (
              <button onClick={()=>{cancelRef.current=true}}
                className="px-4 py-2 text-sm text-red-400 bg-sb-dark rounded-lg hover:bg-red-950 border border-red-900">
                ✕ Annulla
              </button>
            )}
            {rows.length>0 && !running && (
              <>
                <button onClick={downloadCSV}
                  className="px-4 py-2 bg-sb-panel border border-sb-sep text-sm font-medium text-sb-text rounded-lg hover:bg-sb-bg">
                  ⬇ Scarica CSV
                </button>
                <button onClick={saveToFirebase} disabled={saving}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
                  {saving ? '⏳ Salvataggio…' : '🔥 Salva su Firebase'}
                </button>
                {savedCount!==null && (
                  <span className="text-xs bg-green-100 text-green-700 font-semibold px-3 py-1 rounded-full">
                    ✓ {savedCount} righe salvate
                  </span>
                )}
              </>
            )}
            {progress.tot>0 && (
              <div className="flex-1 flex items-center gap-2 ml-2">
                <div className="flex-1 h-2 bg-sb-dark rounded-full overflow-hidden">
                  <div className="h-full bg-sb-blue rounded-full transition-all"
                    style={{width:`${Math.round(progress.cur/progress.tot*100)}%`}}/>
                </div>
                <span className="text-xs text-sb-muted w-20 text-right">
                  Pag. {progress.cur}/{progress.tot}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body: log + risultati */}
      <div className="flex gap-3 flex-1 min-h-0">

        {/* Log */}
        <div className="w-80 flex-shrink-0 bg-sb-panel border border-sb-sep rounded-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-sb-sep">
            <p className="text-xs font-bold text-sb-aqua uppercase tracking-wider">Log Estrazione</p>
            <button onClick={()=>setLog([])} className="text-xs text-sb-muted hover:text-white">Pulisci</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
            {log.length===0
              ? <p className="text-sb-muted">—</p>
              : log.map(e=>(
                  <p key={e.id} className={TAG_COLORS[e.tag]||'text-sb-muted'}>{e.msg}</p>
                ))
            }
            <div ref={logEndRef}/>
          </div>
        </div>

        {/* Risultati */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-2">
          {rows.length>0 && (
            <>
              {/* Mini stats + filtri */}
              <div className="bg-sb-panel border border-sb-sep rounded-xl px-4 py-2 flex flex-wrap items-center gap-4">
                <span className="text-sm font-bold text-sb-text">{rows.length} righe</span>
                <span className="text-xs text-sb-muted">{uniqueAtleti} atleti · {uniqueGare} gare</span>
                <div className="flex gap-2 ml-auto">
                  {[['atleta','Atleta'],['gara','Gara']].map(([k,lbl])=>(
                    <div key={k} className="flex items-center gap-1">
                      <span className="text-xs text-sb-muted">{lbl}:</span>
                      <input value={filter[k]} onChange={e=>setFilter(p=>({...p,[k]:e.target.value}))}
                        placeholder="Filtra…"
                        className="border border-sb-sep rounded px-2 py-1 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-sb-blue"/>
                    </div>
                  ))}
                  {(filter.atleta||filter.gara) && (
                    <button onClick={()=>setFilter({atleta:'',gara:''})}
                      className="text-xs text-sb-muted hover:text-sb-text px-1">✕</button>
                  )}
                  <span className="text-xs text-sb-muted">{filtered.length}/{rows.length}</span>
                </div>
              </div>

              {/* Tabella */}
              <div className="flex-1 bg-sb-panel border border-sb-sep rounded-2xl overflow-auto">
                <table className="w-full text-xs min-w-max">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-sb-sep bg-sb-bg">
                      {COLS_SHOW.map(c=>(
                        <th key={c} className="px-3 py-2 text-left font-semibold text-sb-muted uppercase tracking-wide whitespace-nowrap">
                          {c.replace(/_/g,' ')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0,500).map((r,i)=>(
                      <tr key={i} className={`border-b border-sb-sep/50 ${i%2===0?'bg-white':'bg-sb-panel'}`}>
                        <td className="px-3 py-1.5">
                          <span className="text-xs font-bold bg-sb-bg px-2 py-0.5 rounded text-sb-blue">{r.gara}</span>
                        </td>
                        <td className="px-3 py-1.5 text-sb-muted">{r.sesso}</td>
                        <td className="px-3 py-1.5 text-sb-muted">{r.data_gara}</td>
                        <td className="px-3 py-1.5 text-sb-muted">{r.fase}</td>
                        <td className="px-3 py-1.5 font-bold text-sb-blue">{r.posizione}</td>
                        <td className="px-3 py-1.5 font-medium text-sb-text whitespace-nowrap">{r.atleta}</td>
                        <td className="px-3 py-1.5 text-sb-muted whitespace-nowrap">{r.societa}</td>
                        <td className="px-3 py-1.5 font-mono font-semibold text-sb-text">{r.tempo_finale}</td>
                      </tr>
                    ))}
                    {filtered.length>500&&(
                      <tr><td colSpan={8} className="px-3 py-3 text-center text-xs text-sb-muted">
                        Mostrate 500/{filtered.length} — usa i filtri
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {rows.length===0 && !running && (
            <div className="flex-1 flex items-center justify-center bg-sb-panel border border-sb-sep rounded-2xl">
              <div className="text-center">
                <p className="text-4xl mb-3 opacity-20">⚙</p>
                <p className="text-sb-muted text-sm font-medium">Carica uno o più PDF e clicca "Avvia Estrazione"</p>
                <p className="text-sb-muted text-xs mt-1">PDF da genovagare.it, FIN, Criteria o Ligure</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
