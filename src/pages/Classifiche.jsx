import { useState, useMemo, useEffect, useCallback } from 'react'
import LZString from 'lz-string'
import * as XLSX from 'xlsx'

// Helper localStorage compresso (lz-string riduce ~70% su JSON grande)
const lsGet = (key, fallback = null) => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    // Prova decompressione, fallback a JSON puro (backward compat)
    const dec = LZString.decompress(raw)
    return JSON.parse(dec || raw)
  } catch { return fallback }
}
const lsSet = (key, value) => {
  try {
    localStorage.setItem(key, LZString.compress(JSON.stringify(value)))
  } catch (e) {
    console.warn('localStorage write failed:', e.message)
    try { localStorage.removeItem(key) } catch {}
  }
}

// URL backend: VITE_API_URL in produzione (Render), /api in dev (proxy Vite)
const API_BASE = import.meta.env.VITE_API_URL || ""

// Costanti (speculari a NuotoDownloader.py)

const STAGIONI = [
  "2025-2026","2024-2025","2023-2024","2022-2023","2021-2022","2020-2021",
  "2019-2020","2018-2019","2017-2018","2016-2017","2015-2016","2014-2015",
  "2013-2014","2012-2013","2011-2012","All Time",
]

const VIS_CATS_M = {
  R1: "RAGAZZI 1° Anno", R2: "RAGAZZI 2° Anno", R3: "RAGAZZI 3° Anno",
  J1: "JUNIORES 1° Anno", J2: "JUNIORES 2° Anno",
  CA: "CADETTI", SE: "SENIORES", AS: "ASSOLUTI",
}
const VIS_CATS_F = {
  R1: "RAGAZZI 1° Anno", R2: "RAGAZZI 2° Anno",
  J1: "JUNIORES 1° Anno", J2: "JUNIORES 2° Anno",
  CA: "CADETTI", SE: "SENIORES", AS: "ASSOLUTI",
}

const ALL_CATS_KEYS = ["R1","R2","R3","J1","J2","CA","SE","AS"]

const VIS_GARE = [
  "50 Stile Libero","100 Stile Libero","200 Stile Libero",
  "400 Stile Libero","800 Stile Libero","1500 Stile Libero",
  "50 Dorso","100 Dorso","200 Dorso",
  "50 Rana","100 Rana","200 Rana",
  "50 Farfalla","100 Farfalla","200 Farfalla",
  "200 Misti","400 Misti",
]

const DISTANZE = ["50","100","200","400","800","1500"]
const SPECIALITA = ["Stile Libero","Dorso","Rana","Farfalla","Misti"]
const VASCHE = ["25 m","50 m"]

const COLS = [
  { key:"Pos",     label:"Pos",      w:"w-10",  align:"center" },
  { key:"Atleta",  label:"Atleta",   w:"w-48",  align:"left"   },
  { key:"Anno",    label:"Anno",     w:"w-12",  align:"center" },
  { key:"Societa", label:"Società",  w:"w-52",  align:"left"   },
  { key:"_gara",   label:"Gara",     w:"w-40",  align:"left"   },
  { key:"Data",    label:"Data",     w:"w-22",  align:"center" },
  { key:"Tempo",   label:"Tempo",    w:"w-20",  align:"center" },
  { key:"PtFINA",  label:"Pt.FINA",  w:"w-16",  align:"center" },
  { key:"Vasca",   label:"Vasca",    w:"w-14",  align:"center" },
  { key:"Crono",   label:"Crono",    w:"w-14",  align:"center" },
]

const CACHE_KEY = "classifiche_allRows"

// Helpers

function garaDistanza(s) {
  const parts = s.trim().split(" ")
  return parts[0] && /^\d+$/.test(parts[0]) ? parts[0] : ""
}

function garaSpecialita(s) {
  const MAP = {
    Stile:"Stile Libero", Libero:"Stile Libero",
    Dorso:"Dorso", Rana:"Rana", Farfalla:"Farfalla", Misti:"Misti"
  }
  for (const tok of s.split(" ")) if (MAP[tok]) return MAP[tok]
  return ""
}

function isSuperba(r) {
  return (r.Societa || "").toLowerCase().includes("superba")
}

