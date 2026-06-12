import { useState, useMemo, useEffect } from 'react'
import { db } from '../lib/firebase'
import {
  collection, doc, getDocs, setDoc, addDoc,
  deleteDoc, onSnapshot
} from 'firebase/firestore'

const SUBTABS = ['Calcolo punteggi', 'Atleti & FINA', 'Indicatori']

function iicFor(a) {
  const fp = parseFloat(a.fina_prev || 0)
  const fc = parseFloat(a.fina_curr || 0)
  if (!fp || !fc) return null
  const atteso = { Ragazzi: 10, Juniores: 7, Cadetti: 4, Seniores: 2, Assoluti: 1 }[a.categoria] ?? 10
  return ((fc - fp) / fp * 100) / atteso
}

function calcAll({ atleti, qualificati, atlInizio, abbandoni, nuoviIngressi, valDs }) {
  const iics = atleti.map(iicFor).filter(x => x !== null)
  const nVal = iics.length
  const medIic = nVal ? iics.reduce((a, b) => a + b, 0) / nVal : 0
  const diffus = nVal ? iics.filter(x => x >= 1).length / nVal * 100 : 0
  const pCmc = medIic >= 1.2 ? 20 : medIic >= 1.0 ? 15 : medIic >= 0.8 ? 10 : medIic >= 0.6 ? 5 : 0
  const pDif = diffus >= 70 ? 20 : diffus >= 55 ? 15 : diffus >= 40 ? 10 : diffus >= 25 ? 5 : 0
  const pts1 = pCmc + pDif
  const pts2 = qualificati >= 5 ? 20 : qualificati === 4 ? 16 : qualificati === 3 ? 12 : qualificati === 2 ? 8 : qualificati === 1 ? 4 : 0
  const tassoAbb = atlInizio > 0 ? abbandoni / atlInizio * 100 : 0
  const pts3 = tassoAbb <= 5 ? 25 : tassoAbb <= 10 ? 20 : tassoAbb <= 15 ? 15 : tassoAbb <= 20 ? 10 : tassoAbb <= 25 ? 5 : 0
  const percNuovi = atlInizio > 0 ? nuoviIngressi / atlInizio * 100 : 0
  const pts4 = percNuovi >= 20 ? 10 : percNuovi >= 15 ? 8 : percNuovi >= 10 ? 6 : percNuovi >= 5 ? 4 : percNuovi >= 2 ? 2 : 0
  const pts5 = { Ottima: 5, Buona: 3, Sufficiente: 1, Insufficiente: 0 }[valDs] ?? 0
  const totApr = pts1 + pts2 + pts5
  const totSet = pts1 + pts2 + pts3 + pts4 + pts5
  const eurApr = totApr >= 80 ? 1200 : totApr >= 65 ? 1000 : totApr >= 50 ? 800 : totApr >= 35 ? 600 : totApr >= 20 ? 400 : 0
  const eurSet = totSet >= 95 ? 1500 : totSet >= 80 ? 1200 : totSet >= 65 ? 1000 : totSet >= 50 ? 800 : totSet >= 35 ? 600 : totSet >= 20 ? 400 : 0
  return { pts1, pCmc, pDif, pts2, pts3, pts4, pts5, medIic, diffus, nVal, tassoAbb, percNuovi, totApr, totSet, eurApr, eurSet }
}

function ScoreCard({ title, accent, bg, rows, det, totale, compenso }) {
  return (
    <div className="flex-1 rounded-xl overflow-hidden border-2 shadow-sm" style={{ borderColor: accent }}>
      <div className="px-4 py-3" style={{ backgroundColor: accent }}>
        <span className="text-white font-bold text-sm">{title}</span>
      </div>
      <div style={{ backgroundColor: bg }} className="px-4 py-2 space-y-1">
        {rows.map(({ label, value, maxP, bold }) => (
          <div key={label} className={`flex justify-between items-center py-0.5 ${bold ? 'mt-2' : 'pl-4'}`}>
            <span className="text-sm" style={{ color: bold ? accent : '#3a6480', fontWeight: bold ? 600 : 400 }}>{label}</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: accent }}>{value} / {maxP}</span>
          </div>
        ))}
        {det && <p className="text-xs text-sb-muted italic pt-1 pb-2">{det}</p>}
      </div>
      <div style={{ backgroundColor: bg }} className="px-4 pb-2">
        <div className="border-t pt-2 flex justify-between items-center" style={{ borderColor: accent }}>
          <span className="font-bold text-sm" style={{ color: accent }}>TOTALE</span>
          <span className="text-2xl font-bold" style={{ color: accent }}>{totale}</span>
        </div>
      </div>
      <div className="px-4 py-3 flex justify-between items-center" style={{ backgroundColor: accent }}>
        <span className="text-white font-bold text-sm">COMPENSO</span>
        <span className="text-white font-bold text-xl">EUR {compenso.toLocaleString('it-IT')}</span>
      </div>
    </div>
  )
}

