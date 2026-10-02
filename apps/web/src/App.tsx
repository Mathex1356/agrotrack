import { Route, Routes } from 'react-router';

export function App() {
  return (
    <Routes>
      <Route path="/" element={
        <main className="min-h-screen bg-slate-50 p-8 text-slate-900">
          <h1 className="text-3xl font-semibold">AgroTrack</h1>
        </main>
      } />
    </Routes>
  );
}
