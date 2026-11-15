import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { NotFound } from './NotFound';
import { PatronApp } from './patron/PatronApp';
import { ScreenApp } from './screen/ScreenApp';

// Two screens, no router dependency (web.md 7).
function App() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/screen') return <ScreenApp />;
  if (path === '') return <PatronApp />;
  return <NotFound />;
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
