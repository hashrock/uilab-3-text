import { HashRouter, Routes, Route, Link } from 'react-router-dom'
import { Home } from './Home'
import { LffDemo } from './LffDemo'

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav
        style={{
          display: 'flex',
          gap: 16,
          padding: '12px 24px',
          borderBottom: '1px solid #eee',
          fontFamily: 'sans-serif',
        }}
      >
        <Link to="/">LFF</Link>
        <Link to="/wavy">Wavy</Link>
      </nav>
      {children}
    </div>
  )
}

function App() {
  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<LffDemo />} />
          <Route path="/wavy" element={<Home />} />
        </Routes>
      </Layout>
    </HashRouter>
  )
}

export default App
