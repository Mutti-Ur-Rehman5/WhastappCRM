import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './components/ui/ProtectedRoute.jsx';
import PublicRoute from './components/ui/PublicRoute.jsx';
import AppLayout from './components/ui/AppLayout.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Inbox from './pages/Inbox.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Settings from './pages/Settings.jsx';

// Placeholder until Phase 2 is fully implemented
const ContactsPlaceholder = () => (
  <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm text-left">
    <h1 className="text-xl font-semibold text-neutral-950">Contacts List</h1>
    <p className="text-neutral-500 text-sm mt-1">Lead and customer database records will appear here in Phase 2.</p>
  </div>
);

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public auth pages */}
        <Route path="/login" element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        } />
        <Route path="/register" element={
          <PublicRoute>
            <Register />
          </PublicRoute>
        } />

        {/* Protected app space */}
        <Route path="/" element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }>
          <Route index element={<Dashboard />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="contacts" element={<ContactsPlaceholder />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
