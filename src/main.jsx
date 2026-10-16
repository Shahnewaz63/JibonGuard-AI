import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AdminApp from './AdminApp.jsx';
import PricingPage from './PricingPage.jsx';
import './app.css';

const savedTheme = localStorage.getItem('jibonguard-theme-choice');
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';

const Root = location.pathname === '/admin' || location.pathname.startsWith('/admin/') ? AdminApp : location.pathname === '/pricing' ? PricingPage : App;
createRoot(document.getElementById('root')).render(<React.StrictMode><Root /></React.StrictMode>);
