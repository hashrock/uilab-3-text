import { useState } from 'react'
import { WavyTextField } from './WavyTextField'
import './App.css'

function App() {
  const [text, setText] = useState('')

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        boxSizing: 'border-box',
      }}
    >
      <WavyTextField
        value={text}
        onChange={setText}
        placeholder="ここに入力…"
      />
    </div>
  )
}

export default App
