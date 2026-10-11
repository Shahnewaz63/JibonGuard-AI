import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './app.css';

const savedTheme = localStorage.getItem('jibonguard-theme-choice');
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