function AtletaDialog({ atleta, onSave, onClose }) {
  const [form, setForm] = useState(atleta || { nome: '', categoria: 'Ragazzi', anno_nascita: '', fina_prev: '', fina_curr: '' })
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h3 className="font-bold text-sb-text text-lg mb-4">{atleta ? 'Modifica atleta' : 'Nuovo atleta'}</h3>
        <div className="space-y-3">
          {[['Nome', 'nome', 'text'], ['Anno di nascita', 'anno_nascita', 'number']].map(([lbl, k, t]) => (
            <label key={k} className="block">
              <span className="text-xs text-sb-muted font-medium">{lbl}</span>
              <input type={t} value={form[k]} onChange={f(k)}
                className="mt-1 block w-full border border-sb-sep rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
            </label>
          ))}
          <label className="block">
            <span className="text-xs text-sb-muted font-medium">Categoria</span>
            <select value={form.categoria} onChange={f('categoria')}
              className="mt-1 block w-full border border-sb-sep rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue">
              {['Ragazzi','Juniores','Cadetti','Seniores','Assoluti'].map(c => <option key={c}>{c}</option>)}
            </select>
          </label>
          {[['FINA precedente', 'fina_prev'], ['FINA attuale', 'fina_curr']].map(([lbl, k]) => (
            <label key={k} className="block">
              <span className="text-xs text-sb-muted font-medium">{lbl}</span>
              <input type="number" step="0.01" value={form[k]} onChange={f(k)}
                className="mt-1 block w-full border border-sb-sep rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
            </label>
          ))}
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-sb-muted border border-sb-sep hover:bg-sb-bg">Annulla</button>
          <button onClick={() => onSave(form)} className="px-4 py-2 rounded-lg text-sm bg-sb-blue text-white font-medium hover:bg-blue-700">Salva</button>
        </div>
      </div>
    </div>
  )
}

