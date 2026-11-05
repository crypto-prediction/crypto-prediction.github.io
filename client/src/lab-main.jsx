import React from 'react';
import { createRoot } from 'react-dom/client';
import LabPage from './components/lab/LabPage.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LabPage />
  </React.StrictMode>,
);
