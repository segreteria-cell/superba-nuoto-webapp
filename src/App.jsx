import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Download      from './pages/Download'
import Estrazione    from './pages/Estrazione'
import Graduatorie   from './pages/Graduatorie'
import Regolamenti   from './pages/Regolamenti'
import Classifiche   from './pages/Classifiche'
import Qualifiche    from './pages/Qualifiche'
import GradPosizioni from './pages/GradPosizioni'
import Storico       from './pages/Storico'
import Dashboard     from './pages/Dashboard'
import Incentivante  from './pages/Incentivante'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/"               element={<Navigate to="/incentivante" replace />} />
        <Route path="/download"       element={<Download />} />
        <Route path="/estrazione"     element={<Estrazione />} />
        <Route path="/graduatorie"    element={<Graduatorie />} />
        <Route path="/regolamenti"    element={<Regolamenti />} />
        <Route path="/classifiche"    element={<Classifiche />} />
        <Route path="/qualifiche"     element={<Qualifiche />} />
        <Route path="/grad-posizioni" element={<GradPosizioni />} />
        <Route path="/storico"        element={<Storico />} />
        <Route path="/dashboard"      element={<Dashboard />} />
        <Route path="/incentivante"   element={<Incentivante />} />
      </Routes>
    </Layout>
  )
}