function catAbbr(cat) {
  return cat
    .replace("RAGAZZI", "RAG")
    .replace("JUNIORES", "JUN")
    .replace("CADETTI", "CAD")
    .replace("SENIORES", "SEN")
    .replace("ASSOLUTI", "ASS")
    .replace("° Anno", "°")
    .trim()
}

function posN(r) {
  const n = parseInt(String(r.Pos ?? "99").replace(".", ""), 10)
  return isNaN(n) ? 99 : n
}

function rowTag(pos, idx) {
  if (pos === 1) return "gold"
  if (pos === 2) return "silver"
  if (pos === 3) return "bronze"
  return idx % 2 === 0 ? "even" : "odd"
}

const TAG_CLS = {
  gold:   "bg-yellow-50 border-l-4 border-yellow-400 font-semibold",
  silver: "bg-gray-50   border-l-4 border-gray-400   font-semibold",
  bronze: "bg-orange-50 border-l-4 border-orange-400 font-semibold",
  even:   "bg-white",
  odd:    "bg-sb-bg/30",
}

// Componente principale

export default function Classifiche() {
  const [utente,   setUtente]   = useState(() => localStorage.getItem("aqt_utente")   || "")
  const [password, setPassword] = useState(() => localStorage.getItem("aqt_password") || "")
  const [stagione, setStagione] = useState(() => localStorage.getItem("aqt_stagione") || "2025-2026")
  const [topN,     setTopN]     = useState(() => parseInt(localStorage.getItem("aqt_topn") || "50", 10))

  const [allRows,    setAllRows]    = useState(() => lsGet(CACHE_KEY, []))
  const [lastUpdate, setLastUpdate] = useState(() => localStorage.getItem("aqt_lastupdate") || "")
  const [loading,    setLoading]    = useState(false)
  const [elapsed,    setElapsed]    = useState(0)
  const [error,      setError]      = useState("")
  const [progressMsg,setProgressMsg]= useState("")
  const [progressPct,setProgressPct]= useState(0)
  const [found,      setFound]      = useState(0)

  const [catSel,      setCatSel]      = useState(new Set())
  const [sesso,       setSesso]       = useState("")
  const [vascaF,      setVascaF]      = useState("")
  const [distanzaF,   setDistanzaF]   = useState("")
  const [specialitaF, setSpecialitaF] = useState("")
  const [soloSuperba, setSoloSuperba] = useState(false)
  const [sortCol,     setSortCol]     = useState("Pos")
  const [sortDir,     setSortDir]     = useState(1)   // 1=asc, -1=desc

  useEffect(() => {
    if (!loading) return
    setElapsed(0)
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [loading])

  useEffect(() => { localStorage.setItem("aqt_utente",   utente)   }, [utente])
  useEffect(() => { localStorage.setItem("aqt_password", password) }, [password])
  useEffect(() => { localStorage.setItem("aqt_stagione", stagione) }, [stagione])
  useEffect(() => { localStorage.setItem("aqt_topn",     String(topN)) }, [topN])

  const handleExport = () => {
    if (!filteredRows.length) return
    const exportCols = [
      { key:"Pos",     hdr:"Pos"      },
      { key:"Atleta",  hdr:"Atleta"   },
      { key:"Anno",    hdr:"Anno"     },
      { key:"Societa", hdr:"Società"  },
      { key:"_gara",   hdr:"Gara"     },
      { key:"_categoria", hdr:"Categoria" },
      { key:"_sesso",  hdr:"Sesso"    },
      { key:"Data",    hdr:"Data"     },
      { key:"Tempo",   hdr:"Tempo"    },
      { key:"PtFINA",  hdr:"Pt.FINA"  },
      { key:"Vasca",   hdr:"Vasca"    },
      { key:"Crono",   hdr:"Crono"    },
    ]
    const wsData = [
      exportCols.map(c => c.hdr),
      ...filteredRows.map(r => exportCols.map(c => r[c.key] ?? ""))
    ]
    const ws = XLSX.utils.aoa_to_sheet(wsData)
    // Larghezze colonne
    ws["!cols"] = [6,22,6,22,20,18,8,12,10,8,8,6].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, "Classifiche")
    const stagLabel = stagione.replace("-","_")
    XLSX.writeFile(wb, `Classifiche_AQT_${stagLabel}.xlsx`)
  }

  const handleClear = () => {
    try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem("aqt_lastupdate") } catch {}
    setAllRows([]); setLastUpdate(""); setError("")
  }

  const handleCerca = useCallback(async () => {
    if (!utente || !password) { setError("Inserisci credenziali AquaTime"); return }
    setLoading(true); setError(""); setProgressMsg(""); setProgressPct(0); setFound(0)
    // Accumula righe localmente — aggiornate progressivamente dallo stream
    let accumulated = []
    try {
      const res = await fetch(`${API_BASE}/api/aqt/cerca`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utente, password, stagione }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === "status") {
              setProgressMsg(msg.msg)
            } else if (msg.type === "progress") {
              setProgressPct(msg.pct)
              setFound(msg.found)
              setProgressMsg(`${msg.cat}  |  ${msg.gara}  |  ${msg.sesso}  |  ${msg.vasca}`)
              // Accumula righe ricevute in questo messaggio
              if (msg.new_rows?.length) {
                accumulated = accumulated.concat(msg.new_rows)
              }
            } else if (msg.type === "error") {
              throw new Error(msg.msg)
            } else if (msg.type === "done") {
              const now = new Date().toLocaleString("it-IT")
              setLastUpdate(now)
              localStorage.setItem("aqt_lastupdate", now)
              if (msg.errori?.length) setError(`Download con ${msg.errori.length} errori di rete`)
            }
          } catch (parseErr) {
            if (parseErr.message !== "Unexpected end of JSON input") throw parseErr
          }
        }
      }
    } catch (e) {
      setError(`Errore: ${e.message}`)
    } finally {
      // Aggiorna lo stato con tutto il raccolto (anche se "done" non è arrivato)
      if (accumulated.length > 0) {
        setAllRows(accumulated)
        const now = new Date().toLocaleString("it-IT")
        setLastUpdate(now)
        lsSet(CACHE_KEY, accumulated)
        try { localStorage.setItem("aqt_lastupdate", now) } catch {}
      }
      setLoading(false); setProgressMsg(""); setProgressPct(0)
    }
  }, [utente, password, stagione])

  const CATS_M_SET  = useMemo(() => new Set(Object.values(VIS_CATS_M)), [])
  const CATS_F_SET  = useMemo(() => new Set(Object.values(VIS_CATS_F)), [])
  const VIS_GARE_SET = useMemo(() => new Set(VIS_GARE), [])

  const visOk = useCallback(r => {
    const gara = r._gara || "", cat = (r._categoria || "").trim(), sx = r._sesso || ""
    if (!VIS_GARE_SET.has(gara)) return false
    if (sx === "Maschi"  && !CATS_M_SET.has(cat)) return false
    if (sx === "Femmine" && !CATS_F_SET.has(cat)) return false
    return true
  }, [CATS_M_SET, CATS_F_SET, VIS_GARE_SET])

  // Carica dati da Drive al mount (se localStorage vuoto)
  useEffect(() => {
    if (allRows.length > 0) return   // già in cache locale
    fetch(`${API_BASE}/api/aqt/dati`)
      .then(r => r.json())
      .then(data => {
        if (data.rows?.length > 0) {
          setAllRows(data.rows)
          const now = data.stagione ? `Stagione ${data.stagione} (da Drive)` : "Da Drive"
          setLastUpdate(prev => prev || now)
        }
      })
      .catch(() => {})   // silenzioso se Render è in sleep
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => -d)
    else { setSortCol(col); setSortDir(1) }
  }

  const filteredRows = useMemo(() => {
    const filtered = allRows.filter(r => {
      if (!visOk(r)) return false
      if (catSel.size > 0 && !catSel.has((r._categoria || "").trim())) return false
      if (sesso       && r._sesso !== sesso) return false
      if (vascaF      && !(r.Vasca || "").trim().startsWith(vascaF.split(" ")[0])) return false
      if (distanzaF   && garaDistanza(r._gara || "") !== distanzaF) return false
      if (specialitaF && garaSpecialita(r._gara || "") !== specialitaF) return false
        if (soloSuperba && !isSuperba(r)) return false
      if (posN(r) > topN) return false
      return true
    })
    return [...filtered].sort((a, b) => {
      let av = a[sortCol] ?? "", bv = b[sortCol] ?? ""
      if (sortCol === "Pos") { av = posN(a); bv = posN(b); return (av - bv) * sortDir }
      if (sortCol === "PtFINA" || sortCol === "Anno") {
        const an = parseFloat(String(av).replace(",",".")) || 0
        const bn = parseFloat(String(bv).replace(",",".")) || 0
        return (an - bn) * sortDir
      }
      return String(av).localeCompare(String(bv), "it") * sortDir
    })
  }, [allRows, catSel, sesso, vascaF, distanzaF, specialitaF, soloSuperba, topN, visOk, sortCol, sortDir])

  const stats = useMemo(() => ({
    tot: filteredRows.length,
    m:   filteredRows.filter(r => r._sesso === "Maschi").length,
    f:   filteredRows.filter(r => r._sesso === "Femmine").length,
    sup: filteredRows.filter(isSuperba).length,
  }), [filteredRows])

  const superbaStats = useMemo(() => {
    const supRows = filteredRows.filter(isSuperba)
    const CAT_ORDER = [
      "RAGAZZI 1° Anno","RAGAZZI 2° Anno","RAGAZZI 3° Anno",
      "JUNIORES 1° Anno","JUNIORES 2° Anno",
      "CADETTI","SENIORES","ASSOLUTI",
    ]
    const bycat = {}
    for (const r of supRows) {
      const cat = (r._categoria || "").trim()
      if (!bycat[cat]) bycat[cat] = { m: 0, f: 0 }
      if (r._sesso === "Maschi")  bycat[cat].m++
      else                        bycat[cat].f++
    }
    const pills = CAT_ORDER
      .filter(c => bycat[c])
      .map(c => ({ cat: c, abbr: catAbbr(c), m: bycat[c].m, f: bycat[c].f }))
    const distinct = new Set(supRows.map(r => r.Atleta)).size
    return { pills, total: supRows.length, distinct }
  }, [filteredRows])

  const toggleCat = cat => setCatSel(prev => {
    const next = new Set(prev)
    if (next.has(cat)) next.delete(cat); else next.add(cat)
    return next
  })

  const clearFilters = () => {
    setCatSel(new Set()); setSesso(""); setVascaF("")
    setDistanzaF(""); setSpecialitaF(""); setSoloSuperba(false)
  }

  const hasFilters = catSel.size > 0 || sesso || vascaF || distanzaF || specialitaF || soloSuperba

  return (
    <div className="flex flex-col gap-4 min-h-0">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-sb-text">Classifiche AquaTime</h1>
          {lastUpdate && (
            <p className="text-xs text-sb-muted mt-0.5">
              Ultimo aggiornamento: {lastUpdate}
              {allRows.length > 0 && ` - ${allRows.length.toLocaleString("it-IT")} atleti in cache`}
            </p>
          )}
        </div>
        {allRows.length > 0 && (
          <span className="text-xs text-sb-muted bg-sb-panel border border-sb-sep px-2 py-1 rounded-lg">
            {filteredRows.length.toLocaleString("it-IT")} / {allRows.length.toLocaleString("it-IT")} visualizzati
          </span>
        )}
      </div>

      {/* Credenziali */}
      <div className="bg-sb-panel border border-sb-sep rounded-xl p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Utente AquaTime">
            <input type="text" value={utente} onChange={e => setUtente(e.target.value)}
              placeholder="username" disabled={loading} className={INPUT} />
          </Field>
          <Field label="Password">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="..." disabled={loading} className={INPUT} />
          </Field>
          <Field label="Stagione">
            <select value={stagione} onChange={e => setStagione(e.target.value)}
              disabled={loading} className={INPUT}>
              {STAGIONI.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Top N">
            <div className="flex gap-1 mt-0.5">
              {[10,20,30,50].map(n => (
                <button key={n} onClick={() => setTopN(n)} disabled={loading}
                  className={`px-2.5 py-1 rounded text-xs font-bold transition-colors
                    ${topN === n ? "bg-sb-blue text-white" : "bg-sb-bg border border-sb-sep text-sb-muted hover:border-sb-blue"}`}>
                  {n}
                </button>
              ))}
            </div>
          </Field>
          <button onClick={handleCerca} disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold
                       bg-sb-blue text-white hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-sm">
            {loading
              ? <><Spinner /> Download... {elapsed}s</>
              : "Cerca su AQT"}
          </button>
          {filteredRows?.length > 0 && !loading && (
            <button onClick={handleExport}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold
                         bg-green-700 text-white hover:bg-green-800 transition-colors shadow-sm">
              📥 Excel
            </button>
          )}
          {(allRows.length > 0 || lastUpdate) && !loading && (
            <button onClick={handleClear} title="Svuota dati in cache"
              className="px-3 py-2 rounded-lg text-sm text-sb-muted border border-sb-sep
                         hover:bg-red-50 hover:text-red-600 hover:border-red-300 transition-colors">
              🗑
            </button>
          )}
        </div>
        {loading && (
          <div className="mt-3 space-y-2">
            <div className="w-full h-2 bg-sb-sep rounded-full overflow-hidden">
              <div
                className="h-full bg-sb-blue rounded-full transition-all duration-300"
                style={{ width: `${progressPct || 2}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-sb-muted">
              <span className="font-mono">{progressMsg || "Connessione ad AquaTime..."}</span>
              <span className="flex gap-3 flex-shrink-0 ml-2">
                {progressPct > 0 && <span className="font-semibold text-sb-blue">{progressPct}%</span>}
                {found > 0 && <span className="text-sb-green font-semibold">{found.toLocaleString("it-IT")} atleti</span>}
                <span className="tabular-nums">{elapsed}s</span>
              </span>
            </div>
          </div>
        )}
        {error && (
          <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>

      {/* Filtri */}
      {allRows.length > 0 && (
        <div className="bg-white border border-sb-sep rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-sb-muted uppercase tracking-wide">Filtri</span>
            {hasFilters && (
              <button onClick={clearFilters} className="text-xs text-sb-blue hover:underline">
                Reset filtri
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Sel label="Sesso" value={sesso} onChange={setSesso}
              opts={[["","Tutti"],["Maschi","Maschi"],["Femmine","Femmine"]]} />
            <Sel label="Vasca" value={vascaF} onChange={setVascaF}
              opts={[["","Tutte"],...VASCHE.map(v=>[v,v])]} />
            <Sel label="Distanza" value={distanzaF} onChange={setDistanzaF}
              opts={[["","Tutte"],...DISTANZE.map(d=>[d,d+"m"])]} />
            <Sel label="Specialita" value={specialitaF} onChange={setSpecialitaF}
              opts={[["","Tutte"],...SPECIALITA.map(s=>[s,s])]} />

          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-sb-muted font-medium mr-1">Categoria:</span>
            {ALL_CATS_KEYS.map(k => {
              const valM  = VIS_CATS_M[k]
              const valF  = VIS_CATS_F[k]
              const off   = sesso === "Femmine" && !valF
              const val   = sesso === "Femmine" ? valF : valM
              const on    = val ? catSel.has(val) : false
              return (
                <button key={k} disabled={off} onClick={() => val && toggleCat(val)}
                  className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-colors
                    ${off ? "opacity-25 cursor-not-allowed border-sb-sep text-sb-muted"
                          : on  ? "bg-sb-blue text-white border-sb-blue"
                               : "bg-white text-sb-muted border-sb-sep hover:border-sb-blue hover:text-sb-blue"}`}>
                  {k}
                </button>
              )
            })}
            <label className="ml-3 flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={soloSuperba} onChange={e => setSoloSuperba(e.target.checked)}
                className="accent-sb-blue" />
              <span className="text-xs text-sb-muted font-medium">Solo Superba Nuoto</span>
            </label>
          </div>
        </div>
      )}

      {/* Stats */}
      {allRows.length > 0 && (
        <div className="flex gap-3">
          {[["Totale",stats.tot,"bg-sb-blue"],["Maschi",stats.m,"bg-blue-500"],
            ["Femmine",stats.f,"bg-pink-500"],["Superba",stats.sup,"bg-sb-green"]].map(([l,v,c])=>(
            <div key={l} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${c} text-white shadow-sm`}>
              <span className="text-xs opacity-80">{l}</span>
              <span className="text-sm font-bold tabular-nums">{v.toLocaleString("it-IT")}</span>
            </div>
          ))}
        </div>
      )}

      {/* Superba per categoria */}
      {superbaStats.pills.length > 0 && (
        <div className="bg-white border border-sb-sep rounded-xl px-4 py-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-bold text-sb-blue whitespace-nowrap">
              🏊 Superba per categoria
            </span>
            <span className="text-xs text-sb-muted">
              ({superbaStats.total} gare · {superbaStats.distinct} atleti distinti)
            </span>
            <div className="flex flex-wrap gap-2 mt-0.5">
              {superbaStats.pills.map(p => (
                <div key={p.cat}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-sb-sep bg-sb-bg text-xs">
                  <span className="font-bold text-sb-muted">{p.abbr}</span>
                  {p.m > 0 && (
                    <span className="flex items-center gap-0.5 text-blue-600 font-semibold">
                      <span className="text-[11px]">♂</span>{p.m}
                    </span>
                  )}
                  {p.f > 0 && (
                    <span className="flex items-center gap-0.5 text-pink-600 font-semibold">
                      <span className="text-[11px]">♀</span>{p.f}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tabella */}
      {filteredRows.length > 0 ? (
        <div className="bg-white border border-sb-sep rounded-xl overflow-hidden flex-1">
          <div className="overflow-auto max-h-[calc(100vh-420px)]">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-sb-dark text-white">
                  {COLS.map(c => (
                    <th key={c.key} onClick={() => handleSort(c.key)}
                      className={`px-3 py-2 font-semibold tracking-wide cursor-pointer select-none
                        hover:bg-sb-blue/80 transition-colors ${c.w}
                        ${c.align === "center" ? "text-center" : "text-left"}`}>
                      <span className={`flex items-center gap-1 ${c.align === "center" ? "justify-center" : ""}`}>
                        {c.label}
                        {sortCol === c.key && (
                          <span className="text-[10px] opacity-80">{sortDir === 1 ? "▲" : "▼"}</span>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, i) => {
                  const pos = posN(r)
                  const tag = rowTag(pos, i)
                  return (
                    <tr key={i} className={`${TAG_CLS[tag]} hover:opacity-80 transition-opacity`}>
                      {COLS.map(c => (
                        <td key={c.key} className={`px-3 py-1.5 border-b border-sb-sep/40 ${c.align === "center" ? "text-center" : ""}`}>
                          {c.key === "Pos" ? (
                            <span className="flex items-center gap-1">
                              {pos===1?"🥇":pos===2?"🥈":pos===3?"🥉":""}
                              {r.Pos}
                            </span>
                          ) : c.key === "Tempo" ? (
                            <span className="font-mono font-semibold text-sb-text">{r[c.key]}</span>
                          ) : c.key === "Societa" ? (
                            <span className={`whitespace-nowrap ${isSuperba(r) ? "font-semibold text-sb-green" : ""}`}>
                              {r[c.key]}
                            </span>
                          ) : (
                            r[c.key] ?? ""
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 bg-sb-bg/50 border-t border-sb-sep text-xs text-sb-muted">
            {filteredRows.length.toLocaleString("it-IT")} atleti
            {hasFilters && ` (su ${allRows.length.toLocaleString("it-IT")} totali)`}
          </div>
        </div>
      ) : allRows.length > 0 ? (
        <div className="flex items-center justify-center h-32 text-sb-muted text-sm">
          Nessun risultato con i filtri selezionati
        </div>
      ) : !loading ? (
        <div className="flex items-center justify-center h-48 rounded-xl border-2 border-dashed border-sb-sep">
          <div className="text-center">
            <p className="text-3xl mb-2 opacity-30">📊</p>
            <p className="text-sb-muted font-medium">Nessun dato</p>
            <p className="text-sb-muted text-sm mt-1">
              Inserisci credenziali e clicca Cerca su AQT
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Sub-componenti

const INPUT = "border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue bg-white disabled:opacity-50"

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-sb-muted">{label}</span>
      {children}
    </label>
  )
}

function Sel({ label, value, onChange, opts }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-sb-muted uppercase tracking-wide">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="border border-sb-sep rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
  )
}