export default function Incentivante() {
  const [allenatori, setAllenatori] = useState([])
  const [allIdx, setAllIdx]         = useState(0)
  const [stagione, setStagione]     = useState('2026/2027')
  const [subtab, setSubtab]         = useState(0)
  const [atleti, setAtleti]         = useState([])
  const [qualificati, setQualif]    = useState(0)
  const [atlInizio, setAtlInizio]   = useState(0)
  const [abbandoni, setAbbandoni]   = useState(0)
  const [nuoviIngressi, setNuovi]   = useState(0)
  const [valDs, setValDs]           = useState('Buona')
  const [dialogAtleta, setDialog]   = useState(null)
  const [editId, setEditId]         = useState(null)
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(false)

  // Carica allenatori da Firestore in tempo reale
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'allenatori'), snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (docs.length === 0) {
        // Crea allenatore default
        addDoc(collection(db, 'allenatori'), {
          nome: 'Allenatore 1', sezione: 'NUOTATORI GENOVESI',
          compenso_base: 1500, stagione: '2026/2027',
          qualificati: 0, atlInizio: 0, abbandoni: 0,
          nuoviIngressi: 0, valDs: 'Buona'
        })
      } else {
        setAllenatori(docs)
        const a = docs[allIdx] || docs[0]
        setQualif(a.qualificati || 0)
        setAtlInizio(a.atlInizio || 0)
        setAbbandoni(a.abbandoni || 0)
        setNuovi(a.nuoviIngressi || 0)
        setValDs(a.valDs || 'Buona')
        setStagione(a.stagione || '2026/2027')
      }
      setLoading(false)
    })
    return unsub
  }, [])

  // Carica atleti dell'allenatore selezionato
  useEffect(() => {
    if (!allenatori.length) return
    const all = allenatori[allIdx]
    if (!all) return
    const unsub = onSnapshot(collection(db, 'allenatori', all.id, 'atleti'), snap => {
      setAtleti(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [allenatori, allIdx])

  const all = allenatori[allIdx]
  const r = useMemo(() => calcAll({ atleti, qualificati, atlInizio, abbandoni, nuoviIngressi, valDs }),
    [atleti, qualificati, atlInizio, abbandoni, nuoviIngressi, valDs])

  async function saveIndicatori() {
    if (!all) return
    setSaving(true)
    await setDoc(doc(db, 'allenatori', all.id), {
      ...all, qualificati, atlInizio, abbandoni,
      nuoviIngressi, valDs, stagione
    })
    setSaving(false)
  }

  async function saveAtleta(form) {
    if (!all) return
    const { id, ...data } = form
    if (editId) {
      await setDoc(doc(db, 'allenatori', all.id, 'atleti', editId), data)
    } else {
      await addDoc(collection(db, 'allenatori', all.id, 'atleti'), data)
    }
    setDialog(null); setEditId(null)
  }

  async function deleteAtleta(atletaId) {
    if (!all) return
    await deleteDoc(doc(db, 'allenatori', all.id, 'atleti', atletaId))
  }

  const aprRows = [
    { label: 'Ind.1 — Miglioramento tecnico', value: r.pts1, maxP: 40, bold: true },
    { label: 'Crescita media corretta',        value: r.pCmc, maxP: 20, bold: false },
    { label: 'Diffusione miglioramento',       value: r.pDif, maxP: 20, bold: false },
    { label: 'Ind.2 — Qualificati Assoluti',   value: r.pts2, maxP: 20, bold: true },
    { label: 'Ind.5 — Valutazione DS',         value: r.pts5, maxP:  5, bold: true },
  ]
  const setRows = [
    ...aprRows.slice(0, 4),
    { label: 'Ind.3 — Fidelizzazione',   value: r.pts3, maxP: 25, bold: true },
    { label: 'Ind.4 — Crescita numerica', value: r.pts4, maxP: 10, bold: true },
    { label: 'Ind.5 — Valutazione DS',    value: r.pts5, maxP:  5, bold: true },
  ]

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-sb-muted">Caricamento da Firebase...</div>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-aqua" />
        <div className="flex flex-wrap items-end gap-6 px-5 pt-4 pb-3">
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Allenatore</label>
            <select value={allIdx} onChange={e => setAllIdx(+e.target.value)}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
              {allenatori.map((a, i) => <option key={a.id} value={i}>{a.nome}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs text-sb-muted font-medium mb-1">Sezione</p>
            <p className="text-sm font-bold text-sb-text">{all?.sezione || '—'}</p>
          </div>
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Stagione</label>
            <input value={stagione} onChange={e => setStagione(e.target.value)}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-sb-blue" />
          </div>
          <div className="ml-auto text-right">
            <p className="text-xs text-sb-muted font-medium">Compenso base/mese</p>
            <p className="text-xl font-bold text-sb-green">EUR {(all?.compenso_base || 0).toLocaleString('it-IT')}</p>
          </div>
        </div>
        <div className="flex gap-8 px-5 pb-4 border-t border-sb-sep pt-3">
          <div>
            <p className="text-xs text-sb-muted font-medium">Atleti valutabili</p>
            <p className="text-2xl font-bold text-sb-text">{r.nVal} / {atleti.length}</p>
          </div>
          <div>
            <p className="text-xs text-sb-muted font-medium">Media IIC</p>
            <p className="text-2xl font-bold text-sb-green">{r.nVal ? r.medIic.toFixed(3) : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-sb-muted font-medium">Qualificati assoluti</p>
            <p className="text-2xl font-bold text-sb-text">{qualificati}</p>
          </div>
        </div>
      </div>

      {/* Sub-tab switcher */}
      <div className="flex gap-1 bg-sb-panel rounded-xl p-1 border border-sb-sep w-fit shadow-sm">
        {SUBTABS.map((t, i) => (
          <button key={t} onClick={() => setSubtab(i)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all
              ${subtab === i ? 'bg-sb-blue text-white shadow-sm' : 'text-sb-muted hover:text-sb-text'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* SOTTO-TAB 0 */}
      {subtab === 0 && (
        <div className="space-y-4">
          <div className="flex gap-4">
            <ScoreCard title="Valutazione intermedia — 30 aprile" accent="#2E7D32" bg="#f0faf4"
              rows={aprRows} det={r.nVal ? `Media IIC: ${r.medIic.toFixed(3)} | Diffusione: ${r.diffus.toFixed(1)}%` : ''}
              totale={r.totApr} compenso={r.eurApr} />
            <ScoreCard title="Valutazione finale — 30 settembre" accent="#1565C0" bg="#f0f6ff"
              rows={setRows} det={r.nVal ? `Media IIC: ${r.medIic.toFixed(3)} | Abbandoni: ${r.tassoAbb.toFixed(1)}%` : ''}
              totale={r.totSet} compenso={r.eurSet} />
          </div>
          <div className="flex gap-3">
            <button onClick={saveIndicatori} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-sb-blue text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? '⏳ Salvataggio...' : '💾 Salva su Firebase'}
            </button>
          </div>
        </div>
      )}

      {/* SOTTO-TAB 1 */}
      {subtab === 1 && (
        <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-sb-sep">
            <p className="font-semibold text-sb-text text-sm">{atleti.length} atleti — {r.nVal} valutabili</p>
            <button onClick={() => { setDialog('new'); setEditId(null) }}
              className="px-3 py-1.5 bg-sb-blue text-white rounded-lg text-sm font-medium hover:bg-blue-700">
              + Aggiungi
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sb-sep bg-sb-bg">
                  {['Atleta','Categoria','Anno','FINA prec.','FINA att.','Miglio%','IIC','OK',''].map(h => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-sb-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {atleti.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-sb-muted text-sm">Nessun atleta. Clicca + Aggiungi</td></tr>
                )}
                {atleti.map((a, i) => {
                  const iic = iicFor(a)
                  const fp = parseFloat(a.fina_prev || 0)
                  const fc = parseFloat(a.fina_curr || 0)
                  const mig = fp > 0 ? ((fc - fp) / fp * 100).toFixed(1) + '%' : '—'
                  return (
                    <tr key={a.id} className={`border-b border-sb-sep/50 ${i % 2 === 0 ? 'bg-white' : 'bg-sb-panel'}`}>
                      <td className="px-4 py-2 font-medium text-sb-text">{a.nome}</td>
                      <td className="px-4 py-2 text-sb-muted">{a.categoria}</td>
                      <td className="px-4 py-2 text-sb-muted">{a.anno_nascita}</td>
                      <td className="px-4 py-2 tabular-nums">{a.fina_prev || '—'}</td>
                      <td className="px-4 py-2 tabular-nums">{a.fina_curr || '—'}</td>
                      <td className="px-4 py-2 tabular-nums">{mig}</td>
                      <td className="px-4 py-2 tabular-nums font-semibold"
                          style={{ color: iic !== null ? (iic >= 1 ? '#06845a' : '#c0392b') : undefined }}>
                        {iic !== null ? iic.toFixed(2) : '—'}
                      </td>
                      <td className="px-4 py-2">
                        {iic !== null && (
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${iic >= 1 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                            {iic >= 1 ? 'SI' : 'no'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 flex gap-2">
                        <button onClick={() => { setDialog(a); setEditId(a.id) }} className="text-xs text-sb-blue hover:underline">Modifica</button>
                        <button onClick={() => deleteAtleta(a.id)} className="text-xs text-red-500 hover:underline">Elimina</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SOTTO-TAB 2 */}
      {subtab === 2 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { title: 'Ind.3 — Fidelizzazione e Retention', desc: 'Solo valutazione finale (30 settembre).',
              fields: [
                { label: 'Atleti al 1 ottobre (inizio stagione)', val: atlInizio, set: setAtlInizio },
                { label: 'N. abbandoni definitivi / trasferiti', val: abbandoni, set: setAbbandoni },
              ]},
            { title: 'Ind.4 — Crescita Numerica', desc: 'Solo valutazione finale.',
              fields: [{ label: 'N. nuovi ingressi (da fuori progetto)', val: nuoviIngressi, set: setNuovi }]},
            { title: 'Ind.2 — Campionati Italiani Assoluti', desc: 'Atleti qualificati alla Tabella A FIN.',
              fields: [{ label: 'N. qualificati Tabella A Assoluti', val: qualificati, set: setQualif }]},
            { title: 'Ind.5 — Valutazione Direzione Sportiva', desc: 'Valutazione complessiva della DS.', fields: [] },
          ].map(({ title, desc, fields }) => (
            <div key={title} className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm p-5">
              <h3 className="font-bold text-sb-text text-sm mb-1">{title}</h3>
              <p className="text-xs text-sb-muted mb-4 italic">{desc}</p>
              <div className="space-y-3">
                {fields.map(({ label, val, set }) => (
                  <label key={label} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-sb-muted flex-1">{label}</span>
                    <input type="number" min={0} value={val}
                      onChange={e => set(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-24 border border-sb-sep rounded-lg px-3 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-sb-blue" />
                  </label>
                ))}
                {title.includes('Direzione') && (
                  <label className="flex items-center justify-between gap-4">
                    <span className="text-sm text-sb-muted">Valutazione DS</span>
                    <select value={valDs} onChange={e => setValDs(e.target.value)}
                      className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue">
                      {['Ottima','Buona','Sufficiente','Insufficiente'].map(v => <option key={v}>{v}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          ))}
          <div className="md:col-span-2">
            <button onClick={saveIndicatori} disabled={saving}
              className="px-4 py-2 bg-sb-blue text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? '⏳ Salvataggio...' : '💾 Salva indicatori su Firebase'}
            </button>
          </div>
        </div>
      )}

      {dialogAtleta !== null && (
        <AtletaDialog
          atleta={dialogAtleta === 'new' ? null : dialogAtleta}
          onSave={saveAtleta}
          onClose={() => { setDialog(null); setEditId(null) }} />
      )}
    </div>
  )
}
