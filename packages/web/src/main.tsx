import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DashboardShell } from './dashboard/DashboardShell.js';
import './styles.css';

// The redesigned dashboard is behind ?v2 while it's built mode-by-mode, so the
// current app keeps working until we cut over.
const useV2 = new URLSearchParams(window.location.search).has('v2');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{useV2 ? <DashboardShell /> : <App />}</StrictMode>,
);
