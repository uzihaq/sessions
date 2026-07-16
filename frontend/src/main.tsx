import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { bootstrapHostedConnection } from './lib/hostedBootstrap';
import './styles/globals.css';
import './styles/utilities.css';

bootstrapHostedConnection();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
